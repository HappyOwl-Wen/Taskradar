"""Dashboard, tasks, undo and calendar endpoints."""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Iterable
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from taskradar.api.deps import get_container, thresholds_for
from taskradar.api.errors import ApiError
from taskradar.api.serializers import task_detail, task_summary
from taskradar.container import Container
from taskradar.db.models import CalendarLink, Document, Message, Task, TaskLink, TaskSource
from taskradar.db.session import transaction
from taskradar.deadlines.engine import local_today
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
from taskradar.services.calendar_sync import CalendarSyncError

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


def _detail(c: Container, session: Session, task_id: str) -> dict[str, Any]:
    task = session.scalar(select(Task).options(*_TASK_LOAD, selectinload(Task.events)).where(Task.id == task_id))
    if task is None:
        raise ApiError("task_not_found", "Task not found", 404)
    links = []
    for link in session.scalars(
        select(TaskLink).where(or_(TaskLink.task_id == task_id, TaskLink.other_task_id == task_id))
    ):
        other_id = link.other_task_id if link.task_id == task_id else link.task_id
        other = session.get(Task, other_id)
        if other is not None:
            links.append(
                {
                    "kind": link.kind,
                    "task_id": other.id,
                    "title": other.title,
                    "status": other.status,
                    "direction": "outgoing" if link.task_id == task_id else "incoming",
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


def _by_deadline(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(entries, key=lambda i: (i["effective_deadline"] or "9999", _PRIORITY_ORDER.get(i["priority"], 3)))


@router.get("/dashboard")
def dashboard(c: Container = Depends(get_container)) -> dict[str, Any]:
    now = c.clock()
    thresholds = thresholds_for(c)
    today = local_today(now, c.settings.get().general.timezone)
    with transaction(c.factory) as session:
        tasks = session.scalars(select(Task).options(*_TASK_LOAD)).all()
        # Test data is listed elsewhere (marked as such) but never counts here.
        sample_open = sum(1 for t in tasks if t.sample and t.status in _OPEN)
        items = [task_summary(t, now=now, thresholds=thresholds) for t in tasks if not t.sample]

    active = [i for i in items if i["status"] in _OPEN]
    attention = _attention(active, today=today)
    lanes = {lane: _by_deadline([i for i in active if i["status"] in statuses]) for lane, statuses in _LANES.items()}
    week_ago = (now - dt.timedelta(days=7)).isoformat()
    completed_recent = sorted(
        (i for i in items if i["status"] == "completed" and i["completed_at"] and i["completed_at"] >= week_ago),
        key=lambda i: i["completed_at"],
        reverse=True,
    )
    reasons = [i["attention"] for i in attention]
    return {
        "today": today.isoformat(),
        "counts": {
            "overdue": reasons.count("overdue"),
            "due_today": reasons.count("due_today"),
            "due_tomorrow": reasons.count("due_tomorrow"),
            "due_soon": reasons.count("due_soon"),
            "active": len(active),
            "todo": len(lanes["todo"]),
            "in_progress": len(lanes["in_progress"]),
            "waiting_for_reply": len(lanes["waiting_for_reply"]),
            "unconfirmed": sum(1 for i in active if i["status"] == "candidate"),
            "completed_7d": len(completed_recent),
            "sample_open": sample_open,
        },
        "attention": attention[:12],
        "attention_total": len(attention),
        "lanes": {lane: entries[:_LANE_LIMIT] for lane, entries in lanes.items()},
        "completed_recent": completed_recent[:5],
        "notifications_unread": c.notifications.unread_count(),
    }


_ATTENTION_RANK = {"overdue": 0, "due_today": 1, "due_tomorrow": 2, "due_soon": 3}


def _attention(items: list[dict[str, Any]], *, today: dt.date) -> list[dict[str, Any]]:
    """Open tasks whose time is (nearly) up, most pressing first: overdue, due today, tomorrow, within a week."""
    tomorrow = today + dt.timedelta(days=1)
    week_end = today + dt.timedelta(days=7)
    result: list[dict[str, Any]] = []
    for i in items:
        due = dt.date.fromisoformat(i["due_date"]) if i["due_date"] else None
        if i["urgency"] == Urgency.OVERDUE.value:
            reason = "overdue"
        elif due is None:
            continue
        elif due <= today:
            reason = "due_today"
        elif due == tomorrow:
            reason = "due_tomorrow"
        elif due <= week_end:
            reason = "due_soon"
        else:
            continue
        result.append({**i, "attention": reason})
    result.sort(key=lambda i: (_ATTENTION_RANK[i["attention"]], i["effective_deadline"] or "9999"))
    return result


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
        stmt = select(Task).options(*_TASK_LOAD)
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
        items = [task_summary(t, now=now, thresholds=thresholds) for t in session.scalars(stmt).all()]
    if urgency:
        items = [i for i in items if i["urgency"] in urgency]
    items.sort(key=lambda i: _sort_key(sort, i), reverse=order == "desc")
    return {"items": items[offset : offset + limit], "total": len(items)}


class TaskCreate(BaseModel):
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


class QuickParseBody(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_QUICK_TEXT)


@router.post("/tasks/quick-parse")
def quick_parse(body: QuickParseBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    """Propose title and deadline for a one-line to-do ("周五前交房租"); nothing is saved."""
    quick = parse_quick_task(body.text, now=c.clock(), tz=c.settings.get().general.timezone)
    due = quick.due
    return {
        "title": quick.title,
        "category": quick.category.value,
        "action_type": quick.action_type.value,
        "due_date": due.date.isoformat() if due and due.date else None,
        "due_time": due.time.strftime("%H:%M") if due and due.time else None,
        "due_text": due.text if due else None,
        "time_semantics": due.semantics.value if due else TimeSemantics.DEADLINE.value,
        "ambiguous": bool(due and due.ambiguous),
        "alternatives": [d.isoformat() for d in due.alternatives] if due else [],
    }


@router.post("/tasks", status_code=201)
def create_task(body: TaskCreate, c: Container = Depends(get_container)) -> dict[str, Any]:
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
            timezone=c.settings.get().general.timezone,
            description=body.description,
            category=body.category,
            action_type=body.action_type,
            action_required=body.action_required,
            priority=body.priority,
            sample=body.sample,
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


def _delete_tasks(c: Container, ids: list[str]) -> dict[str, Any]:
    """Delete tasks for good (after the user confirmed it); their calendar events go too, if the user wants that."""
    with transaction(c.factory) as session:
        for task_id in ids:
            c.tasks.get(session, task_id)  # 404 before anything is touched
    not_removed = _remove_calendar_events(c, ids)
    for task_id in ids:
        c.data.delete_task(task_id)
    return {"deleted": ids, "count": len(ids), "calendar_not_removed": not_removed}


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
    if result["calendar_not_removed"]:
        return {"deleted": task_id, "calendar_warning": "event_not_removed"}  # it has to be deleted in Google Calendar
    return {"deleted": task_id}


@router.post("/events/{event_id}/undo")
def undo(event_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
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
