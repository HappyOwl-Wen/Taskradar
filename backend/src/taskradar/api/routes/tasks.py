"""Dashboard, tasks, undo and calendar endpoints."""

from __future__ import annotations

import datetime as dt
import logging
import math
from bisect import insort_right
from collections.abc import Callable, Iterable, Iterator
from heapq import nlargest, nsmallest
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import Select, case, func, or_, select
from sqlalchemy.orm import Session, selectinload

from taskradar.api.deps import get_container, thresholds_for
from taskradar.api.errors import ApiError
from taskradar.api.serializers import task_detail, task_summary
from taskradar.container import Container
from taskradar.db.models import CalendarLink, Document, Message, Task, TaskLink, TaskSource
from taskradar.db.session import transaction
from taskradar.deadlines.engine import Thresholds, evaluate, local_today, parse_hhmm
from taskradar.domain.enums import (
    ActionType,
    Actor,
    Category,
    Priority,
    TaskStatus,
    TimeSemantics,
    Urgency,
)
from taskradar.domain.schemas import DueInfo
from taskradar.extraction.quick_add import MAX_QUICK_TEXT, parse_quick_task
from taskradar.extraction.temporal_calendar import wall_time_status
from taskradar.services.calendar_sync import CalendarSyncError
from taskradar.services.tasks import TRASH_RETENTION, TRASH_RETENTION_DAYS

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["tasks"])

_TASK_LOAD = (
    selectinload(Task.sources).selectinload(TaskSource.message).selectinload(Message.source),
    selectinload(Task.sources).selectinload(TaskSource.document).selectinload(Document.source),
    selectinload(Task.calendar_links),
)
_URGENCY_ORDER = {
    u.value: i
    for i, u in enumerate(
        [
            Urgency.OVERDUE,
            Urgency.URGENT,
            Urgency.HIGH,
            Urgency.UPCOMING,
            Urgency.NORMAL,
            Urgency.NO_DEADLINE,
            Urgency.INACTIVE,
        ]
    )
}
_PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}
_TIMESTAMP_SORTS = {"created_at": Task.created_at, "updated_at": Task.updated_at, "detected_at": Task.detected_at}
_RANK_COLUMNS = (Task.id, Task.status, Task.priority, Task.due_date, Task.due_time, Task.timezone)
_RANK_BATCH = 256


def _detail(c: Container, session: Session, task_id: str) -> dict[str, Any]:
    task = session.scalar(select(Task).options(*_TASK_LOAD, selectinload(Task.events)).where(Task.id == task_id))
    if task is None or task.deleted_at is not None:
        raise ApiError("task_not_found", "Task not found", 404)
    links = []
    for kind, other_id, title, status, from_id in session.execute(
        select(TaskLink.kind, Task.id, Task.title, Task.status, TaskLink.task_id)
        .select_from(TaskLink)
        .join(
            Task,
            Task.id == case((TaskLink.task_id == task_id, TaskLink.other_task_id), else_=TaskLink.task_id),
        )
        .where(or_(TaskLink.task_id == task_id, TaskLink.other_task_id == task_id), Task.deleted_at.is_(None))
    ):
        links.append(
            {
                "kind": kind,
                "task_id": other_id,
                "title": title,
                "status": status,
                "direction": "outgoing" if from_id == task_id else "incoming",
            }
        )
    return task_detail(task, now=c.clock(), thresholds=thresholds_for(c), links=links)


def _sort_key(sort: str, item: dict[str, Any]) -> tuple[Any, ...]:
    if sort == "due":
        return (item["effective_deadline"] is None, item["effective_deadline"] or "", _URGENCY_ORDER[item["urgency"]])
    if sort == "priority":
        return (_PRIORITY_ORDER.get(item["priority"], 3), item["effective_deadline"] or "9999")
    if sort == "urgency":
        return (_URGENCY_ORDER[item["urgency"]], item["effective_deadline"] or "9999")
    return (item.get(sort) or "",)


