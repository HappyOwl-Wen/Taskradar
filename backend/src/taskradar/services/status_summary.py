"""Runtime problems as a short, plain-language status summary.

The UI shows these items instead of job logs: each one says what is wrong (a code the UI translates),
how many things are affected, since when, and what the user can do. Nothing here changes data.
"""

from __future__ import annotations

import datetime as dt
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.db.base import utcnow
from taskradar.db.models import CalendarLink, Document, ExtractionRun, Message, Source, SyncJob, Task
from taskradar.db.session import transaction
from taskradar.domain.enums import SAMPLE_SOURCE_KINDS, JobKind, SourceKind

Level = Literal["error", "warning", "info"]
_LEVEL_ORDER = {"error": 0, "warning": 1, "info": 2}


@dataclass
class StatusItem:
    code: str
    level: Level
    area: str
    params: dict[str, Any] = field(default_factory=dict)
    since: str | None = None
    action: str | None = None  # where the user can fix it: "gmail_settings", "sources", "records", "ai_settings", ...

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "level": self.level,
            "area": self.area,
            "params": self.params,
            "since": self.since,
            "action": self.action,
        }


def _iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _aware(value: dt.datetime | None) -> dt.datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=dt.UTC)


class StatusSummaryService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        gmail_connected: Callable[[], bool],
        gmail_auto_sync: Callable[[], tuple[bool, int]],
        ocr_available: Callable[[], bool],
        ocr_backlog: Callable[[], int],
        llm_configured: Callable[[], tuple[bool, bool]],
        clock: Callable[[], dt.datetime] = utcnow,
    ) -> None:
        self._factory = session_factory
        self._gmail_connected = gmail_connected
        self._gmail_auto_sync = gmail_auto_sync
        self._ocr_available = ocr_available
        self._ocr_backlog = ocr_backlog
        self._llm_configured = llm_configured
        self.clock = clock

    def summary(self, *, scheduler_running: bool) -> dict[str, Any]:
        now = self.clock()
        items: list[StatusItem] = []
        with transaction(self._factory) as session:
            items += self._gmail(session, now)
            items += self._folders(session)
            items += self._failed_items(session, now)
            items += self._calendar(session)
            items += self._reminders(session, now)
            items += self._llm(session, now)
        if not scheduler_running:
            items.append(StatusItem("scheduler_off", "warning", "system"))
        if not self._ocr_available():
            items.append(StatusItem("ocr_missing", "info", "ocr", action="ocr_help"))
        elif backlog := self._ocr_backlog():
            items.append(StatusItem("ocr_backlog", "info", "ocr", {"count": backlog}, action="sources"))
        items.sort(key=lambda i: _LEVEL_ORDER[i.level])
        levels = {i.level for i in items}
        overall = "problem" if "error" in levels else "attention" if "warning" in levels else "ok"
        return {"overall": overall, "checked_at": now.isoformat(), "items": [i.to_dict() for i in items]}

    # ------------------------------------------------------------------------------------------

    def _gmail(self, session: Session, now: dt.datetime) -> list[StatusItem]:
        source = session.scalars(
            select(Source).where(Source.kind == SourceKind.GMAIL.value).order_by(Source.id)
        ).first()
        if source is None:
            return []
        if not self._gmail_connected() or source.status == "auth_required":
            return [
                StatusItem(
                    "gmail_auth_required", "error", "gmail", since=_iso(source.last_sync_at), action="gmail_settings"
                )
            ]
        items: list[StatusItem] = []
        last_job = session.scalars(
            select(SyncJob)
            .where(
                SyncJob.source_id == source.id, SyncJob.kind == JobKind.GMAIL_SYNC.value, SyncJob.status != "running"
            )
            .order_by(SyncJob.started_at.desc())
        ).first()
        if source.status == "error" or (last_job is not None and last_job.status == "failed"):
            code = (last_job.error_code if last_job is not None else None) or source.last_error_code or "unknown"
            items.append(
                StatusItem(
                    "gmail_sync_failing",
                    "warning",
                    "gmail",
                    {"error": code, "retry_at": _iso(last_job.next_retry_at) if last_job else None},
                    since=_iso(source.last_success_at),
                    action="sources",
                )
            )
        elif last_job is not None and last_job.status == "partial" and last_job.items_failed:
            codes = (last_job.details or {}).get("failed_codes") or {}
            items.append(
                StatusItem(
                    "gmail_items_failed",
                    "warning",
                    "gmail",
                    {"count": last_job.items_failed, "codes": codes},
                    since=_iso(last_job.started_at),
                    action="records",
                )
            )
        auto, interval = self._gmail_auto_sync()
        last_success = _aware(source.last_success_at)
        stale_after = dt.timedelta(minutes=max(120, 3 * interval))
        if auto and last_success is not None and now - last_success > stale_after and not items:
            items.append(
                StatusItem("gmail_stale", "warning", "gmail", since=_iso(source.last_success_at), action="sources")
            )
        return items

    def _folders(self, session: Session) -> list[StatusItem]:
        return [
            StatusItem(
                "folder_unavailable",
                "warning",
                "folders",
                {"name": f.name or f.folder_path or "", "error": f.last_error_code or "unknown"},
                since=_iso(f.last_sync_at),
                action="sources",
            )
            for f in session.scalars(
                select(Source).where(Source.kind == SourceKind.FOLDER.value, Source.status == "error", Source.enabled)
            )
        ]

    def _failed_items(self, session: Session, now: dt.datetime) -> list[StatusItem]:
        """Mails and files of the last 30 days that could not be read (test data left out)."""
        cutoff = now - dt.timedelta(days=30)
        real = select(Source.id).where(Source.kind.not_in(SAMPLE_SOURCE_KINDS))
        codes: Counter[str] = Counter()
        for code in session.scalars(
            select(Document.error_code).where(
                Document.status == "failed", Document.source_id.in_(real), Document.imported_at >= cutoff
            )
        ):
            codes[code or "unknown"] += 1
        for code in session.scalars(
            select(Message.error_code).where(
                Message.status == "failed", Message.source_id.in_(real), Message.created_at >= cutoff
            )
        ):
            codes[code or "unknown"] += 1
        if not codes:
            return []
        return [
            StatusItem(
                "items_failed",
                "warning",
                "processing",
                {"count": sum(codes.values()), "codes": dict(codes)},
                action="records",
            )
        ]

    def _calendar(self, session: Session) -> list[StatusItem]:
        counts = dict(
            session.execute(
                select(CalendarLink.status, func.count())
                .join(Task, Task.id == CalendarLink.task_id)
                .where(
                    CalendarLink.status.in_(("failed", "out_of_sync")), Task.status.not_in(("completed", "dismissed"))
                )
                .group_by(CalendarLink.status)
            ).all()
        )
        items: list[StatusItem] = []
        if counts.get("failed"):
            items.append(
                StatusItem("calendar_failed", "warning", "calendar", {"count": counts["failed"]}, action="tasks")
            )
        if counts.get("out_of_sync"):
            items.append(
                StatusItem("calendar_out_of_sync", "info", "calendar", {"count": counts["out_of_sync"]}, action="tasks")
            )
        return items

    def _reminders(self, session: Session, now: dt.datetime) -> list[StatusItem]:
        last = session.scalars(
            select(SyncJob)
            .where(SyncJob.kind == JobKind.REMINDER_SCAN.value, SyncJob.status != "running")
            .order_by(SyncJob.started_at.desc())
        ).first()
        if last is not None and last.status == "failed":
            return [
                StatusItem(
                    "reminders_failing",
                    "warning",
                    "reminders",
                    {"error": last.error_code or "unknown"},
                    since=_iso(last.started_at),
                )
            ]
        return []

    def _llm(self, session: Session, now: dt.datetime) -> list[StatusItem]:
        enabled, has_key = self._llm_configured()
        items: list[StatusItem] = []
        if enabled and not has_key:
            items.append(StatusItem("llm_key_missing", "warning", "ai", action="ai_settings"))
        fallbacks = (
            session.scalar(
                select(func.count())
                .select_from(ExtractionRun)
                .where(ExtractionRun.status == "fallback", ExtractionRun.created_at >= now - dt.timedelta(days=1))
            )
            or 0
        )
        if fallbacks:
            items.append(StatusItem("llm_fallbacks", "warning", "ai", {"count": fallbacks}, action="ai_settings"))
        return items
