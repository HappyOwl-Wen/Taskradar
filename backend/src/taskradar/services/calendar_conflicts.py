"""Overlap warnings and reserved buffers for the calendar workspace.

A conflict is a warning and never blocks a save. Busy time is a timed work block, a timed Google event of a
selected calendar that is neither marked free nor declined, or a to-do with an appointment time (it lasts an
assumed hour, as its Google copy does), each widened by the buffers reserved around it. Deadlines and all-day
items mark a day rather than a span of time and never conflict. Google events come from the freshest cached
window that covers the checked time; a selected calendar without one is reported as unchecked instead of being
guessed from older data.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select

from taskradar.db.calendar_models import (
    CalendarBuffer,
    CalendarDraft,
    CalendarSource,
    CalendarWindow,
    GoogleEvent,
    WorkBlock,
)
from taskradar.db.models import CalendarLink, Task
from taskradar.db.session import transaction
from taskradar.domain.calendar import local_instant
from taskradar.domain.calendar_buffers import MAX_BUFFER_MINUTES, Buffer
from taskradar.domain.enums import TaskStatus, TimeSemantics
from taskradar.services.calendar_sync import APPOINTMENT_DEFAULT_MINUTES, CalendarSyncError

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from taskradar.services.calendar_workspace import CalendarWorkspace

# How far the buffers of another item can reach into the checked time.
REACH = dt.timedelta(minutes=MAX_BUFFER_MINUTES)
# A suggested start is rounded up to whole five minutes.
STEP_MINUTES = 5


def work_key(block_id: str) -> str:
    return f"work:{block_id}"


def event_key(calendar_id: str, event_id: str) -> str:
    return f"google:{calendar_id}:{event_id}"


def series_key(calendar_id: str, recurring_event_id: str) -> str:
    return f"series:{calendar_id}:{recurring_event_id}"


def buffer_dict(row: CalendarBuffer | None, *, series: bool = False) -> dict[str, Any] | None:
    if row is None or not (row.before_minutes or row.after_minutes):
        return None
    return {
        "before_minutes": row.before_minutes,
        "before_kind": row.before_kind,
        "after_minutes": row.after_minutes,
        "after_kind": row.after_kind,
        "series": series,
    }


def event_buffer(rows: dict[str, CalendarBuffer], calendar_id: str, event: dict[str, Any]) -> dict[str, Any] | None:
    """An occurrence's own row wins over its series; a stored zero row switches the series buffer off for it."""
    own = rows.get(event_key(calendar_id, event.get("id", "")))
    if own is not None:
        return buffer_dict(own)
    recurring = event.get("recurringEventId")
    return buffer_dict(rows.get(series_key(calendar_id, recurring)), series=True) if recurring else None


def all_buffers(session: Session) -> dict[str, CalendarBuffer]:
    return {row.item_key: row for row in session.scalars(select(CalendarBuffer))}


def attach_buffers(session: Session, items: list[dict[str, Any]]) -> None:
    """Adds `buffer` to the timed work blocks and Google events of a calendar view."""
    rows = all_buffers(session)
    for item in items:
        if item["kind"] == "work":
            item["buffer"] = buffer_dict(rows.get(work_key(item["work_block_id"])))
        elif item["kind"] == "google" and not item["all_day"]:
            item["buffer"] = event_buffer(rows, item["calendar_id"], item.get("remote") or {"id": item["event_id"]})


def store_buffer(session: Session, key: str, buffer: Buffer | None, *, keep_zero: bool = False) -> None:
    row = session.get(CalendarBuffer, key)
    if buffer is None or (buffer.empty and not keep_zero):
        if row is not None:
            session.delete(row)
        return
    if row is None:
        row = CalendarBuffer(item_key=key)
        session.add(row)
    row.before_minutes, row.before_kind = buffer.before_minutes, buffer.before_kind
    row.after_minutes, row.after_kind = buffer.after_minutes, buffer.after_kind


def apply_draft_buffer(session: Session, draft: CalendarDraft, result: dict[str, Any]) -> None:
    """A submitted Google draft carries the buffers typed with it; they stay on this computer."""
    typed = draft.payload.get("buffer")
    if draft.work_block_id:
        # A published work block keeps one identity in the calendar: the block, not its Google copy.
        if draft.operation != "delete" and typed is not None:
            store_buffer(session, work_key(draft.work_block_id), Buffer.model_validate(typed))
        return
    key = event_key(draft.calendar_id, result["id"])
    if draft.operation == "delete" or result.get("status") == "cancelled":
        store_buffer(session, key, None)
    elif typed is not None:
        store_buffer(session, key, Buffer.model_validate(typed))


