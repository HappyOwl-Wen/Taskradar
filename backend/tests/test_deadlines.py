"""Deadline / urgency engine and reminder planning (deterministic, DST-aware)."""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from taskradar.deadlines.engine import Thresholds, effective_deadline, evaluate, format_due_at
from taskradar.deadlines.reminders import ReminderSettings, plan_reminder
from taskradar.domain.enums import NotificationLevel, Urgency

BERLIN = ZoneInfo("Europe/Berlin")


def at(y: int, mo: int, d: int, h: int = 0, mi: int = 0) -> dt.datetime:
    return dt.datetime(y, mo, d, h, mi, tzinfo=BERLIN).astimezone(dt.UTC)


def urgency(now: dt.datetime, due_date: dt.date | None, due_time: str | None = None, status: str = "confirmed",
            thresholds: Thresholds | None = None) -> Urgency:
    return evaluate(status=status, due_date=due_date, due_time=due_time, tz_name="Europe/Berlin", now=now,
                    thresholds=thresholds).urgency


def test_default_thresholds() -> None:
    now = at(2026, 10, 14, 10)
    assert urgency(now, dt.date(2026, 10, 13)) == Urgency.OVERDUE
    assert urgency(now, dt.date(2026, 10, 14)) == Urgency.URGENT  # due today (end of day)
    assert urgency(now, dt.date(2026, 10, 14), "09:00") == Urgency.OVERDUE
    assert urgency(now, dt.date(2026, 10, 15), "09:00") == Urgency.URGENT
    assert urgency(now, dt.date(2026, 10, 16)) == Urgency.HIGH
    assert urgency(now, dt.date(2026, 10, 20)) == Urgency.UPCOMING
    assert urgency(now, dt.date(2026, 11, 20)) == Urgency.NORMAL
    assert urgency(now, None) == Urgency.NO_DEADLINE


def test_completed_and_dismissed_tasks_are_inactive() -> None:
    now = at(2026, 10, 14, 10)
    assert urgency(now, dt.date(2026, 10, 1), status="completed") == Urgency.INACTIVE
    assert urgency(now, dt.date(2026, 10, 1), status="dismissed") == Urgency.INACTIVE


def test_thresholds_are_configurable() -> None:
    now = at(2026, 10, 14, 10)
    wide = Thresholds(urgent_hours=72, high_days=10, upcoming_days=30)
    assert urgency(now, dt.date(2026, 10, 16), thresholds=wide) == Urgency.URGENT
    assert urgency(now, dt.date(2026, 11, 5), thresholds=wide) == Urgency.UPCOMING


def test_date_only_deadline_ends_at_local_midnight_across_dst_end() -> None:
    # 2026-10-25: clocks go back (CEST -> CET); the local day is 25 hours long.
    deadline = effective_deadline(dt.date(2026, 10, 25), None, "Europe/Berlin")
    assert deadline == dt.datetime(2026, 10, 25, 23, 0, tzinfo=dt.UTC)  # 00:00 CET on the 26th
    before = dt.datetime(2026, 10, 25, 22, 59, tzinfo=dt.UTC)
    assert urgency(before, dt.date(2026, 10, 25)) == Urgency.URGENT
    assert urgency(deadline, dt.date(2026, 10, 25)) == Urgency.OVERDUE


def test_exact_deadline_across_dst_start() -> None:
    # 2026-03-29: clocks go forward (CET -> CEST). 12:00 local is 10:00 UTC on that day.
    deadline = effective_deadline(dt.date(2026, 3, 29), "12:00", "Europe/Berlin")
    assert deadline == dt.datetime(2026, 3, 29, 10, 0, tzinfo=dt.UTC)
    winter = effective_deadline(dt.date(2026, 3, 28), "12:00", "Europe/Berlin")
    assert winter == dt.datetime(2026, 3, 28, 11, 0, tzinfo=dt.UTC)


def test_due_at_representation() -> None:
    assert format_due_at(dt.date(2026, 11, 20), None, "Europe/Berlin") == "2026-11-20"
    assert format_due_at(dt.date(2026, 11, 20), "12:00", "Europe/Berlin") == "2026-11-20T12:00:00+01:00"
    assert format_due_at(dt.date(2026, 7, 1), "12:00", "Europe/Berlin") == "2026-07-01T12:00:00+02:00"
    assert format_due_at(None, None, "Europe/Berlin") is None


def _plan(status: str, now: dt.datetime, due: dt.date, settings: ReminderSettings | None = None, version: int = 0):  # type: ignore[no-untyped-def]
    st = evaluate(status=status, due_date=due, due_time=None, tz_name="Europe/Berlin", now=now)
    return plan_reminder(task_id="t1", title="Pay fee", status=status, due_version=version, due_label=due.isoformat(),
                         deadline=st, now=now, settings=settings or ReminderSettings())


def test_reminder_levels_and_dedupe_keys() -> None:
    now = at(2026, 10, 14, 10)
    upcoming = _plan("confirmed", now, dt.date(2026, 10, 19))
    assert upcoming is not None and upcoming.level == NotificationLevel.UPCOMING
    assert upcoming.dedupe_key == "t1:v0:upcoming"
    # The same situation produces the same key -> no duplicate notification.
    assert _plan("confirmed", now + dt.timedelta(hours=1), dt.date(2026, 10, 19)).dedupe_key == upcoming.dedupe_key
    # A changed deadline (new due_version) can notify again.
    assert _plan("confirmed", now, dt.date(2026, 10, 19), version=1).dedupe_key == "t1:v1:upcoming"


def test_completed_tasks_never_notify() -> None:
    now = at(2026, 10, 14, 10)
    assert _plan("completed", now, dt.date(2026, 10, 1)) is None
    assert _plan("dismissed", now, dt.date(2026, 10, 14)) is None


def test_unconfirmed_tasks_avoid_frequent_notifications() -> None:
    now = at(2026, 10, 14, 10)
    assert _plan("candidate", now, dt.date(2026, 10, 19)) is None  # upcoming: silent
    urgent = _plan("candidate", now, dt.date(2026, 10, 14))
    assert urgent is not None and urgent.dedupe_key.endswith(":candidate")
    overdue1 = _plan("candidate", now, dt.date(2026, 10, 10))
    overdue2 = _plan("candidate", now + dt.timedelta(days=3), dt.date(2026, 10, 10))
    assert overdue1 is not None and overdue2 is not None
    assert overdue1.dedupe_key == overdue2.dedupe_key  # no repeats for candidates


def test_overdue_reminders_repeat_once_per_interval() -> None:
    due = dt.date(2026, 10, 10)
    first = _plan("confirmed", at(2026, 10, 11, 10), due)
    same_day = _plan("confirmed", at(2026, 10, 11, 20), due)
    next_day = _plan("confirmed", at(2026, 10, 12, 10), due)
    assert first is not None and same_day is not None and next_day is not None
    assert first.dedupe_key == same_day.dedupe_key
    assert first.dedupe_key != next_day.dedupe_key