def _ranked_tasks(
    session: Session, stmt: Select[Any], *, now: dt.datetime, thresholds: Thresholds, sort: str = "due"
) -> Iterator[dict[str, Any]]:
    """Stream only ranking fields; load sources, notes and full summaries for the selected rows later."""
    columns = (*_RANK_COLUMNS, _TIMESTAMP_SORTS[sort]) if sort in _TIMESTAMP_SORTS else _RANK_COLUMNS
    rows = session.execute(stmt.with_only_columns(*columns).execution_options(yield_per=_RANK_BATCH)).mappings()
    for row in rows:
        deadline = evaluate(
            status=row["status"],
            due_date=row["due_date"],
            due_time=row["due_time"],
            tz_name=row["timezone"],
            now=now,
            thresholds=thresholds,
        )
        yield {
            "id": row["id"],
            "status": row["status"],
            "priority": row["priority"],
            "due_date": row["due_date"],
            "urgency": deadline.urgency.value,
            "effective_deadline": deadline.effective_deadline.isoformat() if deadline.effective_deadline else None,
            **({sort: row[sort].isoformat()} if sort in _TIMESTAMP_SORTS else {}),
        }


def _summaries(
    session: Session, ids: Iterable[str], *, now: dt.datetime, thresholds: Thresholds
) -> dict[str, dict[str, Any]]:
    selected = list(dict.fromkeys(ids))
    if not selected:
        return {}
    return {
        task.id: task_summary(task, now=now, thresholds=thresholds)
        for task in session.scalars(select(Task).where(Task.id.in_(selected)).options(*_TASK_LOAD))
    }


# ---------------------------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------------------------


_OPEN = ("candidate", "confirmed", "in_progress", "waiting_for_reply")
# The board on the home page: what is still to do, what is being worked on, what waits for someone else.
# Unconfirmed tasks of earlier versions count as "to do" (marked as unconfirmed).
_LANES = {
    "todo": ("confirmed", "candidate"),
    "in_progress": ("in_progress",),
    "waiting_for_reply": ("waiting_for_reply",),
}
_LANE_LIMIT = 8


def _deadline_key(item: dict[str, Any]) -> tuple[Any, ...]:
    return (item["effective_deadline"] or "9999", _PRIORITY_ORDER.get(item["priority"], 3))


def _keep_first(
    entries: list[dict[str, Any]], item: dict[str, Any], *, limit: int, key: Callable[[dict[str, Any]], Any]
) -> None:
    # Dashboard limits are small constants (8/12), so this takes bounded time and space per task.
    if len(entries) < limit or key(item) < key(entries[-1]):
        insort_right(entries, item, key=key)
        if len(entries) > limit:
            entries.pop()


@router.get("/dashboard")
def dashboard(c: Container = Depends(get_container)) -> dict[str, Any]:
    now = c.clock()
    thresholds = thresholds_for(c)
    today = local_today(now, c.settings.get().general.timezone)
    with transaction(c.factory) as session:
        counts = {
            (sample, status): count
            for sample, status, count in session.execute(
                select(Task.sample, Task.status, func.count())
                .where(Task.deleted_at.is_(None))
                .group_by(Task.sample, Task.status)
            )
        }
        active_counts = {status: counts.get((False, status), 0) for status in _OPEN}
        lanes: dict[str, list[dict[str, Any]]] = {lane: [] for lane in _LANES}
        lane_for = {status: lane for lane, statuses in _LANES.items() for status in statuses}
        attention: list[dict[str, Any]] = []
        reason_counts = dict.fromkeys(_ATTENTION_RANK, 0)
        stmt = select(Task).where(Task.deleted_at.is_(None), Task.sample.is_(False), Task.status.in_(_OPEN))
        for entry in _ranked_tasks(session, stmt, now=now, thresholds=thresholds):
            _keep_first(lanes[lane_for[entry["status"]]], entry, limit=_LANE_LIMIT, key=_deadline_key)
            reason = _attention_reason(entry, today=today)
            if reason is not None:
                reason_counts[reason] += 1
                _keep_first(attention, {**entry, "attention": reason}, limit=12, key=_attention_key)
        completed_stmt = select(Task).where(
            Task.deleted_at.is_(None),
            Task.sample.is_(False),
            Task.status == "completed",
            Task.completed_at >= now - dt.timedelta(days=7),
        )
        completed_count = (
            session.scalar(completed_stmt.with_only_columns(func.count(), maintain_column_froms=True)) or 0
        )
        completed_ids = list(
            session.scalars(completed_stmt.with_only_columns(Task.id).order_by(Task.completed_at.desc()).limit(5))
        )
        summaries = _summaries(
            session,
            [i["id"] for entries in lanes.values() for i in entries] + [i["id"] for i in attention] + completed_ids,
            now=now,
            thresholds=thresholds,
        )
    return {
        "today": today.isoformat(),
        "counts": {
            **reason_counts,
            "active": sum(active_counts.values()),
            **{lane: sum(active_counts[s] for s in statuses) for lane, statuses in _LANES.items()},
            "unconfirmed": active_counts["candidate"],
            "completed_7d": completed_count,
            "sample_open": sum(counts.get((True, s), 0) for s in _OPEN),
        },
        "attention": [{**summaries[i["id"]], "attention": i["attention"]} for i in attention],
        "attention_total": sum(reason_counts.values()),
        "lanes": {lane: [summaries[i["id"]] for i in entries] for lane, entries in lanes.items()},
        "completed_recent": [summaries[task_id] for task_id in completed_ids],
        "notifications_unread": c.notifications.unread_count(),
    }


