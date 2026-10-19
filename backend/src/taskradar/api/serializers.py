"""Turn ORM objects into API payloads (computed urgency, due_at, evidence, timelines)."""

from __future__ import annotations

import datetime as dt
from typing import Any

from taskradar.db.models import Document, Message, Task, TaskEvent, TaskSource
from taskradar.deadlines.engine import Thresholds, evaluate, format_due_at
from taskradar.services.calendar_sync import link_to_dict


def _iso(value: dt.datetime | dt.date | None) -> str | None:
    return value.isoformat() if value is not None else None


def _source_day(ts: TaskSource | None) -> str | None:
    """The calendar date of a source that carries no time of day (e.g. the date line of a letter).

    Such dates are stored as local midnight; exposing the day separately keeps the UI from showing
    an invented "00:00".
    """
    if ts is None or ts.document is None or ts.document.doc_date is None:
        return None
    if ts.message is not None and ts.message.sent_at is not None:
        return None  # attachments are dated by their e-mail
    return ts.document.doc_date.isoformat()


def task_summary(task: Task, *, now: dt.datetime, thresholds: Thresholds) -> dict[str, Any]:
    status = evaluate(
        status=task.status,
        due_date=task.due_date,
        due_time=task.due_time,
        tz_name=task.timezone,
        now=now,
        thresholds=thresholds,
    )
    # Where the task comes from: "manual" for the user's own to-dos, else the kind of mail or file it was found in.
    kinds = sorted({kind for s in task.sources if (kind := _source_kind(s))} | ({"manual"} if task.manual else set()))
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
        "calendar_status": link.status if link else None,
        "detected_at": _iso(task.detected_at),
        "source_published_at": _iso(task.source_published_at),
        "source_published_day": _source_day(next((s for s in task.sources if s.relation == "origin"), None)),
        "created_at": _iso(task.created_at),
        "updated_at": _iso(task.updated_at),
        "confirmed_at": _iso(task.confirmed_at),
        "completed_at": _iso(task.completed_at),
        "manual": task.manual,
        "sample": task.sample,
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
        "source_day": _source_day(ts),
        "evidence": list(ts.evidence or []),
        "created_at": _iso(ts.created_at),
        "message": message_brief(ts.message) if ts.message is not None else None,
        "document": document_brief(ts.document) if ts.document is not None else None,
    }


_SAFE_EVENT_KEYS = {
    "before",
    "after",
    "origin",
    "relation",
    "confidence",
    "review_reasons",
    "kind",
    "suggestion_id",
    "accepted",
    "reverted_event_id",
    "split_task_id",
    "merged_task_id",
    "merged_into",
    "event_id",
    "error",
    "evidence",
    "other",
}


# What can still be undone: merges, suggestions and attached mails of earlier versions stay in the history only.
_REVERTIBLE_EVENTS = {"status_changed", "fields_updated"}


def event_entry(ev: TaskEvent) -> dict[str, Any]:
    return {
        "id": ev.id,
        "type": ev.event_type,
        "actor": ev.actor,
        "summary": ev.summary,
        "reason": ev.reason,
        "created_at": _iso(ev.created_at),
        "revertible": ev.revertible and ev.reverted_at is None and ev.event_type in _REVERTIBLE_EVENTS,
        "reverted": ev.reverted_at is not None,
        "data": {k: v for k, v in (ev.data or {}).items() if k in _SAFE_EVENT_KEYS},
    }


def task_detail(
    task: Task, *, now: dt.datetime, thresholds: Thresholds, links: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    data = task_summary(task, now=now, thresholds=thresholds)
    data.update(
        {
            "description": task.description,
            "action_required": task.action_required,
            "entities": list(task.entities or []),
            "user_locked_fields": list(task.user_locked_fields or []),
            "due_anchor": task.due_anchor,
            "due_version": task.due_version,
            "sources": [source_entry(s) for s in task.sources],
            "events": [event_entry(e) for e in reversed(task.events)],
            "calendar": link_to_dict(task.calendar_links[0]) if task.calendar_links else None,
            "links": links or [],
        }
    )
    return data
