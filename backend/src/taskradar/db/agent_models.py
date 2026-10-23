"""Local chat history and durable, idempotent change proposals."""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from taskradar.db.base import Base, utcnow


class AgentConversation(Base):
    __tablename__ = "agent_conversations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(100), default="")
    title_source: Mapped[str] = mapped_column(String(16), default="message")
    title_error: Mapped[str | None] = mapped_column(String(100), default=None)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(default=utcnow, index=True)


class AgentTurn(Base):
    __tablename__ = "agent_turns"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("agent_conversations.id", ondelete="CASCADE"), index=True)
    user_text: Mapped[str] = mapped_column(Text)
    assistant_text: Mapped[str] = mapped_column(Text, default="")
    provider: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16), default="running")
    error: Mapped[str | None] = mapped_column(String(100), default=None)
    changes: Mapped[list[dict[str, Any]]] = mapped_column(default=list)
    options: Mapped[dict[str, Any]] = mapped_column(default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(default=utcnow, index=True)
