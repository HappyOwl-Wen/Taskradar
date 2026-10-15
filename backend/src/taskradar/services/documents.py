"""Document & local-mail import: validation, content-addressed storage, parsing and ingestion.

Uploaded bytes are stored under the application data folder by content hash (the user-supplied
file name is never used as a path). Files in watched folders are read in place and never
modified, moved or deleted.
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.config import AppConfig
from taskradar.db.base import utcnow
from taskradar.db.models import Document, DocumentPage, Message, Source, SyncJob, TaskSource
from taskradar.db.session import transaction
from taskradar.domain.enums import ItemStatus, JobKind, JobStatus, JobTrigger, SourceKind, SourceRelation
from taskradar.domain.schemas import Evidence, NormalizedMessage
from taskradar.parsing.documents import DocumentParseError, parse_document
from taskradar.parsing.email_mime import message_content_hash, parse_eml_bytes
from taskradar.parsing.filetypes import SniffedType, UnsupportedFileError, sanitize_filename, sha256_bytes, sniff_bytes
from taskradar.parsing.ocr import OCREngine
from taskradar.services.ingest import INGEST_LOCK, IngestOutcome, IngestService
from taskradar.services.jobs import JobContext, JobRunner
from taskradar.services.settings import SettingsService
from taskradar.services.tasks import Origin, TaskService

log = logging.getLogger(__name__)

OCR_UNAVAILABLE = "ocr_unavailable"  # document warning: images or scanned pages that still need OCR
OCR_BACKLOG_LOCK = "reprocess:ocr"


class ImportRejected(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class ImportResult:
    filename: str
    status: str
    created: bool
    document_id: int | None = None
    message_id: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    tasks_created: int = 0
    duplicates_merged: int = 0
    suggestions_created: int = 0
    completions_applied: int = 0
    tasks_updated: int = 0
    content_type: str | None = None

    def absorb(self, outcome: IngestOutcome | None) -> None:
        if outcome is None:
            return
        self.tasks_created += outcome.tasks_created
        self.duplicates_merged += outcome.duplicates_merged
        self.suggestions_created += outcome.suggestions_created
        self.completions_applied += outcome.completions_applied
        self.tasks_updated += outcome.tasks_updated
        self.content_type = self.content_type or outcome.content_type


def get_or_create_source(session: Session, kind: SourceKind, name: str, account: str | None = None) -> Source:
    stmt = select(Source).where(Source.kind == kind.value)
    if account is not None:
        stmt = stmt.where(Source.account == account)
    source = session.scalars(stmt.order_by(Source.id)).first()
    if source is None:
        source = Source(kind=kind.value, name=name, account=account, status="ok")
        session.add(source)
        session.flush()
    return source


def _upload_source(session: Session, sample: bool) -> Source:
    if sample:
        return get_or_create_source(session, SourceKind.SAMPLE_UPLOAD, "测试数据")
    return get_or_create_source(session, SourceKind.UPLOAD, "手动导入")


class DocumentService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        config: AppConfig,
        settings: SettingsService,
        ingest: IngestService,
        tasks: TaskService,
        ocr: OCREngine,
        clock: Callable[[], dt.datetime] = utcnow,
    ) -> None:
        self._factory = session_factory
        self.config = config
        self.settings = settings
        self.ingest = ingest
        self.tasks = tasks
        self.ocr = ocr
        self.clock = clock

    # ------------------------------------------------------------------------------------------
    # Upload entry point
    # ------------------------------------------------------------------------------------------

    def import_bytes(self, data: bytes, filename: str | None, *, sample: bool = False) -> ImportResult:
        """Import an uploaded file; ``sample`` imports it as test data (its tasks never count or remind)."""
        safe_name = sanitize_filename(filename, fallback="upload")
        max_bytes = self.settings.get().folders.max_file_mb * 1024 * 1024
        if len(data) == 0:
            return ImportResult(safe_name, "failed", False, error_code="empty_file", error_message="The file is empty")
        if len(data) > max_bytes:
            return ImportResult(
                safe_name,
                "failed",
                False,
                error_code="file_too_large",
                error_message=f"Files larger than {max_bytes // (1024 * 1024)} MB are not accepted",
            )
        try:
            sniffed = sniff_bytes(data[:4096], safe_name)
        except UnsupportedFileError as exc:
            return ImportResult(
                safe_name,
                "failed",
                False,
                error_code=exc.code,
                error_message="Only PDF, PNG, JPEG, WebP and .eml files are supported",
            )
        if sniffed.kind == "email":
            return self.import_eml(data, safe_name, sample=sample)
        with transaction(self._factory) as session:
            source = _upload_source(session, sample)
            doc, created = self._store_document(
                session, data, sniffed, safe_name, source_id=source.id, dedupe_key=f"upload:{sha256_bytes(data)}"
            )
            doc_id, status = doc.id, doc.status
        if not created and status in (ItemStatus.PROCESSED.value, ItemStatus.SKIPPED.value):
            return ImportResult(safe_name, "duplicate_file", False, document_id=doc_id)
        return self.process(doc_id)

    # ------------------------------------------------------------------------------------------
    # Storage
    # ------------------------------------------------------------------------------------------

    def _write_blob(self, data: bytes, sha: str, ext: str, base: Path) -> Path:
        target_dir = base / sha[:2]
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"{sha}{ext}"
        if target.exists():
            return target
        fd, tmp = tempfile.mkstemp(dir=target_dir, prefix=".incoming-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return target

    def _store_document(
        self,
        session: Session,
        data: bytes,
        sniffed: SniffedType,
        safe_name: str,
        *,
        source_id: int,
        dedupe_key: str,
        message_id: int | None = None,
        base: Path | None = None,
    ) -> tuple[Document, bool]:
        existing = session.scalar(select(Document).where(Document.dedupe_key == dedupe_key))
        if existing is not None:
            return existing, False
        sha = sha256_bytes(data)
        path = self._write_blob(data, sha, sniffed.extension, base or self.config.uploads_dir)
        doc = Document(
            source_id=source_id,
            message_id=message_id,
            dedupe_key=dedupe_key,
            kind=sniffed.kind,
            original_name=safe_name,
            stored_path=str(path),
            sha256=sha,
            mime_type=sniffed.mime_type,
            size_bytes=len(data),
            status=ItemStatus.PENDING.value,
            imported_at=self.clock(),
        )
        session.add(doc)
        session.flush()
        return doc, True

    def store_attachment(self, session: Session, data: bytes, filename: str, *, message: Message) -> Document | None:
        safe_name = sanitize_filename(filename, fallback="attachment")
        try:
            sniffed = sniff_bytes(data[:4096], safe_name)
        except UnsupportedFileError:
            return None
        if sniffed.kind == "email":
            return None
        doc, _ = self._store_document(
            session,
            data,
            sniffed,
            safe_name,
            source_id=message.source_id,
            dedupe_key=f"attachment:{message.id}:{sha256_bytes(data)}",
            message_id=message.id,
            base=self.config.attachments_dir,
        )
        return doc

    # ------------------------------------------------------------------------------------------
    # Processing
    # ------------------------------------------------------------------------------------------

    def process(self, document_id: int) -> ImportResult:
        with transaction(self._factory) as session:
            doc = session.get(Document, document_id)
            if doc is None:
                raise LookupError(f"document {document_id} not found")
            path = Path(doc.stored_path or doc.original_path or "")
            kind = doc.kind
            name = doc.original_name
            doc.status = ItemStatus.PENDING.value
        result = ImportResult(name, "processed", True, document_id=document_id)
        started = time.perf_counter()
        ocr_ready = self.ocr.available()
        with INGEST_LOCK, transaction(self._factory) as session:
            doc = session.get(Document, document_id)
            assert doc is not None
            twin = self._analysed_twin(session, doc, ocr_ready=ocr_ready)
            if twin is not None:
                # Identical content was already read (e.g. the same logo in every mail of a sender):
                # reuse its text instead of parsing and OCR-ing the file again.
                self._copy_parse(session, doc, twin)
                return self._mark_duplicate(session, doc, twin, result, started)
        try:
            parsed = parse_document(path, kind, self.ocr)
        except DocumentParseError as exc:
            self._mark_failed(document_id, exc.code, str(exc), started)
            result.status, result.error_code, result.error_message = "failed", exc.code, str(exc)
            return result
        except Exception as exc:  # defensive: never let one bad file break a sync
            log.exception("Unexpected parser failure for document %s", document_id)
            self._mark_failed(document_id, "parse_failed", exc.__class__.__name__, started)
            result.status, result.error_code, result.error_message = "failed", "parse_failed", exc.__class__.__name__
            return result

        with INGEST_LOCK, transaction(self._factory) as session:
            doc = session.get(Document, document_id)
            assert doc is not None
            for stale in list(doc.pages):
                session.delete(stale)
            session.flush()
            for page in parsed.pages:
                session.add(
                    DocumentPage(
                        document_id=doc.id,
                        page_no=page.page,
                        text=page.text,
                        method=page.method,
                        ocr_confidence=page.ocr_confidence,
                    )
                )
            doc.page_count = parsed.page_count
            doc.extraction_method = parsed.extraction_method
            doc.language = parsed.language
            doc.doc_date = parsed.doc_date
            doc.ocr_engine = parsed.ocr_engine
            doc.warnings = parsed.warnings
            doc.text_chars = len(parsed.text)
            twin = self._analysed_twin(session, doc, ocr_ready=OCR_UNAVAILABLE not in parsed.warnings)
            if twin is not None:
                # Analysed by a concurrent import in the meantime.
                return self._mark_duplicate(session, doc, twin, result, started)

        try:
            outcome = self.ingest.process_document(document_id)
        except Exception as exc:
            log.exception("Extraction failed for document %s", document_id)
            self._mark_failed(document_id, "extraction_failed", exc.__class__.__name__, started)
            result.status, result.error_code, result.error_message = "failed", "extraction_failed", str(exc)[:300]
            return result
        result.absorb(outcome)
        with transaction(self._factory) as session:
            doc = session.get(Document, document_id)
            assert doc is not None
            doc.status = ItemStatus.PROCESSED.value
            doc.error_code = None
            doc.error_message = None
            if outcome.skipped and outcome.skip_reason == "no_text":
                doc.warnings = [*doc.warnings, "no_text_found"]
            doc.processed_at = self.clock()
            doc.processing_ms = int((time.perf_counter() - started) * 1000)
        return result

    def _analysed_twin(self, session: Session, doc: Document, *, ocr_ready: bool) -> Document | None:
        """An analysed document with identical content, unless OCR could now read more than it did."""
        twins = session.scalars(
            select(Document)
            .where(
                Document.sha256 == doc.sha256,
                Document.id != doc.id,
                Document.status == ItemStatus.PROCESSED.value,
            )
            .order_by(Document.id)
        )
        return next((t for t in twins if not ocr_ready or OCR_UNAVAILABLE not in (t.warnings or [])), None)

    def _copy_parse(self, session: Session, doc: Document, twin: Document) -> None:
        for stale in list(doc.pages):
            session.delete(stale)
        session.flush()
        for page in twin.pages:
            session.add(
                DocumentPage(
                    document_id=doc.id,
                    page_no=page.page_no,
                    text=page.text,
                    method=page.method,
                    ocr_confidence=page.ocr_confidence,
                )
            )
        doc.page_count = twin.page_count
        doc.extraction_method = twin.extraction_method
        doc.language = twin.language
        doc.doc_date = twin.doc_date
        doc.ocr_engine = twin.ocr_engine
        doc.warnings = list(twin.warnings or [])
        doc.text_chars = twin.text_chars

    def _mark_duplicate(
        self, session: Session, doc: Document, twin: Document, result: ImportResult, started: float
    ) -> ImportResult:
        """Deterministic layer: identical file content was already analysed; link its tasks instead."""
        result.duplicates_merged = self._link_duplicate_content(session, doc, twin)
        result.status = "duplicate_content"
        doc.status = ItemStatus.SKIPPED.value
        doc.error_code = None
        doc.error_message = None
        doc.warnings = [*doc.warnings, f"duplicate_content_of:{twin.id}"]
        doc.processed_at = self.clock()
        doc.processing_ms = int((time.perf_counter() - started) * 1000)
        return result

    # ------------------------------------------------------------------------------------------
    # Files imported while no OCR engine was available
    # ------------------------------------------------------------------------------------------

    def ocr_backlog(self) -> list[int]:
        """Documents whose images or scanned pages could not be read because OCR was unavailable."""
        with transaction(self._factory) as session:
            rows = session.execute(
                select(Document.id, Document.warnings)
                .where(Document.status != ItemStatus.PENDING.value)
                .order_by(Document.id)
            ).all()
        return [doc_id for doc_id, warnings in rows if OCR_UNAVAILABLE in (warnings or [])]

    def ocr_backlog_running(self) -> bool:
        with transaction(self._factory) as session:
            running = select(SyncJob.id).where(
                SyncJob.lock_key == OCR_BACKLOG_LOCK, SyncJob.status == JobStatus.RUNNING.value
            )
            return session.scalar(running) is not None

    def start_ocr_backlog_job(self, jobs: JobRunner) -> tuple[int, Callable[[], dict[str, Any]]]:
        """Create the job record now (raises ``JobAlreadyRunning``); the returned callable does the work."""
        job_id = jobs.start(JobKind.REPROCESS, lock_key=OCR_BACKLOG_LOCK, source_id=None, trigger=JobTrigger.MANUAL)
        return job_id, lambda: jobs.execute(job_id, JobKind.REPROCESS, self.reprocess_ocr_backlog)

    def reprocess_ocr_backlog(self, ctx: JobContext) -> JobStatus:
        """Job body: read the backlog again, oldest first (so identical copies reuse the first result)."""
        ids = self.ocr_backlog()
        ctx.bump("items_seen", len(ids))
        for document_id in ids:
            result = self.process(document_id)
            if result.status == "failed":
                ctx.bump("items_failed")
                continue
            ctx.bump("items_skipped" if result.status == "duplicate_content" else "items_processed")
            ctx.bump("tasks_created", result.tasks_created)
            ctx.bump("tasks_updated", result.tasks_updated + result.completions_applied)
        return JobStatus.PARTIAL if ctx.counters["items_failed"] else JobStatus.SUCCEEDED

    def _link_duplicate_content(self, session: Session, doc: Document, twin: Document) -> int:
        count = 0
        origin = Origin(key=f"document:{doc.id}", document_id=doc.id, label=doc.original_name, date=doc.imported_at)
        for ts in session.scalars(select(TaskSource).where(TaskSource.document_id == twin.id)):
            evidence = [Evidence.model_validate(e) for e in ts.evidence or []]
            added = self.tasks.attach_source(
                session,
                ts.task,
                origin=origin,
                candidate_row=None,
                relation=SourceRelation.DUPLICATE,
                evidence=evidence,
                summary=f"相同文件内容再次导入：「{doc.original_name}」",
                revertible=False,
            )
            count += 1 if added is not None else 0
        return count

    def _mark_failed(self, document_id: int, code: str, message: str, started: float) -> None:
        with transaction(self._factory) as session:
            doc = session.get(Document, document_id)
            if doc is None:
                return
            doc.status = ItemStatus.FAILED.value
            doc.error_code = code
            doc.error_message = message[:1000]
            doc.processed_at = self.clock()
            doc.processing_ms = int((time.perf_counter() - started) * 1000)

    # ------------------------------------------------------------------------------------------
    # .eml import (mail without Gmail)
    # ------------------------------------------------------------------------------------------

    def import_eml(self, data: bytes, safe_name: str, *, sample: bool = False) -> ImportResult:
        try:
            normalized = parse_eml_bytes(
                data, max_attachment_bytes=self.settings.get().gmail.max_attachment_mb * 1024 * 1024
            )
        except Exception as exc:  # malformed mail
            return ImportResult(safe_name, "failed", False, error_code="corrupted_file", error_message=str(exc)[:200])
        with transaction(self._factory) as session:
            source = _upload_source(session, sample)
            message, created = self.store_message(session, normalized, source=source, web_link=None)
            message_id = message.id
        result = ImportResult(safe_name, "processed", created, message_id=message_id)
        if not created:
            result.status = "duplicate_message"
            return result
        return self.process_message_with_attachments(message_id, normalized, result)

    def store_message(
        self, session: Session, normalized: NormalizedMessage, *, source: Source, web_link: str | None
    ) -> tuple[Message, bool]:
        existing = session.scalar(
            select(Message).where(Message.source_id == source.id, Message.external_id == normalized.external_id)
        )
        if existing is not None:
            return existing, False
        message = Message(
            source_id=source.id,
            external_id=normalized.external_id,
            thread_id=normalized.thread_id,
            history_id=normalized.history_id,
            rfc822_message_id=normalized.rfc822_message_id,
            subject=normalized.subject,
            sender=normalized.sender,
            sender_domain=normalized.sender_domain,
            recipients=normalized.recipients,
            sent_at=normalized.sent_at,
            snippet=normalized.snippet,
            body_text=normalized.body_text,
            labels=normalized.labels,
            is_bulk=normalized.is_bulk,
            web_link=web_link,
            content_hash=message_content_hash(normalized),
            status=ItemStatus.PENDING.value,
            created_at=self.clock(),
        )
        session.add(message)
        session.flush()
        for att in normalized.attachments:
            if att.inline_data:
                self.store_attachment(session, att.inline_data, att.filename, message=message)
        return message, True

    def process_message_with_attachments(
        self, message_id: int, normalized: NormalizedMessage | None, result: ImportResult
    ) -> ImportResult:
        with transaction(self._factory) as session:
            msg = session.get(Message, message_id)
            assert msg is not None
            twin = None
            if msg.rfc822_message_id:
                twin = session.scalar(
                    select(Message).where(
                        Message.rfc822_message_id == msg.rfc822_message_id,
                        Message.id != msg.id,
                        Message.status == ItemStatus.PROCESSED.value,
                    )
                )
            if twin is not None:
                msg.status = ItemStatus.SKIPPED.value
                msg.skip_reason = f"duplicate_message_of:{twin.id}"
                msg.processed_at = self.clock()
                result.status = "duplicate_message"
                return result
            attachment_ids = [d.id for d in msg.attachments]
        try:
            outcome = self.ingest.process_message(message_id)
            result.absorb(outcome)
        except Exception as exc:
            log.exception("Extraction failed for message %s", message_id)
            with transaction(self._factory) as session:
                msg = session.get(Message, message_id)
                if msg is not None:
                    msg.status = ItemStatus.FAILED.value
                    msg.error_code = "extraction_failed"
                    msg.error_message = exc.__class__.__name__
            result.status, result.error_code = "failed", "extraction_failed"
            return result
        for doc_id in attachment_ids:
            sub = self.process(doc_id)
            result.tasks_created += sub.tasks_created
            result.duplicates_merged += sub.duplicates_merged
            result.suggestions_created += sub.suggestions_created
        return result
