"""Local data management: export everything as JSON, delete a task, the mails and files imported by earlier
versions, or all data.

Deleting never touches the user's original files - only TaskRadar's own copies.
"""

from __future__ import annotations

import datetime as dt
import shutil
from collections.abc import Callable
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, sessionmaker

from taskradar import __version__
from taskradar.config import AppConfig
from taskradar.db.base import utcnow
from taskradar.db.calendar_models import CalendarDraft, CalendarSource, CalendarWindow, GoogleEvent, WorkBlock
from taskradar.db.models import (
    AuditLog,
    CalendarLink,
    Document,
    DocumentPage,
    ExtractionRun,
    Message,
    Notification,
    Source,
    SyncCheckpoint,
    SyncJob,
    Task,
    TaskCandidate,
    TaskEvent,
    TaskLink,
    TaskSource,
    TaskSuggestion,
    Timer,
)
from taskradar.db.session import transaction
from taskradar.services.tasks import TRASH_RETENTION


def _iso(value: Any) -> Any:
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return value


def _row(obj: Any, exclude: set[str] | None = None) -> dict[str, Any]:
    exclude = exclude or set()
    return {c.key: _iso(getattr(obj, c.key)) for c in obj.__table__.columns if c.key not in exclude}


class DataService:
    def __init__(
        self, session_factory: sessionmaker[Session], *, config: AppConfig, clock: Callable[[], dt.datetime] = utcnow
    ) -> None:
        self._factory = session_factory
        self.config = config
        self.clock = clock

    def export(self, *, include_content: bool = True) -> dict[str, Any]:
        content_fields = set() if include_content else {"body_text", "snippet", "text"}
        with transaction(self._factory) as session:
            return {
                "format": "taskradar-export",
                "version": 1,
                "app_version": __version__,
                "exported_at": self.clock().isoformat(),
                "includes_content": include_content,
                "tasks": [_row(t) for t in session.scalars(select(Task))],
                "task_sources": [_row(s) for s in session.scalars(select(TaskSource))],
                "task_events": [_row(e) for e in session.scalars(select(TaskEvent))],
                "task_suggestions": [_row(s) for s in session.scalars(select(TaskSuggestion))],
                "task_links": [_row(link) for link in session.scalars(select(TaskLink))],
                "sources": [_row(s) for s in session.scalars(select(Source))],
                "messages": [_row(m, content_fields) for m in session.scalars(select(Message))],
                "documents": [_row(d) for d in session.scalars(select(Document))],
                "document_pages": [_row(p, content_fields) for p in session.scalars(select(DocumentPage))],
                "calendar_links": [_row(c) for c in session.scalars(select(CalendarLink))],
                "work_blocks": [_row(b) for b in session.scalars(select(WorkBlock))],
                "calendar_drafts": [_row(d) for d in session.scalars(select(CalendarDraft))],
                "calendar_sources": [_row(s, {"sync_token"}) for s in session.scalars(select(CalendarSource))],
                "google_events": [_row(e) for e in session.scalars(select(GoogleEvent))],
                "sync_jobs": [_row(j) for j in session.scalars(select(SyncJob))],
                "timers": [_row(t) for t in session.scalars(select(Timer))],
            }

    def imported_counts(self) -> dict[str, int]:
        """Mails and files that earlier versions imported (kept until the user deletes them)."""
        with transaction(self._factory) as session:
            return {
                "messages": session.scalar(select(func.count()).select_from(Message)) or 0,
                "documents": session.scalar(select(func.count()).select_from(Document)) or 0,
            }

    def delete_imported(self) -> dict[str, int]:
        """Remove the imported mails and files with everything read from them (texts, pages, analysis runs,
        sync history) and TaskRadar's copies of the files. Tasks stay, with the quotes they were found by."""
        counts: dict[str, int] = {}
        with transaction(self._factory) as session:
            for model in (TaskCandidate, ExtractionRun, DocumentPage, Document, Message, SyncCheckpoint, SyncJob):
                result = session.execute(delete(model))
                counts[model.__tablename__] = int(getattr(result, "rowcount", 0) or 0)
            result = session.execute(delete(Source))
            counts["sources"] = int(getattr(result, "rowcount", 0) or 0)
        self._remove_copies()
        return counts

    def _remove_copies(self) -> None:
        if self.config.files_dir.exists():
            shutil.rmtree(self.config.files_dir, ignore_errors=True)

    def purge_expired_tasks(self) -> int:
        """Expiry is based on UTC elapsed time, including time spent with the app closed."""
        with transaction(self._factory) as session:
            result = session.execute(delete(Task).where(Task.deleted_at <= self.clock() - TRASH_RETENTION))
            return int(getattr(result, "rowcount", 0) or 0)

    def delete_all(self) -> dict[str, int]:
        """Remove all tasks, timers, imported items, history and stored file copies.

        Settings and credentials stay; Google Calendar can be disconnected separately.
        """
        counts: dict[str, int] = {}
        with transaction(self._factory) as session:
            for model in (
                CalendarDraft,
                WorkBlock,
                CalendarWindow,
                GoogleEvent,
                CalendarSource,
                Timer,
                Notification,
                CalendarLink,
                TaskSuggestion,
                TaskLink,
                TaskEvent,
                TaskSource,
                TaskCandidate,
                ExtractionRun,
                Task,
                DocumentPage,
                Document,
                Message,
                SyncCheckpoint,
                SyncJob,
                AuditLog,
            ):
                result = session.execute(delete(model))
                counts[model.__tablename__] = int(getattr(result, "rowcount", 0) or 0)
            result = session.execute(delete(Source))
            counts["sources"] = int(getattr(result, "rowcount", 0) or 0)
        self._remove_copies()
        return counts
