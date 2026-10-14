"""Turn ORM objects into API payloads (computed urgency, due_at, evidence, timelines)."""

from __future__ import annotations

import datetime as dt
from typing import Any

from taskradar.db.models import (
    Document,
    ExtractionRun,
    Message,
    Source,
    Task,
    TaskEvent,
    TaskSource,
    TaskSuggestion,
)
from taskradar.deadlines.engine import Thresholds, evaluate, format_due_at
from taskradar.services.calendar_sync import link_to_dict


def _iso(value: dt.datetime | dt.date | None) -> str | None:
    return value.isoformat() if value is not None else None


def task_summary(task: Task, *, now: dt.datetime, thresholds: Thresholds) -> dict[str, Any]:
    status = evaluate(status=task.status, due_date=task.due_date, due_time=task.due_time, tz_name=task.timezone,
                      now=now, thresholds=thresholds)
    kinds = sorted({_source_kind(s) for s in task.sources if _source_kind(s)})
    link = task.calendar_links[0] if task.calendar_links else None
    return {
        "id": task.id,
        "title": task.title,
        "category": task.category,
        "action_type": task.action_type,
        "status": task.status,
        "priority": task.priority,
        "confidence": round(task.confidence, 3),
        "due_at": format_due_at(task.due_date, task.due_time, task.timezone),
        "due_date": _iso(task.due_date),
        "due_time": task.due_time,
        "due_precision": task.due_precision,
        "due_text": task.due_text,
        "due_is_relative": task.due_is_relative,
        "due_needs_confirmation": task.due_needs_confirmation,
        "time_semantics": task.time_semantics,
        "timezone": task.timezone,
        "urgency": status.urgency.value,
        "effective_deadline": _iso(status.effective_deadline),
        "remaining_seconds": status.remaining_seconds,
        "needs_review": task.needs_review,
        "review_reasons": list(task.review_reasons or []),
        "source_count": len(task.sources),
        "source_kinds": kinds,
        "pending_suggestions": sum(1 for s in task.suggestions if s.status == "pending"),
        "calendar_status": link.status if link else None,
        "detected_at": _iso(task.detected_at),
        "source_published_at": _iso(task.source_published_at),
        "created_at": _iso(task.created_at),
        "updated_at": _iso(task.updated_at),
        "confirmed_at": _iso(task.confirmed_at),
        "completed_at": _iso(task.completed_at),
        "manual": task.manual,
    }


def _source_kind(ts: TaskSource) -> str | None:
    if ts.message is not None and ts.message.source is not None:
        return ts.message.source.kind
    if ts.document is not None and ts.document.source is not None:
        return ts.document.source.kind
    return "manual" if ts.origin_key == "manual" else None


def message_brief(msg: Message) -> dict[str, Any]:
    return {
        "id": msg.id,
        "subject": msg.subject,
        "sender": msg.sender,
        "sent_at": _iso(msg.sent_at),
        "web_link": msg.web_link,
        "source_kind": msg.source.kind if msg.source else None,
        "status": msg.status,
        "thread_id": msg.thread_id,
    }


def document_brief(doc: Document) -> dict[str, Any]:
    return {
        "id": doc.id,
        "name": doc.original_name,
        "kind": doc.kind,
        "mime_type": doc.mime_type,
        "size_bytes": doc.size_bytes,
        "page_count": doc.page_count,
        "extraction_method": doc.extraction_method,
        "ocr_engine": doc.ocr_engine,
        "language": doc.language,
        "doc_date": _iso(doc.doc_date),
        "status": doc.status,
        "error_code": doc.error_code,
        "error_message": doc.error_message,
        "warnings": list(doc.warnings or []),
        "sha256": doc.sha256,
        "imported_at": _iso(doc.imported_at),
        "processed_at": _iso(doc.processed_at),
        "processing_ms": doc.processing_ms,
        "source_kind": doc.source.kind if doc.source else None,
        "original_path": doc.original_path,
        "has_stored_copy": bool(doc.stored_path),
        "message_id": doc.message_id,
        "text_chars": doc.text_chars,
    }


def source_entry(ts: TaskSource) -> dict[str, Any]:
    return {
        "id": ts.id,
        "relation": ts.relation,
        "origin_key": ts.origin_key,
        "label": ts.source_label,
        "source_date": _iso(ts.source_date),
        "evidence": list(ts.evidence or []),
        "created_at": _iso(ts.created_at),
        "message": message_brief(ts.message) if ts.message is not None else None,
        "document": document_brief(ts.document) if ts.document is not None else None,
    }


_SAFE_EVENT_KEYS = {
    "before", "after", "origin", "relation", "confidence", "review_reasons", "kind", "suggestion_id",
    "accepted", "reverted_event_id", "split_task_id", "merged_task_id", "merged_into", "event_id", "error",
    "evidence", "other",
}


def event_entry(ev: TaskEvent) -> dict[str, Any]:
    return {
        "id": ev.id,
        "type": ev.event_type,
        "actor": ev.actor,
        "summary": ev.summary,
        "reason": ev.reason,
        "created_at": _iso(ev.created_at),
        "revertible": ev.revertible and ev.reverted_at is None,
        "reverted": ev.reverted_at is not None,
        "data": {k: v for k, v in (ev.data or {}).items() if k in _SAFE_EVENT_KEYS},
    }


def suggestion_entry(s: TaskSuggestion) -> dict[str, Any]:
    return {
        "id": s.id,
        "task_id": s.task_id,
        "kind": s.kind,
        "payload": s.payload,
        "evidence": s.evidence,
        "confidence": round(s.confidence, 3),
        "reason": s.reason,
        "status": s.status,
        "created_at": _iso(s.created_at),
        "related_task_id": s.related_task_id,
    }


def task_detail(task: Task, *, now: dt.datetime, thresholds: Thresholds,
                links: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    data = task_summary(task, now=now, thresholds=thresholds)
    data.update({
        "description": task.description,
        "action_required": task.action_required,
        "entities": list(task.entities or []),
        "user_locked_fields": list(task.user_locked_fields or []),
        "due_anchor": task.due_anchor,
        "due_version": task.due_version,
        "sources": [source_entry(s) for s in task.sources],
        "events": [event_entry(e) for e in reversed(task.events)],
        "suggestions": [suggestion_entry(s) for s in task.suggestions],
        "calendar": link_to_dict(task.calendar_links[0]) if task.calendar_links else None,
        "links": links or [],
    })
    return data


def source_to_dict(source: Source, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": source.id,
        "kind": source.kind,
        "name": source.name,
        "account": source.account,
        "folder_path": source.folder_path,
        "recursive": source.recursive,
        "enabled": source.enabled,
        "status": source.status,
        "last_sync_at": _iso(source.last_sync_at),
        "last_success_at": _iso(source.last_success_at),
        "last_error_code": source.last_error_code,
        "last_error_message": source.last_error_message,
        **(extra or {}),
    }


def run_to_dict(run: ExtractionRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "message_id": run.message_id,
        "document_id": run.document_id,
        "extractor": run.extractor,
        "provider": run.provider,
        "model": run.model,
        "status": run.status,
        "content_type": run.content_type,
        "attempts": run.attempts,
        "input_chars": run.input_chars,
        "redactions": run.redactions,
        "input_tokens": run.input_tokens,
        "output_tokens": run.output_tokens,
        "cost_usd": run.cost_usd,
        "latency_ms": run.latency_ms,
        "candidates_count": run.candidates_count,
        "error": run.error,
        "trace": run.trace,
        "created_at": _iso(run.created_at),
    }
