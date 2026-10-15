"""Re-check existing tasks with the current rules (read-only).

Tasks created by an older rule version (or merged from many unrelated mails) are compared with what the
current rule engine finds in the same sources. Nothing is changed here: the result lists tasks the user may
want to dismiss (an undoable status change) - real data is never deleted automatically. Only the local rule
engine runs, never a cloud model.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload, sessionmaker

from taskradar.db.models import Document, Message, Task, TaskSource
from taskradar.db.session import transaction
from taskradar.domain.enums import ACTIVE_STATUSES
from taskradar.domain.schemas import CandidateTask
from taskradar.extraction.rules import RULES_VERSION, RuleBasedExtractor
from taskradar.policy.review import PolicyConfig, review_reasons
from taskradar.reconciliation.reconciler import Reconciler
from taskradar.services.ingest import IngestService
from taskradar.services.tasks import TaskService

# A source still "supports" a task when the current rules find a candidate this close to it (the same
# threshold that recognises a re-analysed item as the same task).
SUPPORT_THRESHOLD = 0.5
# Doubts of the current rules that are worth showing next to an old task.
_DOUBTS = {"title_incomplete", "low_confidence", "marketing_context"}
MAX_TASKS = 1000


class RecheckService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        ingest: IngestService,
        timezone: Callable[[], str],
    ) -> None:
        self._factory = session_factory
        self._ingest = ingest
        self._timezone = timezone

    def run(self, *, serialize: Callable[[Task], dict[str, Any]]) -> dict[str, Any]:
        tz = self._timezone()
        extractor = RuleBasedExtractor()
        reconciler = Reconciler()
        policy = PolicyConfig()
        cache: dict[str, list[CandidateTask]] = {}
        findings: list[dict[str, Any]] = []
        checked = 0
        with transaction(self._factory) as session:
            tasks = session.scalars(
                select(Task)
                .options(
                    selectinload(Task.sources).selectinload(TaskSource.message).selectinload(Message.source),
                    selectinload(Task.sources).selectinload(TaskSource.document).selectinload(Document.pages),
                    selectinload(Task.suggestions),
                    selectinload(Task.calendar_links),
                )
                .where(
                    Task.status.in_([s.value for s in ACTIVE_STATUSES]),
                    Task.manual.is_(False),
                    Task.sample.is_(False),
                )
                .order_by(Task.created_at)
                .limit(MAX_TASKS)
            ).all()
            for task in tasks:
                items = [ts for ts in task.sources if ts.message is not None or ts.document is not None]
                if not items:
                    continue  # nothing left to compare with (e.g. the mail was deleted)
                checked += 1
                snapshot = TaskService.snapshot(task)
                supporting = 0
                doubts: set[str] = set()
                versions: set[str] = set()
                for ts in items:
                    item = ts.message if ts.message is not None else ts.document
                    assert item is not None
                    versions.add(item.extractor_version or "unknown")
                    candidates = cache.get(ts.origin_key)
                    if candidates is None:
                        if ts.message is not None:
                            inp, _ = self._ingest.message_input(ts.message, tz)
                        else:
                            assert ts.document is not None
                            inp, _ = self._ingest.document_input(ts.document, tz)
                        candidates = extractor.extract(inp).tasks if inp.text.strip() else []
                        cache[ts.origin_key] = candidates
                    scored = [(reconciler.content_score(c, snapshot)[0], c) for c in candidates]
                    if not scored:
                        continue
                    score, best = max(scored, key=lambda pair: pair[0])
                    if score >= SUPPORT_THRESHOLD:
                        supporting += 1
                        doubts.update(r for r in review_reasons(best, policy) if r in _DOUBTS)
                if supporting == 0:
                    verdict = "not_found"
                elif len(items) >= 3 and supporting * 3 <= len(items):
                    verdict = "overmerged"
                elif doubts:
                    verdict = "doubtful"
                else:
                    continue
                findings.append(
                    {
                        "task": serialize(task),
                        "verdict": verdict,
                        "doubts": sorted(doubts),
                        "sources_total": len(items),
                        "sources_supporting": supporting,
                        "extracted_by": sorted(versions),
                    }
                )
        order = {"not_found": 0, "overmerged": 1, "doubtful": 2}
        findings.sort(key=lambda f: (order[f["verdict"]], f["task"]["created_at"] or ""))
        return {"rules_version": RULES_VERSION, "checked": checked, "items": findings}
