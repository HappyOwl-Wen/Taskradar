"""Dashboard, tasks, suggestions, undo and calendar endpoints."""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from taskradar.api.deps import get_container, thresholds_for
from taskradar.api.errors import ApiError
from taskradar.api.serializers import suggestion_entry, task_detail, task_summary
from taskradar.container import Container
from taskradar.db.models import Document, Message, SyncJob, Task, TaskLink, TaskSource, TaskSuggestion
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
from taskradar.domain.schemas import CandidateTask, DueInfo
from taskradar.services.calendar_sync import CalendarSyncError
from taskradar.services.jobs import job_to_dict
from taskradar.services.tasks import Origin

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["tasks"])

_TASK_LOAD = (
    selectinload(Task.sources).selectinload(TaskSource.message).selectinload(Message.source),
    selectinload(Task.sources).selectinload(TaskSource.document).selectinload(Document.source),
    selectinload(Task.suggestions),
    selectinload(Task.calendar_links),
)
_URGENCY_ORDER = {u.value: i for i, u in enumerate(
    [Urgency.OVERDUE, Urgency.URGENT, Urgency.HIGH, Urgency.UPCOMING, Urgency.NORMAL, Urgency.NO_DEADLINE, Urgency.INACTIVE]
)}
_PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def _detail(c: Container, session: Session, task_id: str) -> dict[str, Any]:
    task = session.scalar(select(Task).options(*_TASK_LOAD, selectinload(Task.events)).where(Task.id == task_id))
    if task is None:
        raise ApiError("task_not_found", "Task not found", 404)
    links = []
    for link in session.scalars(select(TaskLink).where(or_(TaskLink.task_id == task_id, TaskLink.other_task_id == task_id))):
        other_id = link.other_task_id if link.task_id == task_id else link.task_id
        other = session.get(Task, other_id)
        if other is not None:
            links.append({"kind": link.kind, "task_id": other.id, "title": other.title, "status": other.status,
                          "direction": "outgoing" if link.task_id == task_id else "incoming"})
    return task_detail(task, now=c.clock(), thresholds=thresholds_for(c), links=links)


def _sort_key(sort: str, item: dict[str, Any]) -> tuple[Any, ...]:
    if sort == "due":
        return (item["effective_deadline"] is None, item["effective_deadline"] or "", _URGENCY_ORDER[item["urgency"]])
    if sort == "priority":
        return (_PRIORITY_ORDER.get(item["priority"], 3), item["effective_deadline"] or "9999")
    if sort == "confidence":
        return (item["confidence"],)
    if sort == "urgency":
        return (_URGENCY_ORDER[item["urgency"]], item["effective_deadline"] or "9999")
    return (item.get(sort) or "",)


# ---------------------------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------------------------