_ATTENTION_RANK = {"overdue": 0, "due_today": 1, "due_tomorrow": 2, "due_soon": 3}


def _attention_reason(item: dict[str, Any], *, today: dt.date) -> str | None:
    """Open tasks whose time is (nearly) up, most pressing first: overdue, due today, tomorrow, within a week."""
    due = item["due_date"]
    if item["urgency"] == Urgency.OVERDUE.value:
        return "overdue"
    if due is None:
        return None
    days = (due - today).days
    if days <= 0:
        return "due_today"
    if days == 1:
        return "due_tomorrow"
    return "due_soon" if days <= 7 else None


def _attention_key(item: dict[str, Any]) -> tuple[Any, ...]:
    return (_ATTENTION_RANK[item["attention"]], item["effective_deadline"] or "9999")


# ---------------------------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------------------------


@router.get("/tasks")
def list_tasks(
    status: list[str] = Query(default=[]),
    category: list[str] = Query(default=[]),
    urgency: list[str] = Query(default=[]),
    q: str | None = None,
    sample: bool | None = None,
    # "Created by me": to-dos the user wrote (not found in mails or files by earlier versions).
    manual: bool | None = None,
    # "Google Calendar": tasks with an event in TaskRadar's Google calendar.
    in_calendar: bool | None = None,
    sort: Literal["due", "urgency", "priority", "created_at", "updated_at", "detected_at"] = "due",
    order: Literal["asc", "desc"] = "asc",
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    c: Container = Depends(get_container),
) -> dict[str, Any]:
    now = c.clock()
    thresholds = thresholds_for(c)
    with transaction(c.factory) as session:
        stmt = select(Task).where(Task.deleted_at.is_(None))
        if status:
            stmt = stmt.where(Task.status.in_(status))
        if category:
            stmt = stmt.where(Task.category.in_(category))
        if sample is not None:
            stmt = stmt.where(Task.sample.is_(sample))
        if manual is not None:
            stmt = stmt.where(Task.manual.is_(manual))
        if in_calendar is not None:
            linked = Task.calendar_links.any(CalendarLink.status != "removed")
            stmt = stmt.where(linked if in_calendar else ~linked)
        if q:
            like = f"%{q.strip()}%"
            stmt = stmt.where(
                or_(
                    Task.title.ilike(like),
                    Task.description.ilike(like),
                    Task.action_required.ilike(like),
                    Task.due_text.ilike(like),
                )
            )
        if sort in _TIMESTAMP_SORTS and not urgency:
            total = session.scalar(stmt.with_only_columns(func.count(), maintain_column_froms=True)) or 0
            column = _TIMESTAMP_SORTS[sort]
            page = stmt.with_only_columns(Task.id).order_by(column.desc() if order == "desc" else column.asc())
            ids = list(session.scalars(page.offset(offset).limit(limit)))
            summaries = _summaries(session, ids, now=now, thresholds=thresholds)
            return {"items": [summaries[task_id] for task_id in ids], "total": total}

        total = 0
        wanted_urgency = set(urgency)

        def matching() -> Iterator[dict[str, Any]]:
            nonlocal total
            for entry in _ranked_tasks(session, stmt, now=now, thresholds=thresholds, sort=sort):
                if not wanted_urgency or entry["urgency"] in wanted_urgency:
                    total += 1
                    yield entry

        select_page = nlargest if order == "desc" else nsmallest
        ranked = select_page(offset + limit, matching(), key=lambda i: _sort_key(sort, i))
        ids = [i["id"] for i in ranked[offset:]]
        summaries = _summaries(session, ids, now=now, thresholds=thresholds)
        return {"items": [summaries[task_id] for task_id in ids], "total": total}


