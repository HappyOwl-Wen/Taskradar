"""Watched folders: explicit, user-chosen folders scanned incrementally (read-only).

Change detection: (mtime, size) first, then SHA-256. Symlinks / junctions that point outside the
folder, hidden and temporary files, and files still being written are skipped.
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.db.base import utcnow
from taskradar.db.models import Document, Source
from taskradar.db.session import transaction
from taskradar.domain.enums import ItemStatus, JobKind, JobStatus, JobTrigger, SourceKind
from taskradar.parsing.filetypes import UnsupportedFileError, sanitize_filename, sha256_file, sniff_bytes
from taskradar.security.permissions import PermissionGuard, SideEffect
from taskradar.services.documents import DocumentService
from taskradar.services.jobs import JobContext, JobRunner
from taskradar.services.settings import SettingsService

log = logging.getLogger(__name__)

WATCHED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}
_TEMP_PREFIXES = ("~$", ".~", ".")
_TEMP_SUFFIXES = (".tmp", ".part", ".crdownload", ".download", ".partial")
MIN_FILE_AGE_SECONDS = 3.0
MAX_FILES_PER_SCAN = 500


class FolderService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        settings: SettingsService,
        documents: DocumentService,
        guard: PermissionGuard,
        jobs: JobRunner,
        clock: Callable[[], dt.datetime] = utcnow,
    ) -> None:
        self._factory = session_factory
        self.settings = settings
        self.documents = documents
        self.guard = guard
        self.jobs = jobs
        self.clock = clock

    def add_folder(self, raw_path: str, *, recursive: bool = False) -> Source:
        from taskradar.security.permissions import validate_watch_folder

        self.guard.check(SideEffect.FOLDER_WATCH, target=raw_path)
        resolved = validate_watch_folder(raw_path, app_data_dir=self.documents.config.data_dir)
        with transaction(self._factory) as session:
            existing = session.scalar(select(Source).where(Source.folder_path == str(resolved)))
            if existing is not None:
                return existing
            source = Source(kind=SourceKind.FOLDER.value, name=resolved.name or str(resolved), folder_path=str(resolved),
                            recursive=recursive, status="idle")
            session.add(source)
            session.flush()
            return source

    def remove_folder(self, source_id: int) -> None:
        """Stop watching. Tasks and their evidence stay; original files are untouched."""
        with transaction(self._factory) as session:
            source = session.get(Source, source_id)
            if source is None or source.kind != SourceKind.FOLDER.value:
                raise LookupError("Watched folder not found")
            session.delete(source)

    def scan_all(self, trigger: JobTrigger = JobTrigger.SCHEDULED) -> list[dict[str, Any]]:
        with transaction(self._factory) as session:
            ids = [s.id for s in session.scalars(
                select(Source).where(Source.kind == SourceKind.FOLDER.value, Source.enabled.is_(True))
            )]
        results = []
        for source_id in ids:
            results.append(self.scan(source_id, trigger=trigger))
        return results

    def scan(self, source_id: int, *, trigger: JobTrigger = JobTrigger.MANUAL, attempt: int = 1) -> dict[str, Any]:
        return self.jobs.run(
            JobKind.FOLDER_SCAN, lock_key=f"folder:{source_id}", source_id=source_id, trigger=trigger, attempt=attempt,
            fn=lambda ctx: self._scan(ctx, source_id),
        )

    # ------------------------------------------------------------------------------------------

    def _iter_files(self, root: Path, recursive: bool) -> list[Path]:
        candidates = root.rglob("*") if recursive else root.iterdir()
        files: list[Path] = []
        for path in candidates:
            name = path.name
            if name.startswith(_TEMP_PREFIXES) or name.lower().endswith(_TEMP_SUFFIXES):
                continue
            if path.suffix.lower() not in WATCHED_EXTENSIONS:
                continue
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                if not path.resolve().is_relative_to(root):
                    continue  # junctions / links leaving the watched folder
            except OSError:
                continue
            files.append(path)
            if len(files) >= MAX_FILES_PER_SCAN:
                break
        return sorted(files)

    def _scan(self, ctx: JobContext, source_id: int) -> JobStatus:
        with transaction(self._factory) as session:
            source = session.get(Source, source_id)
            if source is None:
                raise LookupError("Watched folder not found")
            root = Path(source.folder_path or "")
            recursive = source.recursive
        if not root.is_dir():
            self._set_source_status(source_id, "error", "folder_missing", "The folder no longer exists")
            ctx.details["error"] = "folder_missing"
            return JobStatus.FAILED
        max_bytes = self.settings.get().folders.max_file_mb * 1024 * 1024
        failures = 0
        now = time.time()
        for path in self._iter_files(root.resolve(), recursive):
            ctx.bump("items_seen")
            try:
                stat = path.stat()
            except OSError:
                ctx.bump("items_failed")
                continue
            if now - stat.st_mtime < MIN_FILE_AGE_SECONDS:
                ctx.bump("items_skipped")  # still being written; picked up next scan
                continue
            if stat.st_size == 0 or stat.st_size > max_bytes:
                ctx.bump("items_skipped")
                continue
            key = f"folder:{source_id}:{os.path.normcase(str(path))}"
            with transaction(self._factory) as session:
                doc = session.scalar(select(Document).where(Document.dedupe_key == key))
                if doc is not None and doc.file_mtime == stat.st_mtime and doc.size_bytes == stat.st_size \
                        and doc.status != ItemStatus.FAILED.value:
                    ctx.bump("items_skipped")
                    continue
            try:
                sha = sha256_file(path)
                with path.open("rb") as fh:
                    head = fh.read(4096)
                sniffed = sniff_bytes(head, path.name)
            except UnsupportedFileError:
                ctx.bump("items_skipped")
                continue
            except OSError:
                ctx.bump("items_failed")
                failures += 1
                continue
            with transaction(self._factory) as session:
                doc = session.scalar(select(Document).where(Document.dedupe_key == key))
                if doc is not None and doc.sha256 == sha and doc.status != ItemStatus.FAILED.value:
                    doc.file_mtime = stat.st_mtime
                    ctx.bump("items_skipped")
                    continue
                if doc is None:
                    doc = Document(
                        source_id=source_id,
                        dedupe_key=key,
                        kind=sniffed.kind,
                        original_name=sanitize_filename(path.name),
                        original_path=str(path),
                        stored_path=None,
                        sha256=sha,
                        mime_type=sniffed.mime_type,
                        size_bytes=stat.st_size,
                        file_mtime=stat.st_mtime,
                        status=ItemStatus.PENDING.value,
                        imported_at=self.clock(),
                    )
                    session.add(doc)
                else:
                    doc.sha256 = sha
                    doc.size_bytes = stat.st_size
                    doc.file_mtime = stat.st_mtime
                    doc.status = ItemStatus.PENDING.value
                session.flush()
                doc_id = doc.id
            result = self.documents.process(doc_id)
            if result.status == "failed":
                ctx.bump("items_failed")
                failures += 1
            else:
                ctx.bump("items_processed")
                ctx.bump("tasks_created", result.tasks_created)
                ctx.bump("tasks_updated", result.tasks_updated + result.completions_applied)
        self._set_source_status(source_id, "ok", None, None, success=True)
        return JobStatus.PARTIAL if failures else JobStatus.SUCCEEDED

    def _set_source_status(self, source_id: int, status: str, code: str | None, message: str | None,
                           *, success: bool = False) -> None:
        with transaction(self._factory) as session:
            source = session.get(Source, source_id)
            if source is None:
                return
            source.status = status
            source.last_sync_at = self.clock()
            source.last_error_code = code
            source.last_error_message = message
            if success:
                source.last_success_at = self.clock()
