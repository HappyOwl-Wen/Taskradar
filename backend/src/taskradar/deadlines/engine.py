"""Deterministic deadline & urgency evaluation (never delegated to a model).

* Exact deadlines are evaluated at their local wall-clock time in the task's time zone
  (Europe/Berlin by default) using IANA rules, so DST transitions are handled correctly.
* Date-only deadlines count as "due by the end of that local day" *for urgency computation only*;
  the stored deadline remains date-only (no invented 23:59).
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from taskradar.domain.enums import CLOSED_STATUSES, Urgency


@dataclass(frozen=True)
class Thresholds:
    urgent_hours: int = 24
    high_days: int = 3
    upcoming_days: int = 7


@dataclass(frozen=True)
class DeadlineStatus:
    urgency: Urgency
    effective_deadline: dt.datetime | None
    remaining_seconds: float | None
    all_day: bool


def parse_hhmm(value: str | dt.time | None) -> dt.time | None:
    if value is None or isinstance(value, dt.time):
        return value
    hours, _, minutes = value.partition(":")
    return dt.time(int(hours), int(minutes or 0))


def effective_deadline(due_date: dt.date | None, due_time: str | dt.time | None, tz_name: str) -> dt.datetime | None:
    if due_date is None:
        return None
    tz = ZoneInfo(tz_name)
    clock = parse_hhmm(due_time)
    if clock is not None:
        local = dt.datetime.combine(due_date, clock).replace(tzinfo=tz)
    else:
        local = dt.datetime.combine(due_date + dt.timedelta(days=1), dt.time(0)).replace(tzinfo=tz)
    return local.astimezone(dt.UTC)


def evaluate(
    *,
    status: str,
    due_date: dt.date | None,
    due_time: str | dt.time | None,
    tz_name: str,
    now: dt.datetime,
    thresholds: Thresholds | None = None,
) -> DeadlineStatus:
    thresholds = thresholds or Thresholds()
    if status in {s.value for s in CLOSED_STATUSES}:
        return DeadlineStatus(Urgency.INACTIVE, effective_deadline(due_date, due_time, tz_name), None, due_time is None)
    deadline = effective_deadline(due_date, due_time, tz_name)
    if deadline is None:
        return DeadlineStatus(Urgency.NO_DEADLINE, None, None, True)
    remaining = (deadline - now).total_seconds()
    if remaining <= 0:
        urgency = Urgency.OVERDUE
    elif remaining <= thresholds.urgent_hours * 3600:
        urgency = Urgency.URGENT
    elif remaining <= thresholds.high_days * 86400:
        urgency = Urgency.HIGH
    elif remaining <= thresholds.upcoming_days * 86400:
        urgency = Urgency.UPCOMING
    else:
        urgency = Urgency.NORMAL
    return DeadlineStatus(urgency, deadline, remaining, due_time is None)


def local_today(now: dt.datetime, tz_name: str) -> dt.date:
    return now.astimezone(ZoneInfo(tz_name)).date()


def format_due_at(due_date: dt.date | None, due_time: str | None, tz_name: str) -> str | None:
    """API representation: ISO date for date-only deadlines, ISO local datetime with offset otherwise."""
    if due_date is None:
        return None
    clock = parse_hhmm(due_time)
    if clock is None:
        return due_date.isoformat()
    local = dt.datetime.combine(due_date, clock).replace(tzinfo=ZoneInfo(tz_name))
    return local.isoformat()