@router.get("/dashboard")
def dashboard(c: Container = Depends(get_container)) -> dict[str, Any]:
    now = c.clock()
    thresholds = thresholds_for(c)
    tz = c.settings.get().general.timezone
    today = local_today(now, tz)
    with transaction(c.factory) as session:
        tasks = session.scalars(select(Task).options(*_TASK_LOAD)).all()
        items = [task_summary(t, now=now, thresholds=thresholds) for t in tasks]
        jobs = [job_to_dict(j) for j in session.scalars(select(SyncJob).order_by(SyncJob.started_at.desc()).limit(8))]
        pending = session.scalars(
            select(TaskSuggestion).where(TaskSuggestion.status == "pending").order_by(TaskSuggestion.created_at.desc())
        ).all()
        suggestions = [{**suggestion_entry(s), "task_title": s.task.title} for s in pending[:10]]

    committed = {"confirmed", "in_progress", "waiting_for_reply"}
    active = [i for i in items if i["status"] in committed]
    candidates = [i for i in items if i["status"] == "candidate"]

    def by_deadline(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(entries, key=lambda i: (i["effective_deadline"] or "9999", _PRIORITY_ORDER.get(i["priority"], 3)))

    overdue = by_deadline([i for i in active if i["urgency"] == Urgency.OVERDUE.value])
    today_focus = by_deadline([
        i for i in active
        if i["urgency"] in (Urgency.OVERDUE.value, Urgency.URGENT.value) or i["due_date"] == today.isoformat()
    ])
    if len(today_focus) < 5:
        extra = [i for i in by_deadline(active) if i not in today_focus and i["urgency"] == Urgency.HIGH.value]
        extra += [i for i in active if i not in today_focus and i not in extra and i["priority"] == "high"
                  and i["urgency"] == Urgency.NO_DEADLINE.value]
        today_focus += extra[: 5 - len(today_focus)]
    week_end = (today + dt.timedelta(days=7)).isoformat()
    upcoming = by_deadline([
        i for i in active
        if i["due_date"] and today.isoformat() <= i["due_date"] <= week_end and i["urgency"] != Urgency.OVERDUE.value
    ])
    completed_recent = [
        i for i in items if i["status"] == "completed" and i["completed_at"]
        and i["completed_at"] >= (now - dt.timedelta(days=7)).isoformat()
    ]
    return {
        "today": today.isoformat(),
        "counts": {
            "overdue": len(overdue),
            "today_focus": len(today_focus),
            "upcoming_7d": len(upcoming),
            "candidates": len(candidates),
            "needs_review": sum(1 for i in candidates if i["needs_review"]),
            "active": len(active),
            "completed_7d": len(completed_recent),
            "pending_suggestions": len(pending),
        },
        "today_focus": today_focus[:10],
        "upcoming": upcoming[:20],
        "overdue": overdue[:20],
        "candidates": sorted(candidates, key=lambda i: i["detected_at"] or "", reverse=True)[:10],
        "suggestions": suggestions,
        "recent_jobs": jobs,
        "notifications_unread": c.notifications.unread_count(),
        "agent_mode": c.agent.mode(),
    }


# ---------------------------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------------------------


@router.get("/tasks")
def list_tasks(
    status: list[str] = Query(default=[]),
    category: list[str] = Query(default=[]),
    urgency: list[str] = Query(default=[]),
    source_kind: list[str] = Query(default=[]),
    q: str | None = None,
    needs_review: bool | None = None,
    sort: Literal["due", "urgency", "priority", "confidence", "created_at", "updated_at", "detected_at"] = "due",
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
        if needs_review is not None:
            stmt = stmt.where(Task.needs_review.is_(needs_review))
        if q:
            like = f"%{q.strip()}%"
            stmt = stmt.where(or_(Task.title.ilike(like), Task.description.ilike(like), Task.action_required.ilike(like),
                                  Task.due_text.ilike(like)))
        items = [task_summary(t, now=now, thresholds=thresholds) for t in session.scalars(stmt).all()]
    if urgency:
        items = [i for i in items if i["urgency"] in urgency]
    if source_kind:
        items = [i for i in items if set(i["source_kinds"]) & set(source_kind)]
    items.sort(key=lambda i: _sort_key(sort, i), reverse=order == "desc")
    return {"items": items[offset: offset + limit], "total": len(items)}


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    action_required: str = ""
    category: Category = Category.OTHER
    priority: Priority = Priority.MEDIUM
    due_date: dt.date | None = None
    due_time: dt.time | None = None
    time_semantics: TimeSemantics = TimeSemantics.DEADLINE


@router.post("/tasks", status_code=201)
def create_task(body: TaskCreate, c: Container = Depends(get_container)) -> dict[str, Any]:
    cand = CandidateTask(
        title=body.title.strip(), description=body.description, category=body.category, action_type=ActionType.OTHER,
        action_required=body.action_required or body.title, priority=body.priority, confidence=1.0,
        due=DueInfo(date=body.due_date, time=body.due_time if body.due_date else None, semantics=body.time_semantics),
    )
    with transaction(c.factory) as session:
        task = c.tasks.create_from_candidate(
            session, cand, origin=Origin(key="manual", label="手动创建", date=c.clock()), candidate_row=None,
            timezone=c.settings.get().general.timezone, review_reasons=[], actor=Actor.USER,
            status=TaskStatus.CONFIRMED, summary="手动创建任务",
        )
        task.manual = True
        task_id = task.id
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
    cfg = c.settings.get().calendar
    if not cfg.auto_sync_enabled or not c.oauth.connected("calendar"):
        return
    with transaction(c.factory) as session:
        task = c.tasks.get(session, task_id)
        if task.due_date is None or (cfg.auto_sync_categories and task.category not in cfg.auto_sync_categories):
            return
    try:
        c.calendar.sync(task_id, user_confirmed=False, auto_rule=True)
    except CalendarSyncError as exc:
        log.info("Automatic calendar sync skipped: %s", exc.code)


@router.post("/tasks/{task_id}/status")
def change_status(task_id: str, body: StatusBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        task = c.tasks.get(session, task_id)
        c.tasks.change_status(session, task, body.status, actor=Actor.USER, reason=body.note)
    if body.status == TaskStatus.CONFIRMED:
        _maybe_auto_calendar(c, task_id)
    with transaction(c.factory) as session:
        return _detail(c, session, task_id)


class BatchBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    action: Literal["confirm", "dismiss", "complete", "restore", "in_progress", "waiting_for_reply"]


_BATCH_STATUS = {
    "confirm": TaskStatus.CONFIRMED, "dismiss": TaskStatus.DISMISSED, "complete": TaskStatus.COMPLETED,
    "restore": TaskStatus.CANDIDATE, "in_progress": TaskStatus.IN_PROGRESS, "waiting_for_reply": TaskStatus.WAITING_FOR_REPLY,
}


@router.post("/tasks/batch")
def batch(body: BatchBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    target = _BATCH_STATUS[body.action]
    changed: list[str] = []
    with transaction(c.factory) as session:
        for task_id in dict.fromkeys(body.ids):
            task = c.tasks.get(session, task_id)
            if c.tasks.change_status(session, task, target, actor=Actor.USER, reason=f"batch:{body.action}"):
                changed.append(task_id)
    if target == TaskStatus.CONFIRMED:
        for task_id in changed:
            _maybe_auto_calendar(c, task_id)
    return {"changed": changed, "count": len(changed)}


class MergeBody(BaseModel):
    into_task_id: str


@router.post("/tasks/{task_id}/merge")
def merge(task_id: str, body: MergeBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        source = c.tasks.get(session, task_id)
        target = c.tasks.get(session, body.into_task_id)
        c.tasks.merge_tasks(session, source, target, actor=Actor.USER)
    with transaction(c.factory) as session:
        return _detail(c, session, body.into_task_id)


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, c: Container = Depends(get_container)) -> dict[str, Any]:
    c.data.delete_task(task_id)
    return {"deleted": task_id}


@router.post("/events/{event_id}/undo")
def undo(event_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        revert = c.tasks.revert_event(session, event_id, actor=Actor.USER)
        task_id = revert.task_id
        split = (revert.data or {}).get("split_task_id")
    with transaction(c.factory) as session:
        detail = _detail(c, session, task_id)
    detail["split_task_id"] = split
    return detail


# ---------------------------------------------------------------------------------------------
# Suggestions
# ---------------------------------------------------------------------------------------------


@router.get("/suggestions")
def list_suggestions(status: str = "pending", c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        rows = session.scalars(
            select(TaskSuggestion).where(TaskSuggestion.status == status).order_by(TaskSuggestion.created_at.desc())
        ).all()
        items = []
        for s in rows:
            entry = suggestion_entry(s)
            entry["task_title"] = s.task.title
            entry["task_status"] = s.task.status
            if s.related_task_id:
                related = session.get(Task, s.related_task_id)
                entry["related_task_title"] = related.title if related else None
            items.append(entry)
    return {"items": items}


@router.post("/suggestions/{suggestion_id}/accept")
def accept_suggestion(suggestion_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        suggestion = c.tasks.accept_suggestion(session, suggestion_id, actor=Actor.USER)
        task_id = suggestion.task_id
        target_id = suggestion.related_task_id if suggestion.kind == "possible_duplicate" else task_id
    with transaction(c.factory) as session:
        return _detail(c, session, target_id or task_id)


@router.post("/suggestions/{suggestion_id}/reject")
def reject_suggestion(suggestion_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        suggestion = c.tasks.reject_suggestion(session, suggestion_id, actor=Actor.USER)
        task_id = suggestion.task_id
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
