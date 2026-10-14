"""Normalized relational data model.

Overview (see ARCHITECTURE.md for the full diagram):

* ``sources`` - connectors (Gmail account, upload inbox, watched folder, demo mailbox)
* ``sync_checkpoints`` - per-source incremental sync state (e.g. Gmail historyId)
* ``messages`` / ``documents`` / ``document_pages`` - normalized raw inputs
* ``extraction_runs`` - agent execution trace per input (provider, tokens, latency, decisions)
* ``task_candidates`` - every extracted candidate with its reconciliation decision
* ``tasks`` / ``task_sources`` / ``task_links`` - deduplicated obligations and their evidence
* ``task_events`` - append-only, revertible history of every change
* ``task_suggestions`` - automatic changes that require user approval
* ``sync_jobs`` - background job history with locking and retry bookkeeping
* ``calendar_links`` - Google Calendar events created by TaskRadar
* ``notifications`` - deduplicated reminder notifications
* ``settings`` - non-secret user settings (secrets live in the OS credential store)
* ``audit_log`` - every permission check for external side effects
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import (
    Boolean,
    Date,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from taskradar.db.base import Base, utcnow


def new_task_id() -> str:
    return str(uuid.uuid4())


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), index=True)
    name: Mapped[str] = mapped_column(String(200))
    account: Mapped[str | None] = mapped_column(String(320), default=None)
    folder_path: Mapped[str | None] = mapped_column(String(1024), default=None, unique=True)
    recursive: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(20), default="idle")
    last_sync_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    last_success_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    last_error_code: Mapped[str | None] = mapped_column(String(64), default=None)
    last_error_message: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(default=utcnow, onupdate=utcnow)

    checkpoints: Mapped[list[SyncCheckpoint]] = relationship(
        back_populates="source", cascade="all, delete-orphan", passive_deletes=True
    )


class SyncCheckpoint(Base):
    __tablename__ = "sync_checkpoints"
    __table_args__ = (UniqueConstraint("source_id", "key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(64))
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[dt.datetime] = mapped_column(default=utcnow, onupdate=utcnow)

    source: Mapped[Source] = relationship(back_populates="checkpoints")


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (UniqueConstraint("source_id", "external_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), index=True)
    external_id: Mapped[str] = mapped_column(String(255))
    thread_id: Mapped[str | None] = mapped_column(String(255), default=None, index=True)
    history_id: Mapped[str | None] = mapped_column(String(64), default=None)
    rfc822_message_id: Mapped[str | None] = mapped_column(String(512), default=None, index=True)
    subject: Mapped[str] = mapped_column(Text, default="")
    sender: Mapped[str] = mapped_column(String(512), default="")
    sender_domain: Mapped[str | None] = mapped_column(String(255), default=None)
    recipients: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[dt.datetime | None] = mapped_column(default=None, index=True)
    snippet: Mapped[str] = mapped_column(Text, default="")
    body_text: Mapped[str] = mapped_column(Text, default="")
    labels: Mapped[list[str]] = mapped_column(default=list)
    is_bulk: Mapped[bool] = mapped_column(Boolean, default=False)
    web_link: Mapped[str | None] = mapped_column(String(1024), default=None)
    content_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    skip_reason: Mapped[str | None] = mapped_column(String(255), default=None)
    error_code: Mapped[str | None] = mapped_column(String(64), default=None)
    error_message: Mapped[str | None] = mapped_column(Text, default=None)
    extractor_version: Mapped[str | None] = mapped_column(String(64), default=None)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)
    processed_at: Mapped[dt.datetime | None] = mapped_column(default=None)

    source: Mapped[Source] = relationship()
    attachments: Mapped[list[Document]] = relationship(back_populates="message")


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), default=None, index=True
    )
    dedupe_key: Mapped[str] = mapped_column(String(1200), unique=True)
    kind: Mapped[str] = mapped_column(String(20))
    original_name: Mapped[str] = mapped_column(String(255))
    original_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    stored_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    mime_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    file_mtime: Mapped[float | None] = mapped_column(Float, default=None)
    page_count: Mapped[int | None] = mapped_column(Integer, default=None)
    extraction_method: Mapped[str | None] = mapped_column(String(20), default=None)
    ocr_engine: Mapped[str | None] = mapped_column(String(64), default=None)
    language: Mapped[str | None] = mapped_column(String(16), default=None)
    doc_date: Mapped[dt.date | None] = mapped_column(Date, default=None)
    text_chars: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    error_code: Mapped[str | None] = mapped_column(String(64), default=None)
    error_message: Mapped[str | None] = mapped_column(Text, default=None)
    warnings: Mapped[list[str]] = mapped_column(default=list)
    processing_ms: Mapped[int | None] = mapped_column(Integer, default=None)
    extractor_version: Mapped[str | None] = mapped_column(String(64), default=None)
    imported_at: Mapped[dt.datetime] = mapped_column(default=utcnow)
    processed_at: Mapped[dt.datetime | None] = mapped_column(default=None)

    source: Mapped[Source] = relationship()
    message: Mapped[Message | None] = relationship(back_populates="attachments")
    pages: Mapped[list[DocumentPage]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="DocumentPage.page_no",
    )


class DocumentPage(Base):
    __tablename__ = "document_pages"
    __table_args__ = (UniqueConstraint("document_id", "page_no"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    page_no: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text, default="")
    method: Mapped[str] = mapped_column(String(10))
    ocr_confidence: Mapped[float | None] = mapped_column(Float, default=None)

    document: Mapped[Document] = relationship(back_populates="pages")


class ExtractionRun(Base):
    __tablename__ = "extraction_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), default=None, index=True
    )
    document_id: Mapped[int | None] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), default=None, index=True
    )
    extractor: Mapped[str] = mapped_column(String(64))
    provider: Mapped[str | None] = mapped_column(String(64), default=None)
    model: Mapped[str | None] = mapped_column(String(128), default=None)
    prompt_version: Mapped[str | None] = mapped_column(String(32), default=None)
    status: Mapped[str] = mapped_column(String(20))
    content_type: Mapped[str | None] = mapped_column(String(32), default=None)
    attempts: Mapped[int] = mapped_column(Integer, default=1)
    input_chars: Mapped[int] = mapped_column(Integer, default=0)
    redactions: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int | None] = mapped_column(Integer, default=None)
    output_tokens: Mapped[int | None] = mapped_column(Integer, default=None)
    cost_usd: Mapped[float | None] = mapped_column(Float, default=None)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    candidates_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    trace: Mapped[list[dict[str, Any]]] = mapped_column(default=list)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow, index=True)


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_task_id)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(20), default="other", index=True)
    action_type: Mapped[str] = mapped_column(String(20), default="other")
    action_required: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="candidate", index=True)
    priority: Mapped[str] = mapped_column(String(10), default="medium")
    confidence: Mapped[float] = mapped_column(Float, default=0.5)

    due_date: Mapped[dt.date | None] = mapped_column(Date, default=None, index=True)
    due_time: Mapped[str | None] = mapped_column(String(5), default=None)  # "HH:MM" local time
    due_precision: Mapped[str] = mapped_column(String(10), default="none")
    due_text: Mapped[str | None] = mapped_column(Text, default=None)
    due_is_relative: Mapped[bool] = mapped_column(Boolean, default=False)
    due_needs_confirmation: Mapped[bool] = mapped_column(Boolean, default=False)
    due_anchor: Mapped[str | None] = mapped_column(String(20), default=None)
    time_semantics: Mapped[str] = mapped_column(String(15), default="deadline")
    timezone: Mapped[str] = mapped_column(String(64), default="Europe/Berlin")
    due_version: Mapped[int] = mapped_column(Integer, default=0)

    needs_review: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    review_reasons: Mapped[list[str]] = mapped_column(default=list)
    entities: Mapped[list[str]] = mapped_column(default=list)
    fingerprint: Mapped[str] = mapped_column(String(255), default="", index=True)
    user_locked_fields: Mapped[list[str]] = mapped_column(default=list)
    manual: Mapped[bool] = mapped_column(Boolean, default=False)

    source_published_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    last_source_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    detected_at: Mapped[dt.datetime] = mapped_column(default=utcnow)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    confirmed_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    completed_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    dismissed_at: Mapped[dt.datetime | None] = mapped_column(default=None)

    sources: Mapped[list[TaskSource]] = relationship(
        back_populates="task", cascade="all, delete-orphan", passive_deletes=True, order_by="TaskSource.id"
    )
    events: Mapped[list[TaskEvent]] = relationship(
        back_populates="task", cascade="all, delete-orphan", passive_deletes=True, order_by="TaskEvent.id"
    )
    suggestions: Mapped[list[TaskSuggestion]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TaskSuggestion.id",
        foreign_keys="TaskSuggestion.task_id",
    )
    calendar_links: Mapped[list[CalendarLink]] = relationship(
        back_populates="task", cascade="all, delete-orphan", passive_deletes=True
    )


class TaskCandidate(Base):
    __tablename__ = "task_candidates"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("extraction_runs.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), default=None, index=True
    )
    document_id: Mapped[int | None] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), default=None, index=True
    )
    kind: Mapped[str] = mapped_column(String(20), default="task")  # task | completion_signal
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(20), default="other")
    action_type: Mapped[str] = mapped_column(String(20), default="other")
    action_required: Mapped[str] = mapped_column(Text, default="")
    due: Mapped[dict[str, Any]] = mapped_column(default=dict)
    priority: Mapped[str] = mapped_column(String(10), default="medium")
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(default=list)
    entities: Mapped[list[str]] = mapped_column(default=list)
    uncertainties: Mapped[list[str]] = mapped_column(default=list)
    relation_hint: Mapped[str | None] = mapped_column(String(20), default=None)
    decision: Mapped[str | None] = mapped_column(String(32), default=None)
    decision_layer: Mapped[str | None] = mapped_column(String(20), default=None)
    decision_score: Mapped[float | None] = mapped_column(Float, default=None)
    decision_reasons: Mapped[list[str]] = mapped_column(default=list)
    task_id: Mapped[str | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="SET NULL"), default=None, index=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)


class TaskSource(Base):
    __tablename__ = "task_sources"
    __table_args__ = (UniqueConstraint("task_id", "origin_key", "relation"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    candidate_id: Mapped[int | None] = mapped_column(
        ForeignKey("task_candidates.id", ondelete="SET NULL"), default=None
    )
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"), default=None, index=True
    )
    document_id: Mapped[int | None] = mapped_column(
        ForeignKey("documents.id", ondelete="SET NULL"), default=None, index=True
    )
    origin_key: Mapped[str] = mapped_column(String(255))  # "message:<id>" / "document:<id>" / "manual"
    relation: Mapped[str] = mapped_column(String(32))
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(default=list)
    source_label: Mapped[str] = mapped_column(String(512), default="")
    source_date: Mapped[dt.datetime | None] = mapped_column(default=None)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)

    task: Mapped[Task] = relationship(back_populates="sources")
    message: Mapped[Message | None] = relationship()
    document: Mapped[Document | None] = relationship()


class TaskLink(Base):
    __tablename__ = "task_links"
    __table_args__ = (UniqueConstraint("task_id", "other_task_id", "kind"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    other_task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="related")
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)


class TaskEvent(Base):
    __tablename__ = "task_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    event_type: Mapped[str] = mapped_column(String(32))
    actor: Mapped[str] = mapped_column(String(10))
    summary: Mapped[str] = mapped_column(Text, default="")
    reason: Mapped[str | None] = mapped_column(Text, default=None)
    data: Mapped[dict[str, Any]] = mapped_column(default=dict)
    revertible: Mapped[bool] = mapped_column(Boolean, default=False)
    reverted_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    reverted_by_event_id: Mapped[int | None] = mapped_column(Integer, default=None)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow, index=True)

    task: Mapped[Task] = relationship(back_populates="events")


class TaskSuggestion(Base):
    __tablename__ = "task_suggestions"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict[str, Any]] = mapped_column(default=dict)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(default=list)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    reason: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    dedupe_key: Mapped[str] = mapped_column(String(255), unique=True)
    candidate_id: Mapped[int | None] = mapped_column(
        ForeignKey("task_candidates.id", ondelete="SET NULL"), default=None
    )
    related_task_id: Mapped[str | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), default=None
    )
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)
    resolved_at: Mapped[dt.datetime | None] = mapped_column(default=None)

    task: Mapped[Task] = relationship(back_populates="suggestions", foreign_keys=[task_id])


class SyncJob(Base):
    __tablename__ = "sync_jobs"
    __table_args__ = (
        # At most one running job per lock key (prevents concurrent duplicate syncs).
        Index(
            "uq_sync_jobs_running_lock",
            "lock_key",
            unique=True,
            sqlite_where=text("status = 'running'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int | None] = mapped_column(
        ForeignKey("sources.id", ondelete="SET NULL"), default=None, index=True
    )
    kind: Mapped[str] = mapped_column(String(32), index=True)
    trigger: Mapped[str] = mapped_column(String(16))
    lock_key: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), index=True)
    started_at: Mapped[dt.datetime] = mapped_column(default=utcnow, index=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    items_seen: Mapped[int] = mapped_column(Integer, default=0)
    items_processed: Mapped[int] = mapped_column(Integer, default=0)
    items_skipped: Mapped[int] = mapped_column(Integer, default=0)
    items_failed: Mapped[int] = mapped_column(Integer, default=0)
    tasks_created: Mapped[int] = mapped_column(Integer, default=0)
    tasks_updated: Mapped[int] = mapped_column(Integer, default=0)
    error_code: Mapped[str | None] = mapped_column(String(64), default=None)
    error_message: Mapped[str | None] = mapped_column(Text, default=None)
    recoverable: Mapped[bool] = mapped_column(Boolean, default=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    next_retry_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    retried_by_job_id: Mapped[int | None] = mapped_column(Integer, default=None)
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)

    source: Mapped[Source | None] = relationship()


class CalendarLink(Base):
    __tablename__ = "calendar_links"
    __table_args__ = (UniqueConstraint("task_id", "calendar_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    calendar_id: Mapped[str] = mapped_column(String(512))
    event_id: Mapped[str] = mapped_column(String(1024))
    event_kind: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16))
    synced_due_version: Mapped[int] = mapped_column(Integer, default=0)
    html_link: Mapped[str | None] = mapped_column(String(2048), default=None)
    payload_hash: Mapped[str | None] = mapped_column(String(64), default=None)
    last_error: Mapped[str | None] = mapped_column(Text, default=None)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    last_synced_at: Mapped[dt.datetime | None] = mapped_column(default=None)

    task: Mapped[Task] = relationship(back_populates="calendar_links")


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[str | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), default=None, index=True
    )
    level: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    dedupe_key: Mapped[str] = mapped_column(String(255), unique=True)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow, index=True)
    read_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    desktop_sent_at: Mapped[dt.datetime | None] = mapped_column(default=None)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(default=dict)
    updated_at: Mapped[dt.datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    allowed: Mapped[bool] = mapped_column(Boolean)
    reason: Mapped[str] = mapped_column(Text, default="")
    target: Mapped[str | None] = mapped_column(String(512), default=None)
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow, index=True)
