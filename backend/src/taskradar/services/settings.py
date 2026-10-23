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
    # Desktop app: the close button hides the window in the notification area (reminders and timers go on).
    close_to_tray: bool = True

    @field_validator("timezone")
    @classmethod
    def _valid_tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"Unknown time zone: {v}") from exc
        return v


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
    default_calendar_id: str | None = None
    google_edit_enabled: bool = False
    background_sync_minutes: int = Field(default=5, ge=2, le=60)
    calendar_name: str = Field(default="TaskRadar", min_length=1, max_length=100)
    auto_sync_enabled: bool = False
    auto_sync_categories: list[Category] = Field(default_factory=list)
    reminder_minutes: int = Field(default=1440, ge=0, le=40320)
    # When the user dismisses or deletes a task, remove its event as well.
    remove_on_dismiss: bool = True


class TimerSettings(_Section):
    focus_minutes: int = Field(default=25, ge=1, le=180)
    short_break_minutes: int = Field(default=5, ge=1, le=60)
    long_break_minutes: int = Field(default=15, ge=1, le=120)
    # After this many focus sessions the break is a long one.
    long_break_every: int = Field(default=4, ge=2, le=12)
    auto_start_breaks: bool = False
    auto_start_focus: bool = False
    # A Windows notification when a Pomodoro phase or a countdown ends: that is what a timer is for.
    notify: bool = True


class AppSettings(BaseModel):
    # Sections of removed features (llm, gmail, folders, policy, demo) may still be stored; they are ignored.
    general: GeneralSettings = Field(default_factory=GeneralSettings)
    reminders: ReminderSettings = Field(default_factory=ReminderSettings)
    notifications: NotificationSettings = Field(default_factory=NotificationSettings)
    calendar: CalendarSettings = Field(default_factory=CalendarSettings)
    timers: TimerSettings = Field(default_factory=TimerSettings)


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
