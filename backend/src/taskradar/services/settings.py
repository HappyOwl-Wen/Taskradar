"""Typed, database-backed user settings (non-secret). One row per section in ``settings``."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy.orm import Session, sessionmaker

from taskradar.db.models import Setting
from taskradar.db.session import transaction
from taskradar.domain.enums import Category

log = logging.getLogger(__name__)


class _Section(BaseModel):
    model_config = ConfigDict(extra="ignore", validate_assignment=True)


class GeneralSettings(_Section):
    timezone: str = "Europe/Berlin"
    language: Literal["zh-CN", "en"] = "zh-CN"
    theme: Literal["system", "light", "dark"] = "system"

    @field_validator("timezone")
    @classmethod
    def _valid_tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"Unknown time zone: {v}") from exc
        return v


class LLMSettings(_Section):
    provider: Literal["none", "openai", "openai_compatible"] = "none"
    model: str = Field(default="gpt-5-mini", min_length=1, max_length=120)
    base_url: str | None = None
    structured_mode: Literal["json_schema", "json_object"] = "json_schema"
    reasoning_effort: Literal["minimal", "low", "medium", "high"] | None = None
    cloud_consent: bool = False
    consent_at: str | None = None
    redact_identifiers: bool = True
    prefilter: bool = True
    max_input_chars: int = Field(default=12000, ge=1000, le=100000)
    timeout_seconds: float = Field(default=45.0, ge=5, le=300)
    max_retries: int = Field(default=2, ge=0, le=5)
    use_semantic_dedup: bool = True
    price_input_per_mtok: float | None = Field(default=None, ge=0)
    price_output_per_mtok: float | None = Field(default=None, ge=0)

    @field_validator("base_url")
    @classmethod
    def _valid_url(cls, v: str | None) -> str | None:
        if v in (None, ""):
            return None
        if not v.startswith(("https://", "http://127.0.0.1", "http://localhost", "http://[::1]")):
            raise ValueError("base_url must use https (or a local http endpoint)")
        return v.rstrip("/")


class GmailSettings(_Section):
    auto_sync: bool = True
    lookback_days: int = Field(default=30, ge=1, le=365)
    sync_interval_minutes: int = Field(default=30, ge=5, le=1440)
    query_extra: str = Field(default="", max_length=300)
    process_attachments: bool = True
    max_attachment_mb: int = Field(default=15, ge=1, le=25)
    max_messages_per_sync: int = Field(default=500, ge=10, le=5000)


class FolderSettings(_Section):
    scan_interval_minutes: int = Field(default=5, ge=1, le=1440)
    max_file_mb: int = Field(default=25, ge=1, le=100)


class ReminderSettings(_Section):
    urgent_hours: int = Field(default=24, ge=1, le=168)
    high_days: int = Field(default=3, ge=1, le=30)
    upcoming_days: int = Field(default=7, ge=1, le=60)
    notify_candidates: bool = False
    notify_upcoming: bool = True
    overdue_repeat_hours: int = Field(default=24, ge=1, le=720)
    scan_interval_minutes: int = Field(default=5, ge=1, le=240)


class NotificationSettings(_Section):
    desktop_enabled: bool = False
    max_per_scan: int = Field(default=20, ge=1, le=200)


class CalendarSettings(_Section):
    calendar_name: str = Field(default="TaskRadar", min_length=1, max_length=100)
    auto_sync_enabled: bool = False
    auto_sync_categories: list[Category] = Field(default_factory=list)
    reminder_minutes: int = Field(default=1440, ge=0, le=40320)


class PolicySettings(_Section):
    review_confidence_threshold: float = Field(default=0.6, ge=0, le=1)
    auto_complete_on_explicit_confirmation: bool = True
    auto_complete_min_confidence: float = Field(default=0.85, ge=0.5, le=1)
    auto_apply_explicit_deadline_changes: bool = True


class DemoSettings(_Section):
    gmail_failure_mode: Literal["none", "rate_limit", "server_error", "auth", "network"] = "none"


class AppSettings(BaseModel):
    general: GeneralSettings = Field(default_factory=GeneralSettings)
    llm: LLMSettings = Field(default_factory=LLMSettings)
    gmail: GmailSettings = Field(default_factory=GmailSettings)
    folders: FolderSettings = Field(default_factory=FolderSettings)
    reminders: ReminderSettings = Field(default_factory=ReminderSettings)
    notifications: NotificationSettings = Field(default_factory=NotificationSettings)
    calendar: CalendarSettings = Field(default_factory=CalendarSettings)
    policy: PolicySettings = Field(default_factory=PolicySettings)
    demo: DemoSettings = Field(default_factory=DemoSettings)


SECTIONS = tuple(AppSettings.model_fields)


class SettingsError(ValueError):
    code = "invalid_settings"


class SettingsService:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._factory = session_factory
        self._cache: AppSettings | None = None
        self._lock = threading.Lock()
        self._listeners: list[Callable[[AppSettings, set[str]], None]] = []

    def subscribe(self, listener: Callable[[AppSettings, set[str]], None]) -> None:
        self._listeners.append(listener)

    def get(self) -> AppSettings:
        with self._lock:
            if self._cache is None:
                self._cache = self._load()
            return self._cache.model_copy(deep=True)

    def _load(self) -> AppSettings:
        data: dict[str, Any] = {}
        with transaction(self._factory) as session:
            for row in session.query(Setting).all():
                if row.key in SECTIONS:
                    data[row.key] = row.value
        try:
            return AppSettings.model_validate(data)
        except ValidationError:
            log.warning("Stored settings were invalid; falling back to defaults for invalid sections")
            settings = AppSettings()
            for key, value in data.items():
                try:
                    setattr(settings, key, type(getattr(settings, key)).model_validate(value))
                except ValidationError:
                    continue
            return settings

    def update(self, changes: dict[str, dict[str, Any]]) -> AppSettings:
        unknown = set(changes) - set(SECTIONS)
        if unknown:
            raise SettingsError(f"Unknown settings sections: {', '.join(sorted(unknown))}")
        current = self.get()
        merged = current.model_dump(mode="json")
        for section, values in changes.items():
            if not isinstance(values, dict):
                raise SettingsError(f"Section {section} must be an object")
            merged[section].update(values)
        try:
            updated = AppSettings.model_validate(merged)
        except ValidationError as exc:
            first = exc.errors()[0]
            loc = ".".join(str(p) for p in first.get("loc", ()))
            raise SettingsError(f"{loc}: {first.get('msg')}") from exc
        with transaction(self._factory) as session:
            for section in changes:
                value = getattr(updated, section).model_dump(mode="json")
                row = session.get(Setting, section)
                if row is None:
                    session.add(Setting(key=section, value=value))
                else:
                    row.value = value
        with self._lock:
            self._cache = updated
        for listener in self._listeners:
            try:
                listener(updated.model_copy(deep=True), set(changes))
            except Exception:  # pragma: no cover - listeners must not break settings updates
                log.exception("Settings listener failed")
        return updated.model_copy(deep=True)

    def invalidate(self) -> None:
        with self._lock:
            self._cache = None
