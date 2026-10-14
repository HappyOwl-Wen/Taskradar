"""Local data management: export everything as JSON, delete single items or all data.

Deleting never touches original files in watched folders - only TaskRadar's own copies.
"""

from __future__ import annotations

import datetime as dt
import logging
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from taskradar import __version__
from taskradar.config import AppConfig
from taskradar.db.base import utcnow
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
)
from taskradar.db.session import transaction
from taskradar.domain.enums import SourceKind

log = logging.getLogger(__name__)


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
                "sync_jobs": [_row(j) for j in session.scalars(select(SyncJob))],
            }

    def _remove_owned_file(self, stored_path: str | None) -> None:
        if not stored_path:
            return
        path = Path(stored_path)
        try:
            if path.resolve().is_relative_to(self.config.files_dir.resolve()) and path.is_file():
                path.unlink()
        except OSError:
            log.warning("Could not delete stored copy %s", path.name)

    def delete_document(self, document_id: int) -> None:
        with transaction(self._factory) as session:
            doc = session.get(Document, document_id)
            if doc is None:
                raise LookupError("Document not found")
            stored = doc.stored_path
            still_used = (
                session.scalar(select(Document.id).where(Document.stored_path == stored, Document.id != document_id))
                if stored
                else None
            )
            session.delete(doc)
        if stored and still_used is None:
            self._remove_owned_file(stored)

    def delete_message(self, message_id: int) -> None:
        with transaction(self._factory) as session:
            msg = session.get(Message, message_id)
            if msg is None:
                raise LookupError("Message not found")
            stored = [d.stored_path for d in msg.attachments]
            session.delete(msg)
        for path in stored:
            self._remove_owned_file(path)

    def delete_task(self, task_id: str) -> None:
        with transaction(self._factory) as session:
            task = session.get(Task, task_id)
            if task is None:
                raise LookupError("Task not found")
            session.delete(task)

    def delete_all(self) -> dict[str, int]:
        """Remove all tasks, imported items, history and stored file copies. Settings stay."""
        counts: dict[str, int] = {}
        with transaction(self._factory) as session:
            for model in (
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
            # Keep folder/Gmail source definitions? No - the user asked for a clean slate.
            result = session.execute(delete(Source).where(Source.kind != SourceKind.FOLDER.value))
            counts["sources"] = int(getattr(result, "rowcount", 0) or 0)
        for folder in (self.config.uploads_dir, self.config.attachments_dir):
            if folder.exists():
                shutil.rmtree(folder, ignore_errors=True)
            folder.mkdir(parents=True, exist_ok=True)
        return counts