class LocalTimeBody(BaseModel):
    timezone: str | None = Field(default=None, max_length=100)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise ValueError("Unknown IANA timezone") from exc
        return value


class TaskCreate(LocalTimeBody):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    action_required: str = ""
    category: Category = Category.OTHER
    priority: Priority = Priority.MEDIUM
    due_date: dt.date | None = None
    due_time: dt.time | None = None
    time_semantics: TimeSemantics = TimeSemantics.DEADLINE
    action_type: ActionType = ActionType.OTHER
    # The user's own wording of the date (from quick entry), shown as "original wording".
    due_text: str | None = Field(default=None, max_length=200)
    # Test data: never counted, reminded or written to the calendar.
    sample: bool = False
    # Recorded in the existing creation event; uncertain proposals never become saved due dates implicitly.
    time_resolution: Literal["explicit", "parsed", "confirmed", "overridden"] = "explicit"


class QuickParseBody(LocalTimeBody):
    text: str = Field(min_length=1, max_length=MAX_QUICK_TEXT)


@router.post("/tasks/quick-parse")
def quick_parse(body: QuickParseBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    """Propose title and deadline for a one-line to-do ("周五前交房租"); nothing is saved."""
    timezone = body.timezone or c.settings.get().general.timezone
    quick = parse_quick_task(body.text, now=c.clock(), tz=timezone)
    due = quick.due
    return {
        "title": quick.title,
        "category": quick.category.value,
        "action_type": quick.action_type.value,
        "due_date": due.date.isoformat() if due and due.date else None,
        "due_time": due.time.strftime("%H:%M") if due and due.time else None,
        "due_text": due.text if due else None,
        "time_semantics": due.semantics.value if due else TimeSemantics.DEADLINE.value,
        "ambiguous": quick.temporal.needs_confirmation,
        "alternatives": list(
            dict.fromkeys(
                candidate.value.date.isoformat()
                for candidate in quick.temporal.candidates
                if candidate.value.date and not candidate.value.end and candidate.needs_confirmation
            )
        ),
        "temporal": quick.temporal.payload(" ".join(body.text.split())),
        "timezone": timezone,
    }


@router.post("/tasks", status_code=201)
def create_task(body: TaskCreate, c: Container = Depends(get_container)) -> dict[str, Any]:
    timezone = body.timezone or c.settings.get().general.timezone
    if body.due_time and body.due_date:
        status = wall_time_status(body.due_date, body.due_time, timezone)
        if status != "valid":
            raise ApiError(status, "Choose an unambiguous local time or leave the time empty", 422)
    due_text = (body.due_text or "").strip() or None
    due = DueInfo(
        date=body.due_date,
        time=body.due_time if body.due_date else None,
        semantics=body.time_semantics,
        text=due_text if body.due_date else None,
    )
    with transaction(c.factory) as session:
        task = c.tasks.create(
            session,
            title=body.title,
            due=due,
            timezone=timezone,
            description=body.description,
            category=body.category,
            action_type=body.action_type,
            action_required=body.action_required,
            priority=body.priority,
            sample=body.sample,
            time_resolution=body.time_resolution,
        )
        task_id = task.id
    _maybe_auto_calendar(c, task_id)  # only when the user switched on automatic calendar entries
    with transaction(c.factory) as session:
        return _detail(c, session, task_id)


@router.get("/tasks/{task_id}")
def get_task(task_id: str, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        return _detail(c, session, task_id)


class TaskUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    action_required: str | None = None
    category: Category | None = None
    priority: Priority | None = None
    due_date: dt.date | None = None
    due_time: str | None = None
    time_semantics: TimeSemantics | None = None
    clear_due: bool = False


@router.patch("/tasks/{task_id}")
def update_task(task_id: str, body: TaskUpdate, c: Container = Depends(get_container)) -> dict[str, Any]:
    changes = body.model_dump(exclude_unset=True, exclude={"clear_due"})
    if body.clear_due:
        changes["due_date"] = None
        changes["due_time"] = None
    elif "due_date" in changes and "due_time" not in changes:
        pass
    with transaction(c.factory) as session:
        task = c.tasks.get(session, task_id)
        if "due_time" in changes and changes.get("due_time") and not (changes.get("due_date") or task.due_date):
            raise ApiError("time_without_date", "A time requires a date", 422)
        c.tasks.update_fields(session, task, changes, actor=Actor.USER, lock=True)
        c.calendar.mark_out_of_sync(session, task)
    with transaction(c.factory) as session:
        return _detail(c, session, task_id)


class StatusBody(BaseModel):
    status: TaskStatus
    note: str | None = Field(default=None, max_length=500)


def _maybe_auto_calendar(c: Container, task_id: str) -> None:
    """The opt-in rule "add new tasks to Google Calendar": once per task, never against the user's own choice."""
    cfg = c.settings.get().calendar
    if not cfg.auto_sync_enabled or not c.oauth.connected("calendar"):
        return
    with transaction(c.factory) as session:
        task = c.tasks.get(session, task_id)
        if task.sample:
            return  # test data never reaches the real calendar
        if task.calendar_links:
            return  # already in the calendar, or the user took it out again: that stays so
        if task.due_date is None or (cfg.auto_sync_categories and task.category not in cfg.auto_sync_categories):
            return
    try:
        c.calendar.sync(task_id, user_confirmed=False, auto_rule=True)
    except CalendarSyncError as exc:
        log.info("Automatic calendar sync skipped: %s", exc.code)


def _remove_calendar_events(c: Container, task_ids: Iterable[str]) -> list[str]:
    """Opt-in rule (on by default): a task the user dismisses or deletes leaves the calendar too.

    Returns the ids whose event could not be removed (e.g. offline); those tasks keep their link, so the
    removal can be retried from the task page.
    """
    ids = list(task_ids)
    if not ids or not c.settings.get().calendar.remove_on_dismiss:
        return []
    with transaction(c.factory) as session:
        linked = list(
            session.scalars(
                select(CalendarLink.task_id).where(CalendarLink.task_id.in_(ids), CalendarLink.status != "removed")
            )
        )
    failed: list[str] = []
    for task_id in linked:
        try:
            c.calendar.remove(task_id, user_confirmed=False, auto_rule=True)
        except CalendarSyncError as exc:
            log.warning("Calendar event of task %s was not removed: %s", task_id, exc.code)
            failed.append(task_id)
    return failed


@router.post("/tasks/{task_id}/status")
def change_status(task_id: str, body: StatusBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        task = c.tasks.get(session, task_id)
        event = c.tasks.change_status(session, task, body.status, actor=Actor.USER, reason=body.note)
        undo_event_id = event.id if event is not None else None
    not_removed: list[str] = []
    if body.status == TaskStatus.DISMISSED:
        not_removed = _remove_calendar_events(c, [task_id])
    elif body.status.value in _OPEN:
        _maybe_auto_calendar(c, task_id)
    with transaction(c.factory) as session:
        detail = _detail(c, session, task_id)
    if not_removed:
        detail["calendar_warning"] = "event_not_removed"
    detail["undo_event_id"] = undo_event_id  # the change just made, for an "undo" button
    return detail


class BatchBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    action: Literal["todo", "in_progress", "waiting_for_reply", "complete", "dismiss", "delete"]


_BATCH_STATUS = {
    "todo": TaskStatus.CONFIRMED,
    "in_progress": TaskStatus.IN_PROGRESS,
    "waiting_for_reply": TaskStatus.WAITING_FOR_REPLY,
    "complete": TaskStatus.COMPLETED,
    "dismiss": TaskStatus.DISMISSED,
}


@router.post("/tasks/batch")
def batch(body: BatchBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    ids = list(dict.fromkeys(body.ids))
    if body.action == "delete":
        return _delete_tasks(c, ids)
    target = _BATCH_STATUS[body.action]
    changed: list[str] = []
    undo_event_ids: list[int] = []
    with transaction(c.factory) as session:
        for task_id in ids:
            task = c.tasks.get(session, task_id)
            event = c.tasks.change_status(session, task, target, actor=Actor.USER, reason=f"batch:{body.action}")
            if event is not None:
                changed.append(task_id)
                undo_event_ids.append(event.id)
    not_removed: list[str] = []
    if target == TaskStatus.DISMISSED:
        not_removed = _remove_calendar_events(c, changed)
    else:
        for task_id in changed:
            _maybe_auto_calendar(c, task_id)
    return {
        "changed": changed,
        "count": len(changed),
        "calendar_not_removed": not_removed,
        "undo_event_ids": undo_event_ids,
    }


class RescheduleBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    due_date: dt.date


def _due_label(due_date: dt.date | None, due_time: str | None) -> str:
    if due_date is None:
        return "无截止日期"
    return f"{due_date.isoformat()} {due_time}" if due_time else due_date.isoformat()


@router.post("/tasks/batch/reschedule")
def batch_reschedule(body: RescheduleBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    """Move open tasks to one day when plans change; a time of day stays as it was. Each move can be undone."""
    target = body.due_date
    changed: list[str] = []
    undo_event_ids: list[int] = []
    skipped: list[dict[str, str]] = []
    calendar_outdated: list[str] = []
    with transaction(c.factory) as session:
        for task_id in dict.fromkeys(body.ids):
            task = c.tasks.get(session, task_id)
            if task.status not in _OPEN:
                skipped.append({"id": task.id, "title": task.title, "reason": "closed"})
                continue
            clock = parse_hhmm(task.due_time)
            if clock is not None:
                # 02:30 in the night the clocks change does not exist (or exists twice): the user picks that time.
                wall_time = wall_time_status(target, clock, task.timezone)
                if wall_time != "valid":
                    skipped.append({"id": task.id, "title": task.title, "reason": wall_time})
                    continue
            event = c.tasks.update_fields(
                session,
                task,
                {"due_date": target},
                actor=Actor.USER,
                reason="batch:reschedule",
                lock=True,
                summary=f"批量改期：{_due_label(task.due_date, task.due_time)} → {_due_label(target, task.due_time)}",
            )
            if event is None:
                continue  # already on that day
            changed.append(task.id)
            undo_event_ids.append(event.id)
            c.calendar.mark_out_of_sync(session, task)
            if any(link.status == "out_of_sync" for link in task.calendar_links):
                calendar_outdated.append(task.id)  # Google Calendar still shows the old day
    return {
        "changed": changed,
        "count": len(changed),
        "due_date": target.isoformat(),
        "undo_event_ids": undo_event_ids,
        "skipped": skipped,
        "calendar_outdated": calendar_outdated,
    }


def _delete_tasks(c: Container, ids: list[str]) -> dict[str, Any]:
    """Keep tasks and history for 30 days; honour the existing Google Calendar removal setting."""
    with c.workspace.lock:
        with transaction(c.factory) as session:
            for task_id in ids:
                c.tasks.get(session, task_id)  # Validate the whole batch before any side effects.
        not_removed = _remove_calendar_events(c, ids)
        with transaction(c.factory) as session:
            events = [c.tasks.trash(session, c.tasks.get(session, task_id)).id for task_id in ids]
    return {"deleted": ids, "count": len(ids), "calendar_not_removed": not_removed, "undo_event_ids": events}


@router.get("/trash")
def list_trash(
    q: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    c: Container = Depends(get_container),
) -> dict[str, Any]:
    with c.workspace.lock:
        c.data.purge_expired_tasks()
    now = c.clock()
    with transaction(c.factory) as session:
        stmt = select(Task).where(Task.deleted_at > now - TRASH_RETENTION)
        if q and q.strip():
            like = f"%{q.strip()}%"
            stmt = stmt.where(or_(Task.title.ilike(like), Task.description.ilike(like)))
        total = session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        tasks = session.scalars(stmt.order_by(Task.deleted_at.desc(), Task.id).offset(offset).limit(limit)).all()
        items = []
        for task in tasks:
            assert task.deleted_at is not None
            expires_at = task.deleted_at + TRASH_RETENTION
            items.append(
                {
                    "id": task.id,
                    "title": task.title,
                    "description": task.description,
                    "status": task.status,
                    "category": task.category,
                    "due_date": task.due_date.isoformat() if task.due_date else None,
                    "due_time": task.due_time,
                    "deleted_at": task.deleted_at.isoformat(),
                    "expires_at": expires_at.isoformat(),
                    "days_remaining": max(1, math.ceil((expires_at - now).total_seconds() / 86400)),
                }
            )
    return {"items": items, "total": total, "retention_days": TRASH_RETENTION_DAYS}


class TrashBatchBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    action: Literal["restore", "delete"]
    confirm: bool = False


@router.post("/trash/batch")
def trash_batch(body: TrashBatchBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    if body.action == "delete" and not body.confirm:
        raise ApiError("confirmation_required", "Confirm permanent deletion from the recycle bin", 400)
    ids = list(dict.fromkeys(body.ids))
    with c.workspace.lock, transaction(c.factory) as session:
        tasks = [c.tasks.get_trashed(session, task_id) for task_id in ids]
        for task in tasks:
            if body.action == "restore":
                c.tasks.restore(session, task)
            else:
                session.delete(task)
    return {"changed": ids, "count": len(ids)}


class SampleBody(BaseModel):
    sample: bool


@router.post("/tasks/{task_id}/sample")
def set_sample(task_id: str, body: SampleBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    """Mark a task as test data (or back as a real task). Undoable."""
    with transaction(c.factory) as session:
        task = c.tasks.get(session, task_id)
        event = c.tasks.set_sample(session, task, body.sample, actor=Actor.USER)
        in_calendar = any(link.status != "removed" for link in task.calendar_links)
        undo_event_id = event.id if event is not None else None
    with transaction(c.factory) as session:
        detail = _detail(c, session, task_id)
    if body.sample and in_calendar:
        detail["calendar_warning"] = "sample_in_calendar"  # an earlier event stays until the user removes it
    detail["undo_event_id"] = undo_event_id
    return detail


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, c: Container = Depends(get_container)) -> dict[str, Any]:
    result = _delete_tasks(c, [task_id])
    response = {"deleted": task_id, "undo_event_id": result["undo_event_ids"][0]}
    if result["calendar_not_removed"]:
        response["calendar_warning"] = "event_not_removed"
    return response


@router.post("/events/{event_id}/undo")
def undo(event_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    with c.workspace.lock, transaction(c.factory) as session:
        revert = c.tasks.revert_event(session, event_id, actor=Actor.USER)
        task_id = revert.task_id
    with transaction(c.factory) as session:
        return _detail(c, session, task_id)


# ---------------------------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------------------------


@router.get("/tasks/{task_id}/calendar/preview")
def calendar_preview(task_id: str, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.calendar.preview(task_id)


class CalendarSyncBody(BaseModel):
    confirm: bool = False


@router.post("/tasks/{task_id}/calendar")
def calendar_sync(task_id: str, body: CalendarSyncBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    if not body.confirm:
        raise ApiError("confirmation_required", "Please confirm the preview before writing to Google Calendar", 400)
    return c.calendar.sync(task_id, user_confirmed=True)


@router.post("/tasks/{task_id}/calendar/remove")
def calendar_remove(task_id: str, body: CalendarSyncBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    if not body.confirm:
        raise ApiError("confirmation_required", "Please confirm removing the event from Google Calendar", 400)
    return c.calendar.remove(task_id, user_confirmed=True)
