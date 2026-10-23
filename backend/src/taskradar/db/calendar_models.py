"""Calendar workspace data. Remote snapshots never own tasks or unsent drafts."""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from taskradar.db.base import Base, utcnow


class CalendarSource(Base):
    __tablename__ = "calendar_sources"

    id: Mapped[str] = mapped_column(String(512), primary_key=True)
    summary: Mapped[str] = mapped_column(String(512))
    timezone: Mapped[str] = mapped_column(String(100), default="Europe/Berlin")
    color: Mapped[str] = mapped_column(String(32), default="#4285f4")
    access_role: Mapped[str] = mapped_column(String(32), default="reader")
    primary: Mapped[bool] = mapped_column(default=False)
    selected: Mapped[bool] = mapped_column(default=False)
    app_created: Mapped[bool] = mapped_column(default=False)
    available: Mapped[bool] = mapped_column(default=True)
    sync_token: Mapped[str | None] = mapped_column(Text, default=None)
    last_synced_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    last_error: Mapped[str | None] = mapped_column(String(100), default=None)
    retry_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    failures: Mapped[int] = mapped_column(default=0)


class GoogleEvent(Base):
    """Unexpanded collection used for incremental change detection, including tombstones."""

    __tablename__ = "google_events"
    calendar_id: Mapped[str] = mapped_column(ForeignKey("calendar_sources.id", ondelete="CASCADE"), primary_key=True)
    event_id: Mapped[str] = mapped_column(String(1024), primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(default=dict)


class CalendarWindow(Base):
    """Atomic, bounded, server-expanded instance snapshot. Never used with syncToken."""

    __tablename__ = "calendar_windows"
    __table_args__ = (UniqueConstraint("calendar_id", "start_date", "end_date", "timezone"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    calendar_id: Mapped[str] = mapped_column(ForeignKey("calendar_sources.id", ondelete="CASCADE"))
    start_date: Mapped[dt.date] = mapped_column()
    end_date: Mapped[dt.date] = mapped_column()
    timezone: Mapped[str] = mapped_column(String(100))
    events: Mapped[list[dict[str, Any]]] = mapped_column(default=list)
    last_synced_at: Mapped[dt.datetime | None] = mapped_column(default=None)
    accessed_at: Mapped[dt.datetime] = mapped_column(default=utcnow)


class WorkBlock(Base):
    __tablename__ = "work_blocks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    start_at: Mapped[dt.datetime] = mapped_column(index=True)
    end_at: Mapped[dt.datetime] = mapped_column()
    timezone: Mapped[str] = mapped_column(String(100))
    revision: Mapped[int] = mapped_column(default=1)
    calendar_id: Mapped[str | None] = mapped_column(String(512), default=None)
    event_id: Mapped[str | None] = mapped_column(String(1024), default=None)
    etag: Mapped[str | None] = mapped_column(String(256), default=None)
    sync_status: Mapped[str] = mapped_column(String(32), default="local")
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)


class CalendarDraft(Base):
    """Durable outbox, submitted only by an explicit user action; id also provides idempotency."""

    __tablename__ = "calendar_drafts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    operation: Mapped[str] = mapped_column(String(16))
    calendar_id: Mapped[str] = mapped_column(String(512))
    event_id: Mapped[str | None] = mapped_column(String(1024), default=None)
    work_block_id: Mapped[str | None] = mapped_column(ForeignKey("work_blocks.id", ondelete="SET NULL"), default=None)
    payload: Mapped[dict[str, Any]] = mapped_column(default=dict)
    base_event: Mapped[dict[str, Any]] = mapped_column(default=dict)
    remote_event: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(16), default="draft")
    last_error: Mapped[str | None] = mapped_column(String(100), default=None)
    result: Mapped[dict[str, Any]] = mapped_column(default=dict)
    updated_at: Mapped[dt.datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class CalendarBuffer(Base):
    """Prep, commute or rest time reserved around one item; local only, never sent to Google.

    The key is the item's view id ("work:<block>", "google:<calendar>:<event>") or, for every occurrence of a
    recurring Google event, "series:<calendar>:<recurring event>".
    """

    __tablename__ = "calendar_buffers"
    item_key: Mapped[str] = mapped_column(String(1600), primary_key=True)
    before_minutes: Mapped[int] = mapped_column(default=0)
    before_kind: Mapped[str] = mapped_column(String(16), default="prep")
    after_minutes: Mapped[int] = mapped_column(default=0)
    after_kind: Mapped[str] = mapped_column(String(16), default="rest")
    updated_at: Mapped[dt.datetime] = mapped_column(default=utcnow, onupdate=utcnow)