@dataclass(frozen=True)
class Busy:
    """An item that occupies time, with the time reserved before and after it."""

    id: str
    kind: str
    title: str
    start: dt.datetime
    end: dt.datetime
    source_name: str = "local"
    color: str = ""
    before: dt.timedelta = dt.timedelta(0)
    after: dt.timedelta = dt.timedelta(0)
    before_kind: str = "prep"
    after_kind: str = "rest"

    @property
    def lo(self) -> dt.datetime:
        return self.start - self.before

    @property
    def hi(self) -> dt.datetime:
        return self.end + self.after


def _widths(buffer: dict[str, Any] | None) -> dict[str, Any]:
    if not buffer:
        return {}
    return {
        "before": dt.timedelta(minutes=buffer["before_minutes"]),
        "after": dt.timedelta(minutes=buffer["after_minutes"]),
        "before_kind": buffer["before_kind"],
        "after_kind": buffer["after_kind"],
    }


def _shared(a: tuple[dt.datetime, dt.datetime], b: tuple[dt.datetime, dt.datetime]) -> dt.timedelta:
    return max(dt.timedelta(0), min(a[1], b[1]) - max(a[0], b[0]))


def describe(own: Busy, other: Busy) -> dict[str, Any] | None:
    """How `other` meets the planned item: the items themselves overlap, or only reserved time does."""
    found: tuple[dt.timedelta, dict[str, str] | None] | None = None
    core = _shared((own.start, own.end), (other.start, other.end))
    if core:
        found = (core, None)
    else:
        for owner, side, item, zone, kind in (
            ("other", "before", own, (other.lo, other.start), other.before_kind),
            ("other", "after", own, (other.end, other.hi), other.after_kind),
            ("self", "before", other, (own.lo, own.start), own.before_kind),
            ("self", "after", other, (own.end, own.hi), own.after_kind),
        ):
            shared = _shared((item.start, item.end), zone)
            if shared:
                found = (shared, {"owner": owner, "side": side, "kind": kind})
                break
    if found is None:
        # Only the two buffers meet, e.g. the rest after one meeting and the preparation for the next.
        shared = _shared((own.lo, own.hi), (other.lo, other.hi))
        if not shared:
            return None
        side = "after" if own.start <= other.start else "before"
        kind = own.after_kind if side == "after" else own.before_kind
        found = (shared, {"owner": "both", "side": side, "kind": kind})
    delta, buffer = found
    return {
        "id": other.id,
        "kind": other.kind,
        "title": other.title,
        "start": other.start.isoformat(),
        "end": other.end.isoformat(),
        "source_name": other.source_name,
        "color": other.color,
        "type": "buffer" if buffer else "overlap",
        "minutes": math.ceil(delta.total_seconds() / 60),
        "buffer": buffer,
    }


def _ceil_step(value: dt.datetime) -> dt.datetime:
    value = value.astimezone(dt.UTC)
    whole = value.replace(second=0, microsecond=0)
    if whole < value:
        whole += dt.timedelta(minutes=1)
    return whole + dt.timedelta(minutes=-whole.minute % STEP_MINUTES)


def next_free(own: Busy, busy: list[Busy], day_end: dt.datetime) -> dict[str, str] | None:
    """The first later start on the same day at which the item and its buffers meet nothing known."""
    length = own.end - own.start
    start = own.start
    # Cache widened bounds once. In start order, passed intervals can never block a later start.
    for lo, hi in sorted((b.lo, b.hi) for b in busy):
        if lo >= start + length + own.after:
            break
        if hi > lo and hi > start - own.before:
            start = _ceil_step(hi + own.before)
            if start + length > day_end:
                return None
    if start == own.start or start + length > day_end:
        return None
    return {"start": start.isoformat(), "end": (start + length).isoformat()}


def _timed(event: dict[str, Any], zone: ZoneInfo) -> tuple[dt.datetime, dt.datetime] | None:
    """The time a Google event occupies: timed, not cancelled, not marked free and not declined."""
    start, end = event.get("start", {}), event.get("end", {})
    if event.get("status") == "cancelled" or "dateTime" not in start or "dateTime" not in end:
        return None
    if event.get("transparency") == "transparent":
        return None
    if any(a.get("self") and a.get("responseStatus") == "declined" for a in event.get("attendees", [])):
        return None
    try:
        a, b = dt.datetime.fromisoformat(start["dateTime"]), dt.datetime.fromisoformat(end["dateTime"])
    except ValueError:
        return None
    return (a if a.tzinfo else a.replace(tzinfo=zone)), (b if b.tzinfo else b.replace(tzinfo=zone))


