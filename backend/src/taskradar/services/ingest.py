"""Ingestion orchestration: normalized item -> extraction -> reconciliation -> policy -> tasks.

Extraction (possibly a slow model call) runs outside any write transaction. Reconciliation and
the resulting changes are applied atomically in one transaction while holding a process-wide
lock, so concurrent syncs can never create the same task twice.
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.db.base import utcnow
from taskradar.db.models import Document, ExtractionRun, Message, Task, TaskCandidate, TaskSource
from taskradar.db.session import transaction
from taskradar.domain.enums import (
    Actor,
    ItemStatus,
    MatchRelation,
    SourceRelation,
    SuggestionKind,
    TaskStatus,
)
from taskradar.domain.schemas import (
    CandidateTask,
    CompletionSignal,
    ExtractionInput,
    ExtractionResult,
    MatchDecision,
    TextSegment,
)
from taskradar.policy.review import (
    CompletionAction,
    PolicyConfig,
    completion_action,
    deadline_update_should_apply,
    review_reasons,
)
from taskradar.services.agent import AgentFactory
from taskradar.services.settings import SettingsService
from taskradar.services.tasks import Origin, TaskService

log = logging.getLogger(__name__)

INGEST_LOCK = threading.RLock()


@dataclass
class IngestOutcome:
    tasks_created: int = 0
    tasks_updated: int = 0
    duplicates_merged: int = 0
    suggestions_created: int = 0
    completions_applied: int = 0
    unchanged: int = 0
    skipped: bool = False
    skip_reason: str | None = None
    content_type: str | None = None
    extractor: str | None = None
    run_id: int | None = None
    created_task_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass
class PreparedExtraction:
    inp: ExtractionInput
    origin: Origin
    result: ExtractionResult
    elapsed_ms: int
    message_id: int | None = None
    document_id: int | None = None


class IngestService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        settings: SettingsService,
        agent: AgentFactory,
        tasks: TaskService,
        clock: Callable[[], dt.datetime] = utcnow,
    ) -> None:
        self._factory = session_factory
        self.settings = settings
        self.agent = agent
        self.tasks = tasks
        self.clock = clock

    # ------------------------------------------------------------------------------------------
    # Input construction
    # ------------------------------------------------------------------------------------------

    def message_input(self, msg: Message, tz: str) -> tuple[ExtractionInput, Origin]:
        subject = (msg.subject or "").strip()
        body = msg.body_text or ""
        text = f"{subject}\n\n{body}" if subject else body
        segments = [TextSegment(text=subject, page=None, offset=0)] if subject else []
        segments.append(TextSegment(text=body, page=None, offset=len(subject) + 2 if subject else 0))
        inp = ExtractionInput(
            origin_kind="message",
            origin_id=msg.id,
            title=subject or None,
            text=text,
            segments=segments,
            sender=msg.sender,
            sent_at=msg.sent_at,
            received_at=msg.created_at,
            labels=list(msg.labels or []),
            is_bulk=msg.is_bulk,
            thread_id=msg.thread_id,
            timezone=tz,
        )
        origin = Origin(
            key=f"message:{msg.id}",
            message_id=msg.id,
            thread_id=msg.thread_id,
            label=subject or msg.sender or "(no subject)",
            date=msg.sent_at or msg.created_at,
        )
        return inp, origin

    def document_input(self, doc: Document, tz: str) -> tuple[ExtractionInput, Origin]:
        parts: list[str] = []
        segments: list[TextSegment] = []
        ocr_conf: dict[int, float] = {}
        offset = 0
        for page in doc.pages:
            if not page.text.strip():
                continue
            if parts:
                offset += 2
            segments.append(TextSegment(text=page.text, page=page.page_no, offset=offset))
            parts.append(page.text)
            offset += len(page.text)
            if page.ocr_confidence is not None:
                ocr_conf[page.page_no] = page.ocr_confidence
        text = "\n\n".join(parts)
        parent = doc.message
        sent_at = parent.sent_at if parent is not None else None
        inp = ExtractionInput(
            origin_kind="document",
            origin_id=doc.id,
            title=doc.original_name,
            text=text,
            segments=segments,
            sender=parent.sender if parent is not None else None,
            sent_at=sent_at,
            doc_date=doc.doc_date,
            received_at=doc.imported_at,
            language=doc.language,
            thread_id=parent.thread_id if parent is not None else None,
            timezone=tz,
            ocr_confidence=ocr_conf,
        )
        date = sent_at
        if date is None and doc.doc_date is not None:
            date = dt.datetime.combine(doc.doc_date, dt.time(0), tzinfo=ZoneInfo(tz)).astimezone(dt.UTC)
        origin = Origin(
            key=f"document:{doc.id}",
            document_id=doc.id,
            message_id=doc.message_id,
            thread_id=parent.thread_id if parent is not None else None,
            label=doc.original_name,
            date=date or doc.imported_at,
        )
        return inp, origin

    # ------------------------------------------------------------------------------------------
    # Entry points
    # ------------------------------------------------------------------------------------------

    def process_message(self, message_id: int, *, force: bool = False) -> IngestOutcome:
        tz = self.settings.get().general.timezone
        with transaction(self._factory) as session:
            msg = session.get(Message, message_id)
            if msg is None:
                raise LookupError(f"message {message_id} not found")
            if msg.status in (ItemStatus.PROCESSED.value, ItemStatus.SKIPPED.value) and not force:
                return IngestOutcome(skipped=True, skip_reason="already_processed")
            inp, origin = self.message_input(msg, tz)
        prepared = self._extract(inp, origin, message_id=message_id)
        with INGEST_LOCK, transaction(self._factory) as session:
            outcome = self.apply(session, prepared)
            msg = session.get(Message, message_id)
            assert msg is not None
            msg.status = ItemStatus.PROCESSED.value
            msg.processed_at = self.clock()
            msg.extractor_version = (prepared.result.extractor or "")[:64]
            msg.error_code = None
            msg.error_message = None
        return outcome

    def process_document(self, document_id: int) -> IngestOutcome:
        tz = self.settings.get().general.timezone
        with transaction(self._factory) as session:
            doc = session.get(Document, document_id)
            if doc is None:
                raise LookupError(f"document {document_id} not found")
            inp, origin = self.document_input(doc, tz)
        if not inp.text.strip():
            return IngestOutcome(skipped=True, skip_reason="no_text")
        prepared = self._extract(inp, origin, document_id=document_id)
        with INGEST_LOCK, transaction(self._factory) as session:
            outcome = self.apply(session, prepared)
            doc = session.get(Document, document_id)
            assert doc is not None
            doc.extractor_version = (prepared.result.extractor or "")[:64]
        return outcome

    def _extract(
        self, inp: ExtractionInput, origin: Origin, *, message_id: int | None = None, document_id: int | None = None
    ) -> PreparedExtraction:
        extractor = self.agent.extractor()
        started = time.perf_counter()
        result = extractor.extract(inp)
        elapsed = int((time.perf_counter() - started) * 1000)
        return PreparedExtraction(inp, origin, result, elapsed, message_id=message_id, document_id=document_id)

    # ------------------------------------------------------------------------------------------
    # Apply
    # ------------------------------------------------------------------------------------------

    def apply(self, session: Session, prepared: PreparedExtraction) -> IngestOutcome:
        settings = self.settings.get()
        policy = PolicyConfig(**settings.policy.model_dump())
        result = prepared.result
        usage = result.usage
        redactions = 0
        for step in result.trace:
            if step.get("step") == "llm.prepare":
                redactions = int(step.get("redactions", 0) or 0)  # type: ignore[call-overload]
        run = ExtractionRun(
            message_id=prepared.message_id,
            document_id=prepared.document_id,
            extractor=result.extractor[:64],
            provider=usage.provider if usage else None,
            model=usage.model if usage else None,
            prompt_version=result.extractor.split(":")[-1][:32] if usage else None,
            status="fallback" if "(fallback)" in result.extractor else "succeeded",
            content_type=result.content_type.value,
            attempts=usage.attempts if usage else 1,
            input_chars=len(prepared.inp.text),
            redactions=redactions,
            input_tokens=usage.input_tokens if usage else None,
            output_tokens=usage.output_tokens if usage else None,
            cost_usd=usage.cost_usd if usage else None,
            latency_ms=prepared.elapsed_ms,
            candidates_count=len(result.tasks) + len(result.completion_signals),
            error=next((n for n in result.notes if n.startswith("llm_fallback")), None),
            trace=[dict(step) for step in result.trace],
            created_at=self.clock(),
        )
        session.add(run)
        session.flush()

        outcome = IngestOutcome(content_type=result.content_type.value, extractor=result.extractor, run_id=run.id)
        reconciler = self.agent.reconciler(session)
        existing = self.tasks.load_snapshots(session)
        origin = prepared.origin

        for cand in result.tasks:
            row = self._candidate_row(session, run, prepared, cand)
            decision = reconciler.match_task(
                cand, origin_key=origin.key, thread_id=origin.thread_id, source_date=origin.date, existing=existing
            )
            self._record_decision(row, decision)
            self._apply_task_decision(session, cand, row, decision, origin, policy, settings.general.timezone,
                                      existing, outcome)

        for signal in result.completion_signals:
            row = self._signal_row(session, run, prepared, signal)
            decision = reconciler.match_completion(signal, thread_id=origin.thread_id, existing=existing)
            self._record_decision(row, decision)
            self._apply_completion(session, signal, row, decision, origin, policy, outcome)
            existing[:] = self.tasks.load_snapshots(session)
        return outcome

    # ------------------------------------------------------------------------------------------

    def _candidate_row(self, session: Session, run: ExtractionRun, prepared: PreparedExtraction,
                       cand: CandidateTask) -> TaskCandidate:
        row = TaskCandidate(
            run_id=run.id,
            message_id=prepared.message_id,
            document_id=prepared.document_id,
            kind="task",
            title=cand.title[:200],
            description=cand.description,
            category=cand.category.value,
            action_type=cand.action_type.value,
            action_required=cand.action_required,
            due=cand.due.model_dump(mode="json"),
            priority=cand.priority.value,
            confidence=cand.confidence,
            evidence=[e.model_dump(mode="json") for e in cand.evidence],
            entities=list(cand.entities),
            uncertainties=list(cand.uncertainties),
            relation_hint=cand.relation_hint.value,
            created_at=self.clock(),
        )
        session.add(row)
        session.flush()
        return row

    def _signal_row(self, session: Session, run: ExtractionRun, prepared: PreparedExtraction,
                    signal: CompletionSignal) -> TaskCandidate:
        row = TaskCandidate(
            run_id=run.id,
            message_id=prepared.message_id,
            document_id=prepared.document_id,
            kind="completion_signal",
            title=signal.subject[:200],
            description=f"{signal.kind.value}; explicit={signal.explicit}",
            action_type=signal.action_type.value,
            confidence=signal.confidence,
            evidence=[signal.evidence.model_dump(mode="json")],
            entities=list(signal.entities),
            relation_hint="completion",
            created_at=self.clock(),
        )
        session.add(row)
        session.flush()
        return row

    @staticmethod
    def _record_decision(row: TaskCandidate, decision: MatchDecision) -> None:
        row.decision = decision.relation.value
        row.decision_layer = decision.layer
        row.decision_score = decision.score
        row.decision_reasons = decision.reasons[:20]

    def _refresh(self, session: Session, existing: list, task: Task) -> None:  # type: ignore[type-arg]
        session.flush()
        session.refresh(task)
        snap = self.tasks.snapshot(task)
        for i, s in enumerate(existing):
            if s.id == task.id:
                existing[i] = snap
                return
        existing.append(snap)

    def _apply_task_decision(
        self,
        session: Session,
        cand: CandidateTask,
        row: TaskCandidate,
        decision: MatchDecision,
        origin: Origin,
        policy: PolicyConfig,
        timezone: str,
        existing: list,  # type: ignore[type-arg]
        outcome: IngestOutcome,
    ) -> None:
        relation = decision.relation
        if relation == MatchRelation.SAME_ORIGIN:
            row.task_id = decision.task_id
            outcome.unchanged += 1
            return

        if relation in (MatchRelation.DUPLICATE, MatchRelation.DEADLINE_UPDATE) and decision.task_id:
            task = self.tasks.get(session, decision.task_id)
            if relation == MatchRelation.DUPLICATE:
                self.tasks.attach_source(
                    session, task, origin=origin, candidate_row=row, relation=SourceRelation.DUPLICATE,
                    evidence=cand.evidence, summary=f"识别为重复通知并合并：「{origin.label}」",
                )
                outcome.duplicates_merged += 1
                self._enrich_due(session, task, cand, origin)
            else:
                self.tasks.attach_source(
                    session, task, origin=origin, candidate_row=row, relation=SourceRelation.DEADLINE_UPDATE,
                    evidence=cand.evidence, summary=f"新来源「{origin.label}」提到了不同的截止日期",
                )
                new_date = cand.due.date.isoformat() if cand.due.date else None
                new_time = cand.due.time.strftime("%H:%M") if cand.due.time else None
                if deadline_update_should_apply(cand, list(task.user_locked_fields or []), policy):
                    event = self.tasks.update_fields(
                        session, task, {"due_date": new_date, "due_time": new_time}, actor=Actor.AGENT,
                        reason="explicit_deadline_change", due_text=cand.due.text,
                        summary=f"根据「{origin.label}」将截止日期更新为 {new_date}{' ' + new_time if new_time else ''}（可撤销）",
                    )
                    if event is not None:
                        outcome.tasks_updated += 1
                else:
                    created = self.tasks.suggest(
                        session, task, kind=SuggestionKind.UPDATE_DUE,
                        payload={"due_date": new_date, "due_time": new_time, "due_text": cand.due.text,
                                 "previous_due_date": task.due_date.isoformat() if task.due_date else None},
                        evidence=cand.evidence, confidence=cand.confidence,
                        reason="; ".join(decision.reasons),
                        dedupe_key=f"{task.id}:update_due:{origin.key}:{new_date}:{new_time}",
                        candidate_row=row, summary=f"建议更新截止日期为 {new_date}",
                    )
                    if created is not None:
                        outcome.suggestions_created += 1
            self._refresh(session, existing, task)
            return

        review = review_reasons(cand, policy)
        if relation == MatchRelation.POSSIBLE_DUPLICATE:
            review = [*review, "possible_duplicate"]
        task = self.tasks.create_from_candidate(
            session, cand, origin=origin, candidate_row=row, timezone=timezone, review_reasons=review,
        )
        outcome.tasks_created += 1
        outcome.created_task_ids.append(task.id)
        if relation == MatchRelation.POSSIBLE_DUPLICATE and decision.task_id:
            other = self.tasks.get(session, decision.task_id)
            created = self.tasks.suggest(
                session, task, kind=SuggestionKind.POSSIBLE_DUPLICATE,
                payload={"other_task_id": other.id, "other_title": other.title, "score": decision.score},
                evidence=cand.evidence, confidence=decision.score, reason="; ".join(decision.reasons),
                dedupe_key=f"{task.id}:possible_duplicate:{other.id}", candidate_row=row,
                related_task_id=other.id, summary=f"可能与任务「{other.title}」重复",
            )
            if created is not None:
                outcome.suggestions_created += 1
        elif relation == MatchRelation.RELATED and decision.task_id:
            other = self.tasks.get(session, decision.task_id)
            self.tasks.link_tasks(session, task, other)
        self._refresh(session, existing, task)

    def _enrich_due(self, session: Session, task: Task, cand: CandidateTask, origin: Origin) -> None:
        """A duplicate notice may add information the original lacked (a date or a time)."""
        if "due" in (task.user_locked_fields or []) or cand.due.date is None:
            return
        if task.due_date is None:
            self.tasks.update_fields(
                session, task,
                {"due_date": cand.due.date.isoformat(),
                 "due_time": cand.due.time.strftime("%H:%M") if cand.due.time else None},
                actor=Actor.AGENT, reason="enriched_from_duplicate", due_text=cand.due.text,
                summary=f"根据「{origin.label}」补充截止日期（可撤销）",
            )
            task.due_needs_confirmation = cand.due.needs_confirmation
        elif task.due_date == cand.due.date and task.due_time is None and cand.due.time is not None:
            self.tasks.update_fields(
                session, task, {"due_time": cand.due.time.strftime("%H:%M")}, actor=Actor.AGENT,
                reason="enriched_from_duplicate", summary=f"根据「{origin.label}」补充具体时间（可撤销）",
            )

    def _apply_completion(
        self,
        session: Session,
        signal: CompletionSignal,
        row: TaskCandidate,
        decision: MatchDecision,
        origin: Origin,
        policy: PolicyConfig,
        outcome: IngestOutcome,
    ) -> None:
        if decision.relation != MatchRelation.DUPLICATE or not decision.task_id:
            row.decision = "unmatched"
            return
        task = self.tasks.get(session, decision.task_id)
        attached = self.tasks.attach_source(
            session, task, origin=origin, candidate_row=row, relation=SourceRelation.COMPLETION_EVIDENCE,
            evidence=[signal.evidence],
            summary=f"「{origin.label}」包含{'明确' if signal.explicit else '不确定'}的完成/回执信息",
            revertible=False,
        )
        if attached is None:
            outcome.unchanged += 1
            return
        action = completion_action(signal, task.status, policy)
        if action == CompletionAction.AUTO_COMPLETE:
            self.tasks.change_status(
                session, task, TaskStatus.COMPLETED, actor=Actor.AGENT,
                reason=f"explicit_completion_evidence:{signal.kind.value}",
                summary=f"根据「{origin.label}」中的明确确认自动标记为已完成（可撤销）",
                extra_data={"evidence": signal.evidence.quote[:300]},
            )
            outcome.completions_applied += 1
            return
        kind = {
            CompletionAction.SUGGEST_COMPLETE: SuggestionKind.MARK_COMPLETED,
            CompletionAction.SUGGEST_DISMISS: SuggestionKind.MARK_DISMISSED,
            CompletionAction.SUGGEST_WAITING: SuggestionKind.MARK_WAITING,
        }.get(action)
        if kind is None:
            return
        summary = {
            SuggestionKind.MARK_COMPLETED: "可能已完成，等待你确认",
            SuggestionKind.MARK_DISMISSED: "相关事项可能已取消",
            SuggestionKind.MARK_WAITING: "对方正在处理，可标记为等待回复",
        }[kind]
        created = self.tasks.suggest(
            session, task, kind=kind,
            payload={"signal_kind": signal.kind.value, "explicit": signal.explicit},
            evidence=[signal.evidence], confidence=signal.confidence,
            reason="; ".join(decision.reasons), dedupe_key=f"{task.id}:{kind.value}:{origin.key}",
            candidate_row=row, summary=summary,
        )
        if created is not None:
            outcome.suggestions_created += 1


def tasks_for_origin(session: Session, origin_key: str) -> list[Task]:
    return list(
        session.scalars(select(Task).join(TaskSource).where(TaskSource.origin_key == origin_key).distinct())
    )
