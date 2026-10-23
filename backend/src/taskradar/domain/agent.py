"""Validated Agent configuration and tool arguments; no credentials live in settings."""

from __future__ import annotations

import contextlib
import datetime as dt
import ipaddress
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from taskradar.domain.calendar import EventForm
from taskradar.domain.enums import Category, Priority, TaskStatus, TimeSemantics

Provider = Literal["anthropic", "openai", "openai_compatible"]
ReasoningEffort = Literal["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"]
ExecutionMode = Literal["restricted", "yolo"]
DEFAULTS = {
    "anthropic": ("https://api.anthropic.com/v1", "claude-sonnet-5-5"),
    "openai": ("https://api.openai.com/v1", "gpt-5.4-mini"),
    "openai_compatible": ("https://api.openai.com/v1", "gpt-5.4-mini"),
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class AgentConfig(StrictModel):
    provider: Provider = "anthropic"
    base_url: str = Field(default=DEFAULTS["anthropic"][0], max_length=1000)
    model: str = Field(default=DEFAULTS["anthropic"][1], min_length=1, max_length=200)
    workspace_access: bool = True
    reasoning_effort: ReasoningEffort = "auto"
    execution_mode: ExecutionMode = "restricted"
    title_mode: Literal["message", "model"] = "message"
    title_model: str | None = Field(default=None, min_length=1, max_length=200)
    prompt_suggestions: Literal["off", "presets", "model"] = "presets"
    prompt_cache: Literal["off", "5m", "1h"] = "5m"

    @model_validator(mode="before")
    @classmethod
    def provider_defaults(cls, value: object) -> object:
        if isinstance(value, dict) and isinstance(value.get("provider"), str) and value["provider"] in DEFAULTS:
            endpoint, model = DEFAULTS[value["provider"]]
            return {"base_url": endpoint, "model": model, **value}
        return value

    @field_validator("base_url")
    @classmethod
    def endpoint(cls, value: str) -> str:
        value = value.rstrip("/")
        url = urlsplit(value)
        if not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("Use an API base URL without credentials, query or fragment")
        loopback = url.hostname == "localhost"
        with contextlib.suppress(ValueError):
            loopback = loopback or ipaddress.ip_address(url.hostname).is_loopback
        if url.scheme != "https" and not (url.scheme == "http" and loopback):
            raise ValueError("HTTPS is required (HTTP is allowed only for localhost)")
        return value


class AgentConfigUpdate(AgentConfig):
    api_key: str | None = Field(default=None, max_length=4096, repr=False)


class AgentPreferences(StrictModel):
    model: str | None = Field(default=None, min_length=1, max_length=200)
    reasoning_effort: ReasoningEffort | None = None
    execution_mode: ExecutionMode | None = None
    prompt_suggestions: Literal["off", "presets", "model"] | None = None

    @model_validator(mode="after")
    def not_null(self) -> AgentPreferences:
        if any(getattr(self, name) is None for name in self.model_fields_set):
            raise ValueError("Preferences cannot be null")
        return self


class FindTasks(StrictModel):
    query: str = Field(default="", max_length=200)
    status: TaskStatus | None = None
    limit: int = Field(default=30, ge=1, le=100)


class CalendarRange(StrictModel):
    start: dt.date
    end: dt.date

    @model_validator(mode="after")
    def bounded(self) -> CalendarRange:
        if not 0 < (self.end - self.start).days <= 45:
            raise ValueError("Choose a date range of 1 to 45 days; end is exclusive")
        return self


class TaskFields(StrictModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=8000)
    due_date: dt.date | None = None
    due_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    time_semantics: TimeSemantics | None = None
    category: Category | None = None
    priority: Priority | None = None
    status: TaskStatus | None = None

    @model_validator(mode="after")
    def nonnull_fields(self) -> TaskFields:
        for name in self.model_fields_set - {"due_date", "due_time"}:
            if getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        if self.status == TaskStatus.CANDIDATE:
            raise ValueError("Use confirmed for a to-do")
        return self


class CreateTask(TaskFields):
    title: str = Field(min_length=1, max_length=200)


class UpdateTask(StrictModel):
    task_id: UUID
    changes: TaskFields


class TaskId(StrictModel):
    task_id: UUID


class SaveBlock(EventForm):
    model_config = ConfigDict(extra="forbid")
    block_id: UUID | None = None
    task_id: UUID | None = None
    all_day: Literal[False] = False
    # WorkBlock currently stores only title/time/link/buffers. Never preview fields we would silently drop.
    description: Literal[""] = ""
    location: Literal[""] = ""


class BlockId(StrictModel):
    block_id: UUID


class SaveEvent(StrictModel):
    operation: Literal["create", "update", "delete"]
    calendar_id: str = Field(min_length=1, max_length=512)
    event_id: str | None = Field(default=None, max_length=1024)
    event: EventForm | None = None

    @model_validator(mode="after")
    def valid_operation(self) -> SaveEvent:
        if self.operation != "create" and not self.event_id:
            raise ValueError("An event ID is required")
        if self.operation == "create" and self.event_id:
            raise ValueError("A new event must not have an event ID")
        if self.operation != "delete" and not self.event:
            raise ValueError("Event details are required")
        return self


class Availability(StrictModel):
    start: str = Field(max_length=64)
    end: str = Field(max_length=64)
    timezone: str = Field(max_length=100)