class CalendarConflicts:
    def __init__(self, workspace: CalendarWorkspace) -> None:
        self.w = workspace
        self.c = workspace.c

    def check(
        self,
        *,
        start: str,
        end: str,
        timezone: str,
        start_fold: int | None = None,
        end_fold: int | None = None,
        buffer: Buffer | None = None,
        exclude: list[str] | None = None,
    ) -> dict[str, Any]:
        """Items that meet a planned time, the selected calendars that could not be checked, and a free slot."""
        try:
            zone = ZoneInfo(timezone)
            own_start = local_instant(start, timezone, start_fold)
            own_end = local_instant(end, timezone, end_fold)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise CalendarSyncError("invalid_event_time", str(exc) or "Invalid time", 422) from exc
        if own_end <= own_start:
            raise CalendarSyncError("invalid_event_time", "End must be after start", 422)
        own = Busy(
            id="", kind="new", title="", start=own_start, end=own_end, **_widths((buffer or Buffer()).model_dump())
        )
        day_end = dt.datetime.combine(own_start.astimezone(zone).date() + dt.timedelta(days=1), dt.time(), zone)
        with transaction(self.c.factory) as session:
            busy, unchecked = self._busy(session, own, max(own.hi, day_end + own.after), set(exclude or ()))
        met = [(other, found) for other in busy if (found := describe(own, other))]
        met.sort(key=lambda pair: (pair[1]["type"] != "overlap", pair[0].start))
        return {
            "conflicts": [found for _, found in met],
            "unchecked": unchecked,
            "suggestion": next_free(own, busy, day_end) if met else None,
        }

    def _busy(
        self, session: Session, own: Busy, horizon: dt.datetime, exclude: set[str]
    ) -> tuple[list[Busy], list[str]]:
        rows = all_buffers(session)
        lo, hi = own.lo - REACH, horizon + REACH
        # A published work block stands for its Google event; a legacy task mirror is a deadline marker.
        represented: set[tuple[str | None, str | None]] = {
            (calendar_id, event_id)
            for calendar_id, event_id in session.execute(select(CalendarLink.calendar_id, CalendarLink.event_id))
        }
        linked = select(WorkBlock.id, WorkBlock.calendar_id, WorkBlock.event_id).where(WorkBlock.event_id.isnot(None))
        for block_id, calendar_id, event_id in session.execute(linked):
            represented.add((calendar_id, event_id))
            if work_key(block_id) in exclude and calendar_id and event_id:
                exclude.add(event_key(calendar_id, event_id))
        busy: list[Busy] = []
        for block in session.scalars(select(WorkBlock).where(WorkBlock.start_at < hi, WorkBlock.end_at > lo)):
            key = work_key(block.id)
            if key not in exclude:
                busy.append(
                    Busy(
                        id=key,
                        kind="work",
                        title=block.title,
                        start=block.start_at,
                        end=block.end_at,
                        **_widths(buffer_dict(rows.get(key))),
                    )
                )
        busy.extend(self._appointments(session, lo, hi, exclude))
        unchecked: list[str] = []
        sources = select(CalendarSource).where(CalendarSource.selected.is_(True)).order_by(CalendarSource.summary)
        for source in session.scalars(sources):
            window = self._window(session, source.id, own.lo, own.hi)
            if window is None:
                unchecked.append(source.summary)
                continue
            zone = ZoneInfo(window.timezone)
            for event in window.events:
                times = _timed(event, zone)
                key = event_key(source.id, event.get("id", ""))
                if times is None or (source.id, event.get("id")) in represented or key in exclude:
                    continue
                if times[0] < hi and times[1] > lo:
                    busy.append(
                        Busy(
                            id=key,
                            kind="google",
                            title=event.get("summary", ""),
                            start=times[0],
                            end=times[1],
                            source_name=source.summary,
                            color=source.color,
                            **_widths(event_buffer(rows, source.id, event)),
                        )
                    )
        return busy, unchecked

    @staticmethod
    def _appointments(session: Session, lo: dt.datetime, hi: dt.datetime, exclude: set[str]) -> list[Busy]:
        """Open to-dos that happen at a time (a meeting, an exam); a deadline only has to be met before it."""
        day = dt.timedelta(days=1)
        length = dt.timedelta(minutes=APPOINTMENT_DEFAULT_MINUTES)
        tasks = session.execute(
            select(Task.id, Task.title, Task.due_date, Task.due_time, Task.timezone).where(
                Task.time_semantics == TimeSemantics.APPOINTMENT,
                Task.due_time.isnot(None),
                Task.due_date >= (lo - day).date(),
                Task.due_date <= (hi + day).date(),
                Task.status.notin_([TaskStatus.COMPLETED, TaskStatus.DISMISSED]),
                Task.sample.is_(False),
                Task.deleted_at.is_(None),
            )
        )
        found = []
        for task_id, title, date, time, timezone in tasks:
            if date is None or time is None or f"task:{task_id}" in exclude:
                continue
            start = dt.datetime.combine(date, dt.time.fromisoformat(time), ZoneInfo(timezone))
            if start < hi and start + length > lo:
                found.append(
                    Busy(id=f"task:{task_id}", kind="appointment", title=title, start=start, end=start + length)
                )
        return found

    @staticmethod
    def _window(session: Session, calendar_id: str, lo: dt.datetime, hi: dt.datetime) -> CalendarWindow | None:
        """The freshest complete snapshot that covers the whole checked time (its dates are local days)."""
        day = dt.timedelta(days=1)
        # Select only metadata while choosing a window; historical event payloads can be large.
        covering = (
            window
            for window in session.execute(
                select(
                    CalendarWindow.id,
                    CalendarWindow.start_date,
                    CalendarWindow.end_date,
                    CalendarWindow.timezone,
                    CalendarWindow.last_synced_at,
                )
                .where(
                    CalendarWindow.calendar_id == calendar_id,
                    CalendarWindow.last_synced_at.isnot(None),
                    CalendarWindow.start_date <= (lo.astimezone(dt.UTC) + day).date(),
                    CalendarWindow.end_date >= (hi.astimezone(dt.UTC) - day).date(),
                )
                .execution_options(yield_per=256)
            )
            if dt.datetime.combine(window.start_date, dt.time(), ZoneInfo(window.timezone)) <= lo
            and dt.datetime.combine(window.end_date, dt.time(), ZoneInfo(window.timezone)) >= hi
        )
        newest = max(covering, key=lambda w: w.last_synced_at, default=None)
        return session.get(CalendarWindow, newest.id) if newest is not None else None

    def set_buffer(
        self,
        buffer: Buffer,
        *,
        work_block_id: str | None = None,
        calendar_id: str | None = None,
        event_id: str | None = None,
        series: bool = False,
    ) -> dict[str, Any] | None:
        """Reserve time around an existing item; any timed item can carry buffers, even a read-only meeting."""
        with self.w.lock, transaction(self.c.factory) as session:
            if work_block_id:
                if session.get(WorkBlock, work_block_id) is None:
                    raise LookupError("Work block not found")
                store_buffer(session, work_key(work_block_id), buffer)
                session.flush()
                return buffer_dict(session.get(CalendarBuffer, work_key(work_block_id)))
            if not calendar_id or not event_id:
                raise LookupError("Calendar event not found")
            source = session.get(CalendarSource, calendar_id)
            if source is None or not source.selected:
                raise CalendarSyncError("calendar_not_selected", "Select and refresh this calendar first", 409)
            event = self._cached_event(session, calendar_id, event_id)
            if event is None:
                raise LookupError("Refresh this calendar first")
            if "dateTime" not in event.get("start", {}):
                raise CalendarSyncError("buffer_requires_time", "An all-day event has no time to reserve around", 422)
            recurring = event.get("recurringEventId")
            if series:
                if not recurring:
                    raise CalendarSyncError("not_recurring", "This event does not repeat", 422)
                store_buffer(session, series_key(calendar_id, recurring), buffer)
                # The occurrence follows its series again.
                store_buffer(session, event_key(calendar_id, event_id), None)
            else:
                inherits = bool(recurring and session.get(CalendarBuffer, series_key(calendar_id, recurring)))
                store_buffer(session, event_key(calendar_id, event_id), buffer, keep_zero=inherits)
            session.flush()
            keys = [event_key(calendar_id, event_id)]
            if recurring:
                keys.append(series_key(calendar_id, recurring))
            rows = {
                row.item_key: row
                for row in session.scalars(select(CalendarBuffer).where(CalendarBuffer.item_key.in_(keys)))
            }
            return event_buffer(rows, calendar_id, event)

    @staticmethod
    def _cached_event(session: Session, calendar_id: str, event_id: str) -> dict[str, Any] | None:
        row = session.get(GoogleEvent, (calendar_id, event_id))
        if row is not None and row.payload.get("status") != "cancelled":
            return row.payload
        # Unchanged occurrences of a recurring event exist only in the expanded windows.
        windows = session.scalars(
            select(CalendarWindow)
            .where(CalendarWindow.calendar_id == calendar_id)
            .order_by(CalendarWindow.last_synced_at.desc())
        )
        return next(
            (e for w in windows for e in w.events if e.get("id") == event_id and e.get("status") != "cancelled"),
            None,
        )
