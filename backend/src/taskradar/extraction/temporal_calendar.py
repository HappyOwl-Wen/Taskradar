"""Calendar algebra for manual entry. No wall-clock millisecond arithmetic or holiday assumptions."""

from __future__ import annotations

import calendar
import datetime as dt
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class Operation:
    kind: str
    amount: int = 0
    unit: str = ""
    parts: tuple[int, ...] = ()


@dataclass
class Value:
    date: dt.date | None = None
    end: dt.date | None = None
    time: dt.time | None = None
    daypart: str | None = None
    notes: list[str] = field(default_factory=list)
    alternatives: list[dt.date] = field(default_factory=list)
    invalid: bool = False


def shift(date: dt.date, amount: int, unit: str) -> dt.date:
    if unit not in ("day", "week", "month", "year", "business"):
        raise ValueError("unknown calendar unit")
    if abs(amount) > 10000:
        raise ValueError("offset too large")
    if unit == "business":
        step = 1 if amount >= 0 else -1
        remaining = abs(amount)
        while remaining:
            date += dt.timedelta(days=step)
            remaining -= date.weekday() < 5
        return date
    if unit in ("month", "year"):
        index = date.year * 12 + date.month - 1 + amount * (12 if unit == "year" else 1)
        year, month = divmod(index, 12)
        return dt.date(year, month + 1, min(date.day, calendar.monthrange(year, month + 1)[1]))
    return date + dt.timedelta(days=amount * (7 if unit == "week" else 1))


def bounds(date: dt.date, unit: str) -> tuple[dt.date, dt.date]:
    if unit not in ("week", "month", "year"):
        raise ValueError("unknown calendar period")
    if unit == "week":
        start = date - dt.timedelta(days=date.weekday())
        return start, start + dt.timedelta(days=6)
    if unit == "year":
        return date.replace(month=1, day=1), date.replace(month=12, day=31)
    return date.replace(day=1), date.replace(day=calendar.monthrange(date.year, date.month)[1])


def wall_time_status(date: dt.date, time: dt.time, timezone: str) -> str:
    """Round-trip both folds: a gap has no instant; a fold has two distinct instants."""
    zone = ZoneInfo(timezone)
    naive = dt.datetime.combine(date, time)
    instants = set()
    for fold in (0, 1):
        aware = naive.replace(tzinfo=zone, fold=fold)
        utc = aware.astimezone(dt.UTC)
        if utc.astimezone(zone).replace(tzinfo=None) == naive:
            instants.add(utc)
    return "nonexistent_time" if not instants else "ambiguous_time" if len(instants) == 2 else "valid"


def evaluate(operations: list[Operation], anchor: dt.date) -> Value:
    """Interpret a compositional expression, retaining ranges and uncertain year/weekday choices."""
    value = Value()
    cursor = anchor
    period: str | None = None
    try:
        for op in operations:
            if op.kind == "literal":
                year, month, day = op.parts
                if year:
                    cursor = dt.date(year, month, day)
                else:
                    # Use this year, retaining expired dates. Never silently roll a deadline into next year.
                    value.notes.append("year_inferred")
                    try:
                        cursor = dt.date(anchor.year, month, day)
                    except ValueError:
                        if (month, day) != (2, 29):
                            raise
                        year = next(y for y in range(anchor.year + 1, anchor.year + 9) if calendar.isleap(y))
                        cursor = dt.date(year, month, day)
                        value.notes.append("leap_year_inferred")
                    if cursor < anchor:
                        value.notes.append("missing_year_past")
                        for year in range(anchor.year + 1, anchor.year + 9):
                            try:
                                value.alternatives.append(cursor.replace(year=year))
                                break
                            except ValueError:
                                continue
                value.date, value.end, period = cursor, None, None
            elif op.kind in ("offset", "within"):
                start = cursor
                cursor = shift(cursor, op.amount, op.unit)
                value.alternatives = [shift(date, op.amount, op.unit) for date in value.alternatives]
                value.date, value.end = (start, cursor) if op.kind == "within" else (cursor, None)
                period = op.unit if op.unit in ("week", "month", "year") else None
                if op.unit == "business":
                    value.notes.append("weekdays_only")
            elif op.kind == "period":
                cursor = shift(cursor.replace(day=1) if op.unit in ("month", "year") else cursor, op.amount, op.unit)
                value.date, value.end = bounds(cursor, op.unit)
                period = op.unit
            elif op.kind == "month":
                cursor = cursor.replace(month=op.amount, day=1)
                value.date, value.end = bounds(cursor, "month")
                period = "month"
            elif op.kind == "weekday":
                if not 0 <= op.amount < 7:
                    raise ValueError("invalid weekday")
                if value.date and value.end:
                    cursor = value.date + dt.timedelta(days=(op.amount - value.date.weekday()) % 7)
                    if cursor > value.end:
                        raise ValueError("weekday outside interval")
                    alternative = cursor + dt.timedelta(days=7)
                    while alternative <= value.end:
                        value.alternatives.append(alternative)
                        alternative += dt.timedelta(days=7)
                    if value.alternatives:
                        value.notes.append("multiple_weekdays_in_range")
                elif period == "week":
                    cursor = bounds(cursor, "week")[0] + dt.timedelta(days=op.amount)
                else:
                    cursor += dt.timedelta(days=(op.amount - cursor.weekday()) % 7)
                value.date, value.end, period = cursor, None, None
            elif op.kind == "edge":
                start, end = (value.date, value.end) if value.date and value.end else bounds(cursor, op.unit or "month")
                if op.unit == "week" or period == "week":
                    value.date, value.end = end - dt.timedelta(days=2), end
                elif op.amount == 1:
                    value.date, value.end = start, min(start + dt.timedelta(days=9), end)
                elif op.amount == 2:
                    value.date, value.end = start + dt.timedelta(days=10), min(start + dt.timedelta(days=19), end)
                else:
                    value.date, value.end = end, None
                cursor = value.date
            elif op.kind == "weekend":
                end = bounds(cursor, "week")[1]
                value.date, value.end = end - dt.timedelta(days=1), end
            elif op.kind == "clock":
                hour, minute = op.parts
                value.time = dt.time(hour, minute)
            elif op.kind == "daypart":
                value.daypart = op.unit
            elif op.kind == "note":
                value.notes.append(op.unit)
            elif op.kind == "invalid":
                raise ValueError("invalid expression")
            else:
                raise ValueError("unknown calendar operation")
    except (ValueError, OverflowError, StopIteration):
        value.date, value.end, value.time = None, None, None
        value.alternatives.clear()
        value.invalid = True
        value.notes.append("invalid_date_or_time")
    return value
