"""Sources (Gmail / demo mailbox / folders), documents, messages, sync jobs, failures, agent runs."""

from __future__ import annotations

import contextlib
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from taskradar.api.deps import get_container
from taskradar.api.errors import ApiError
from taskradar.api.serializers import document_brief, message_brief, run_to_dict, source_to_dict
from taskradar.container import Container
from taskradar.db.models import Document, ExtractionRun, Message, Source, SyncCheckpoint, SyncJob, TaskSource
from taskradar.db.session import transaction
from taskradar.domain.enums import JobTrigger, SourceKind
from taskradar.security.permissions import SideEffect
from taskradar.services.documents import get_or_create_source
from taskradar.services.jobs import JobAlreadyRunning, job_to_dict
from taskradar.services.system import reveal_in_explorer

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["sources"])

MAX_UPLOAD_FILES = 20


def _executor(request: Request) -> Any:
    return request.app.state.executor


def _running(c: Container, lock_key: str) -> bool:
    with transaction(c.factory) as session:
        return (
            session.scalar(select(SyncJob.id).where(SyncJob.lock_key == lock_key, SyncJob.status == "running"))
            is not None
        )


# ---------------------------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------------------------


@router.get("/sources")
def list_sources(c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        sources = session.scalars(select(Source).order_by(Source.id)).all()
        doc_counts = dict(session.execute(select(Document.source_id, func.count()).group_by(Document.source_id)).all())
        msg_counts = dict(session.execute(select(Message.source_id, func.count()).group_by(Message.source_id)).all())
        items = []
        for s in sources:
            last_job = session.scalar(
                select(SyncJob).where(SyncJob.source_id == s.id).order_by(SyncJob.started_at.desc())
            )
            items.append(
                source_to_dict(
                    s,
                    {
                        "documents": doc_counts.get(s.id, 0),
                        "messages": msg_counts.get(s.id, 0),
                        "last_job": job_to_dict(last_job) if last_job else None,
                        "running": bool(last_job and last_job.status == "running"),
                    },
                )
            )
    return {"items": items}


def _start_sync(c: Container, request: Request, source: dict[str, Any], wait: bool) -> dict[str, Any]:
    kind = source["kind"]
    if kind in (SourceKind.GMAIL.value, SourceKind.DEMO_MAIL.value):
        lock_key = f"gmail:{source['id']}"

        def run() -> dict[str, Any]:
            return c.gmail.sync(source["id"], trigger=JobTrigger.MANUAL)
    elif kind == SourceKind.FOLDER.value:
        lock_key = f"folder:{source['id']}"

        def run() -> dict[str, Any]:
            return c.folders.scan(source["id"], trigger=JobTrigger.MANUAL)
    else:
        raise ApiError("not_syncable", "This source cannot be synchronised", 400)
    if _running(c, lock_key):
        raise ApiError("job_already_running", "This sync is already running", 409)
    if wait:
        return {"job": run(), "accepted": True}

    def background() -> None:
        try:
            run()
        except JobAlreadyRunning:
            log.info("Sync %s already running", lock_key)
        except Exception:
            log.exception("Background sync failed")

    _executor(request).submit(background)
    return {"job": None, "accepted": True}


@router.post("/sources/{source_id}/sync")
def sync_source(
    source_id: int, request: Request, wait: bool = False, c: Container = Depends(get_container)
) -> dict[str, Any]:
    with transaction(c.factory) as session:
        source = session.get(Source, source_id)
        if source is None:
            raise ApiError("source_not_found", "Source not found", 404)
        info = source_to_dict(source)
    return _start_sync(c, request, info, wait)


class FolderBody(BaseModel):
    path: str = Field(min_length=1, max_length=1024)
    recursive: bool = False


@router.post("/sources/folders", status_code=201)
def add_folder(body: FolderBody, request: Request, c: Container = Depends(get_container)) -> dict[str, Any]:
    source = c.folders.add_folder(body.path, recursive=body.recursive)
    info = source_to_dict(source)
    with contextlib.suppress(ApiError):  # a scan of this folder is already running
        _start_sync(c, request, info, wait=False)
    return info


class SourcePatch(BaseModel):
    enabled: bool


@router.patch("/sources/{source_id}")
def patch_source(source_id: int, body: SourcePatch, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        source = session.get(Source, source_id)
        if source is None:
            raise ApiError("source_not_found", "Source not found", 404)
        source.enabled = body.enabled
        return source_to_dict(source)


@router.delete("/sources/{source_id}")
def delete_source(source_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        source = session.get(Source, source_id)
        if source is None:
            raise ApiError("source_not_found", "Source not found", 404)
        kind = source.kind
    if kind == SourceKind.FOLDER.value:
        c.folders.remove_folder(source_id)
    elif kind == SourceKind.DEMO_MAIL.value:
        with transaction(c.factory) as session:
            session.delete(session.get(Source, source_id))
    else:
        raise ApiError("source_not_removable", "Disconnect Gmail in the settings instead", 409)
    return {"deleted": source_id}


@router.get("/sync-jobs")
def list_jobs(limit: int = 30, source_id: int | None = None, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        stmt = select(SyncJob).order_by(SyncJob.started_at.desc()).limit(min(limit, 200))
        if source_id is not None:
            stmt = stmt.where(SyncJob.source_id == source_id)
        return {"items": [job_to_dict(j) for j in session.scalars(stmt)]}


# ---------------------------------------------------------------------------------------------
# Demo mailbox
# ---------------------------------------------------------------------------------------------


@router.post("/demo/mailbox", status_code=201)
def create_demo_mailbox(c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        source = get_or_create_source(
            session, SourceKind.DEMO_MAIL, "合成演示邮箱（无需 Gmail）", account="demo@taskradar.example"
        )
        return source_to_dict(source)


@router.post("/demo/advance")
def advance_demo(c: Container = Depends(get_container)) -> dict[str, Any]:
    """Deliver the follow-up 'payment received' mail on the next demo sync."""
    with transaction(c.factory) as session:
        source = session.scalar(select(Source).where(Source.kind == SourceKind.DEMO_MAIL.value))
        if source is None:
            raise ApiError("demo_not_found", "Create the demo mailbox first", 404)
        row = session.scalar(
            select(SyncCheckpoint).where(SyncCheckpoint.source_id == source.id, SyncCheckpoint.key == "demo_stage")
        )
        if row is None:
            session.add(SyncCheckpoint(source_id=source.id, key="demo_stage", value="2"))
        else:
            row.value = "2"
        return {"stage": 2, "source_id": source.id}


class FailureModeBody(BaseModel):
    mode: str


@router.put("/demo/failure-mode")
def set_failure_mode(body: FailureModeBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    updated = c.settings.update({"demo": {"gmail_failure_mode": body.mode}})
    return {"mode": updated.demo.gmail_failure_mode}


# ---------------------------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------------------------


@router.post("/documents/upload")
async def upload(files: list[UploadFile] = File(...), c: Container = Depends(get_container)) -> dict[str, Any]:
    if len(files) > MAX_UPLOAD_FILES:
        raise ApiError("too_many_files", f"Upload at most {MAX_UPLOAD_FILES} files at once", 413)
    limit = c.settings.get().folders.max_file_mb * 1024 * 1024
    results = []
    for upload_file in files:
        data = await upload_file.read(limit + 1)
        await upload_file.close()
        from starlette.concurrency import run_in_threadpool

        result = await run_in_threadpool(c.documents.import_bytes, data, upload_file.filename)
        results.append(result.__dict__)
    return {"results": results}


@router.get("/documents")
def list_documents(
    status: str | None = None, limit: int = 200, c: Container = Depends(get_container)
) -> dict[str, Any]:
    with transaction(c.factory) as session:
        stmt = select(Document).order_by(Document.imported_at.desc()).limit(min(limit, 1000))
        if status:
            stmt = stmt.where(Document.status == status)
        docs = session.scalars(stmt).all()
        task_counts = dict(
            session.execute(
                select(TaskSource.document_id, func.count(func.distinct(TaskSource.task_id))).group_by(
                    TaskSource.document_id
                )
            ).all()
        )
        return {"items": [{**document_brief(d), "task_count": task_counts.get(d.id, 0)} for d in docs]}


def _tasks_for(session: Any, column: Any, value: int) -> list[dict[str, Any]]:
    rows = session.execute(select(TaskSource).where(column == value)).scalars().all()
    seen: dict[str, dict[str, Any]] = {}
    for ts in rows:
        seen.setdefault(
            ts.task_id, {"id": ts.task_id, "title": ts.task.title, "status": ts.task.status, "relation": ts.relation}
        )
    return list(seen.values())


@router.get("/documents/{document_id}")
def get_document(document_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        doc = session.get(Document, document_id)
        if doc is None:
            raise ApiError("document_not_found", "Document not found", 404)
        runs = session.scalars(
            select(ExtractionRun)
            .where(ExtractionRun.document_id == document_id)
            .order_by(ExtractionRun.created_at.desc())
        ).all()
        return {
            **document_brief(doc),
            "pages": [
                {"page": p.page_no, "text": p.text, "method": p.method, "ocr_confidence": p.ocr_confidence}
                for p in doc.pages
            ],
            "tasks": _tasks_for(session, TaskSource.document_id, document_id),
            "runs": [run_to_dict(r) for r in runs],
        }


def _document_path(c: Container, document_id: int) -> tuple[Path, str, str]:
    with transaction(c.factory) as session:
        doc = session.get(Document, document_id)
        if doc is None:
            raise ApiError("document_not_found", "Document not found", 404)
        raw = doc.stored_path or doc.original_path
        mime, name = doc.mime_type, doc.original_name
    if not raw:
        raise ApiError("file_missing", "No file is stored for this document", 404)
    c.guard.check(SideEffect.FILE_REVEAL, target=raw)
    return Path(raw), mime, name


@router.get("/documents/{document_id}/file")
def document_file(document_id: int, c: Container = Depends(get_container)) -> FileResponse:
    path, mime, name = _document_path(c, document_id)
    headers = {"X-Content-Type-Options": "nosniff"}
    if mime != "application/pdf":
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:"
    return FileResponse(path, media_type=mime, filename=name, content_disposition_type="inline", headers=headers)


@router.post("/documents/{document_id}/reveal")
def reveal_document(document_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    path, _, _ = _document_path(c, document_id)
    if not reveal_in_explorer(path):
        raise ApiError("reveal_unsupported", "Opening the file location is only supported on Windows", 409)
    return {"revealed": True}


@router.post("/documents/reprocess-ocr")
def reprocess_ocr_backlog(
    request: Request, wait: bool = False, c: Container = Depends(get_container)
) -> dict[str, Any]:
    """Read the files again that were imported while no OCR engine was available (runs as a job)."""
    if not c.ocr.available():
        raise ApiError("ocr_unavailable", "No OCR engine is installed", 409)
    count = len(c.documents.ocr_backlog())
    if count == 0:
        return {"accepted": False, "count": 0, "job": None}
    try:
        # The job record exists before the response is sent, so the UI sees it running right away.
        job_id, run = c.documents.start_ocr_backlog_job(c.jobs)
    except JobAlreadyRunning as exc:
        raise ApiError("job_already_running", "These files are already being read again", 409) from exc
    if wait:
        return {"accepted": True, "count": count, "job": run()}

    def background() -> None:
        try:
            run()
        except Exception:
            log.exception("Re-reading the OCR backlog (job %s) failed", job_id)

    _executor(request).submit(background)
    return {"accepted": True, "count": count, "job": None}


@router.post("/documents/{document_id}/reprocess")
def reprocess_document(document_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.documents.process(document_id).__dict__


@router.delete("/documents/{document_id}")
def delete_document(document_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    c.data.delete_document(document_id)
    return {"deleted": document_id}


# ---------------------------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------------------------


@router.get("/messages")
def list_messages(status: str | None = None, limit: int = 200, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        stmt = select(Message).order_by(Message.sent_at.desc()).limit(min(limit, 1000))
        if status:
            stmt = stmt.where(Message.status == status)
        msgs = session.scalars(stmt).all()
        task_counts = dict(
            session.execute(
                select(TaskSource.message_id, func.count(func.distinct(TaskSource.task_id))).group_by(
                    TaskSource.message_id
                )
            ).all()
        )
        runs = {
            r.message_id: r.content_type
            for r in session.scalars(select(ExtractionRun).where(ExtractionRun.message_id.isnot(None)))
        }
        return {
            "items": [
                {
                    **message_brief(m),
                    "task_count": task_counts.get(m.id, 0),
                    "content_type": runs.get(m.id),
                    "skip_reason": m.skip_reason,
                    "error_code": m.error_code,
                }
                for m in msgs
            ]
        }


@router.get("/messages/{message_id}")
def get_message(message_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        msg = session.get(Message, message_id)
        if msg is None:
            raise ApiError("message_not_found", "Message not found", 404)
        runs = session.scalars(
            select(ExtractionRun)
            .where(ExtractionRun.message_id == message_id)
            .order_by(ExtractionRun.created_at.desc())
        ).all()
        return {
            **message_brief(msg),
            "recipients": msg.recipients,
            "labels": msg.labels,
            "body_text": msg.body_text,
            "skip_reason": msg.skip_reason,
            "error_code": msg.error_code,
            "attachments": [document_brief(d) for d in msg.attachments],
            "tasks": _tasks_for(session, TaskSource.message_id, message_id),
            "runs": [run_to_dict(r) for r in runs],
        }


@router.post("/messages/{message_id}/reprocess")
def reprocess_message(message_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    outcome = c.ingest.process_message(message_id, force=True)
    return outcome.to_dict()


@router.delete("/messages/{message_id}")
def delete_message(message_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    c.data.delete_message(message_id)
    return {"deleted": message_id}


# ---------------------------------------------------------------------------------------------
# Failures & agent trace
# ---------------------------------------------------------------------------------------------


@router.get("/failures")
def failures(c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        docs = session.scalars(
            select(Document).where(Document.status == "failed").order_by(Document.imported_at.desc())
        ).all()
        msgs = session.scalars(
            select(Message).where(Message.status == "failed").order_by(Message.created_at.desc())
        ).all()
        jobs = session.scalars(
            select(SyncJob)
            .where(SyncJob.status.in_(["failed", "interrupted"]))
            .order_by(SyncJob.started_at.desc())
            .limit(50)
        ).all()
        return {
            "documents": [document_brief(d) for d in docs],
            "messages": [
                {**message_brief(m), "error_code": m.error_code, "error_message": m.error_message} for m in msgs
            ],
            "jobs": [job_to_dict(j) for j in jobs],
        }


@router.get("/agent-runs")
def agent_runs(limit: int = 50, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        runs = session.scalars(
            select(ExtractionRun).order_by(ExtractionRun.created_at.desc()).limit(min(limit, 500))
        ).all()
        return {"items": [run_to_dict(r) for r in runs]}
