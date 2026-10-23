"""Calendar time validation: explicit zones, exclusive all-day ends and DST folds."""

from __future__ import annotations

import datetime as dt
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

from taskradar.domain.calendar_buffers import Buffer


def local_instant(value: str, timezone: str, fold: int | None = None) -> dt.datetime:
    zone = ZoneInfo(timezone)
    local = dt.datetime.fromisoformat(value)
    if local.tzinfo is not None:
        return local.astimezone(dt.UTC)
    candidates = [local.replace(tzinfo=zone, fold=f) for f in (0, 1)]
    valid = [c for c in candidates if c.astimezone(dt.UTC).astimezone(zone).replace(tzinfo=None) == local]
    if not valid:
        raise ValueError("nonexistent_local_time")
    if len({c.utcoffset() for c in valid}) > 1 and fold is None:
        raise ValueError("ambiguous_local_time")
    return candidates[fold or 0].astimezone(dt.UTC)


class EventForm(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=8000)
    location: str = Field(default="", max_length=1000)
    all_day: bool = False
    start: str = Field(max_length=64)
    end: str = Field(max_length=64)
    timezone: str = "Europe/Berlin"
    start_fold: Literal[0, 1] | None = None
    end_fold: Literal[0, 1] | None = None
    # Local only, never part of google_body(); None leaves an item's stored buffers unchanged.
    buffer: Buffer | None = None

    @field_validator("title")
    @classmethod
    def title_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Title is empty")
        return value.strip()

    @field_validator("timezone")
    @classmethod
    def valid_zone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("Unknown time zone") from exc
        return value

    @model_validator(mode="after")
    def times(self) -> EventForm:
        if self.all_day:
            if dt.date.fromisoformat(self.end) <= dt.date.fromisoformat(self.start):
                raise ValueError("End date must be after start date (exclusive)")
        elif self.end_at <= self.start_at:
            raise ValueError("End must be after start")
        return self

    @property
    def start_at(self) -> dt.datetime:
        return local_instant(self.start, self.timezone, self.start_fold)

    @property
    def end_at(self) -> dt.datetime:
        return local_instant(self.end, self.timezone, self.end_fold)

    def google_body(self) -> dict[str, Any]:
        body: dict[str, Any] = {"summary": self.title, "description": self.description, "location": self.location}
        for key, value in (("start", self.start), ("end", self.end)):
            if self.all_day:
                body[key] = {"date": value}
            else:
                at = self.start_at if key == "start" else self.end_at
                body[key] = {"dateTime": at.astimezone(ZoneInfo(self.timezone)).isoformat(), "timeZone": self.timezone}
        return body


def simple_event(event: dict[str, Any]) -> bool:
    """V1 does not send invitations, edit recurring series/instances or special event types."""
    return not (
        event.get("recurrence")
        or event.get("recurringEventId")
        or event.get("attendees")
        or event.get("eventType", "default") != "default"
        or event.get("locked")
    )
