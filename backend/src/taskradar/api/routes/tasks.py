"""Dashboard, tasks, suggestions, undo and calendar endpoints."""

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
from taskradar.api.serializers import suggestion_entry, task_detail, task_summary
from taskradar.container import Container
from taskradar.db.models import (
    CalendarLink,
    Document,
    Message,
    SyncJob,
    Task,
    TaskEvent,
    TaskLink,
    TaskSource,
    TaskSuggestion,
)
from taskradar.db.session import transaction
from taskradar.deadlines.engine import local_today
from taskradar.domain.enums import (
    ActionType,
    Actor,
    Category,
    EventType,
    Priority,
    TaskStatus,
    TimeSemantics,
    Urgency,
)
from taskradar.domain.schemas import CandidateTask, DueInfo
from taskradar.extraction.quick_add import MAX_QUICK_TEXT, parse_quick_task
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
        # Demo and test data are listed elsewhere (marked as such) but never count here.
        sample_open = sum(1 for t in tasks if t.sample and t.status not in ("completed", "dismissed"))
        items = [task_summary(t, now=now, thresholds=thresholds) for t in tasks if not t.sample]
        jobs = [job_to_dict(j) for j in session.scalars(select(SyncJob).order_by(SyncJob.started_at.desc()).limit(8))]
        pending = [
            s
            for s in session.scalars(
                select(TaskSuggestion)
                .where(TaskSuggestion.status == "pending")
                .order_by(TaskSuggestion.created_at.desc())
            ).all()
            if not s.task.sample
        ]
        pending.sort(key=lambda s: _SUGGESTION_ORDER.get(s.kind, 9))  # stable: newest first within a kind
        views = [_suggestion_view(session, s) for s in pending]
        suggestions = views[:10]
        # Tasks whose deadline is disputed by another source: they need a decision, not just a glance.
        conflict_ids: set[str] = set()
        for view in views:
            if view["kind"] == "update_due" or view.get("deadlines_differ"):
                conflict_ids.add(view["task_id"])
                if view["related_task_id"]:
                    conflict_ids.add(view["related_task_id"])
        suggestion_task_ids = {s.task_id for s in pending}

    committed = {"confirmed", "in_progress", "waiting_for_reply"}
    active = [i for i in items if i["status"] in committed]
    candidates = [i for i in items if i["status"] == "candidate"]

    def by_deadline(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(entries, key=lambda i: (i["effective_deadline"] or "9999", _PRIORITY_ORDER.get(i["priority"], 3)))

    overdue = by_deadline([i for i in active if i["urgency"] == Urgency.OVERDUE.value])
    today_focus = by_deadline(
        [
            i
            for i in active
            if i["urgency"] in (Urgency.OVERDUE.value, Urgency.URGENT.value) or i["due_date"] == today.isoformat()
        ]
    )
    if len(today_focus) < 5:
        extra = [i for i in by_deadline(active) if i not in today_focus and i["urgency"] == Urgency.HIGH.value]
        extra += [
            i
            for i in active
            if i not in today_focus
            and i not in extra
            and i["priority"] == "high"
            and i["urgency"] == Urgency.NO_DEADLINE.value
        ]
        today_focus += extra[: 5 - len(today_focus)]
    week_end = (today + dt.timedelta(days=7)).isoformat()
    upcoming = by_deadline(
        [
            i
            for i in active
            if i["due_date"]
            and today.isoformat() <= i["due_date"] <= week_end
            and i["urgency"] != Urgency.OVERDUE.value
        ]
    )
    completed_recent = [
        i
        for i in items
        if i["status"] == "completed"
        and i["completed_at"]
        and i["completed_at"] >= (now - dt.timedelta(days=7)).isoformat()
    ]

    attention = _attention(active + candidates, today=today, conflict_ids=conflict_ids)
    candidate_ids = {i["id"] for i in candidates}
    soon_candidates = [i for i in candidates if i["due_date"] and today.isoformat() <= i["due_date"] <= week_end]
    overdue_candidates = [i for i in candidates if i["urgency"] == Urgency.OVERDUE.value]
    attention_counts: dict[str, int] = {}
    for i in attention:
        attention_counts[i["attention"]] = attention_counts.get(i["attention"], 0) + 1
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
            # Distinct tasks that wait for a decision (a candidate to confirm and/or a pending suggestion).
            "needs_action": len(candidate_ids | suggestion_task_ids),
            "due_soon": len(upcoming),
            "due_soon_candidates": len(soon_candidates),
            "overdue_candidates": len(overdue_candidates),
            "conflicts": len(conflict_ids),
            "sample_open": sample_open,
        },
        "attention": attention[:12],
        "attention_total": len(attention),
        "attention_counts": attention_counts,
        "attention_unconfirmed": sum(1 for i in attention if i["status"] == "candidate"),
        "today_focus": today_focus[:10],
        "upcoming": upcoming[:20],
        "overdue": overdue[:20],
        "candidates": sorted(candidates, key=lambda i: i["detected_at"] or "", reverse=True)[:10],
        "suggestions": suggestions,
        "recent_jobs": jobs,
        "notifications_unread": c.notifications.unread_count(),
        "agent_mode": c.agent.mode(),
    }


# Time decides the order of "needs attention"; a conflict or a changed date is a marker on top of that.
_ATTENTION_RANK = {"overdue": 0, "due_today": 1, "due_tomorrow": 2, "due_soon": 3, "date_changed": 4, "conflict": 5}
_SUGGESTION_ORDER = {
    "possible_duplicate": 0,
    "update_due": 1,
    "mark_completed": 2,
    "mark_dismissed": 3,
    "mark_waiting": 4,
}


def _attention(items: list[dict[str, Any]], *, today: dt.date, conflict_ids: set[str]) -> list[dict[str, Any]]:
    """Open tasks that need a look, most pressing first.

    Overdue, then due today, tomorrow and within a week; tasks with a disputed or automatically changed
    deadline follow when they are not due soon anyway. Within the same group confirmed tasks come before
    unconfirmed ones, which stay marked as unconfirmed. A conflict never pushes a task due at the end of
    the month above one that is due tomorrow.
    """
    tomorrow = today + dt.timedelta(days=1)
    week_end = today + dt.timedelta(days=7)
    result: list[dict[str, Any]] = []
    for i in items:
        due = dt.date.fromisoformat(i["due_date"]) if i["due_date"] else None
        flags: list[str] = []
        if i["status"] == "candidate":
            flags.append("unconfirmed")
        if i["id"] in conflict_ids:
            flags.append("conflict")
        if i["needs_review"] and "deadline_changed" in i["review_reasons"]:
            flags.append("date_changed")
        if i["urgency"] == Urgency.OVERDUE.value:
            reason = "overdue"
        elif due is not None and due <= today:
            reason = "due_today"
        elif due == tomorrow:
            reason = "due_tomorrow"
        elif due is not None and due <= week_end:
            reason = "due_soon"
        elif "date_changed" in flags:
            reason = "date_changed"
        elif "conflict" in flags:
            reason = "conflict"
        else:
            continue
        result.append({**i, "attention": reason, "attention_flags": flags})
    result.sort(
        key=lambda i: (
            _ATTENTION_RANK[i["attention"]],
            i["status"] == "candidate",
            i["effective_deadline"] or "9999",
            "conflict" not in i["attention_flags"],
        )
    )
    return result


def _suggestion_view(session: Session, s: TaskSuggestion) -> dict[str, Any]:
    """A suggestion with what the user needs to judge it: both tasks' titles, states and deadlines."""
    entry = suggestion_entry(s)
    task = s.task
    entry.update(
        task_title=task.title,
        task_status=task.status,
        task_due_date=task.due_date.isoformat() if task.due_date else None,
        task_due_time=task.due_time,
        task_sample=task.sample,
    )
    related = session.get(Task, s.related_task_id) if s.related_task_id else None
    entry.update(
        related_task_title=related.title if related else None,
        related_task_status=related.status if related else None,
        related_due_date=related.due_date.isoformat() if related and related.due_date else None,
        related_due_time=related.due_time if related else None,
    )
    if s.kind == "possible_duplicate" and related is not None:
        entry["deadlines_differ"] = task.due_date is not None and (task.due_date, task.due_time) != (
            related.due_date,
            related.due_time,
        )
    return entry


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
    sample: bool | None = None,
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
        if sample is not None:
            stmt = stmt.where(Task.sample.is_(sample))
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
    if source_kind:
        items = [i for i in items if set(i["source_kinds"]) & set(source_kind)]
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
    cand = CandidateTask(
        title=body.title.strip(),
        description=body.description,
        category=body.category,
        action_type=body.action_type,
        action_required=body.action_required or body.title,
        priority=body.priority,
        confidence=1.0,
        due=DueInfo(
            date=body.due_date,
            time=body.due_time if body.due_date else None,
            semantics=body.time_semantics,
            text=due_text if body.due_date else None,
        ),
    )
    with transaction(c.factory) as session:
        task = c.tasks.create_from_candidate(
            session,
            cand,
            origin=Origin(key="manual", label="手动创建", date=c.clock()),
            candidate_row=None,
            timezone=c.settings.get().general.timezone,
            review_reasons=[],
            actor=Actor.USER,
            status=TaskStatus.CONFIRMED,
            summary="手动创建任务",
            sample=body.sample,
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
        if task.sample:
            return  # test data never reaches the real calendar
        if task.due_date is None or (cfg.auto_sync_categories and task.category not in cfg.auto_sync_categories):
            return
    try:
        c.calendar.sync(task_id, user_confirmed=False, auto_rule=True)
    except CalendarSyncError as exc:
        log.info("Automatic calendar sync skipped: %s", exc.code)


def _remove_calendar_events(c: Container, task_ids: Iterable[str]) -> list[str]:
    """Opt-in rule (on by default): a task the user dismisses, merges away or deletes leaves the calendar too.

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
    if body.status == TaskStatus.CONFIRMED:
        _maybe_auto_calendar(c, task_id)
    elif body.status == TaskStatus.DISMISSED:
        not_removed = _remove_calendar_events(c, [task_id])
    with transaction(c.factory) as session:
        detail = _detail(c, session, task_id)
    if not_removed:
        detail["calendar_warning"] = "event_not_removed"
    detail["undo_event_id"] = undo_event_id  # the change just made, for an "undo" button
    return detail


class BatchBody(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    action: Literal["confirm", "dismiss", "complete", "restore", "in_progress", "waiting_for_reply"]


_BATCH_STATUS = {
    "confirm": TaskStatus.CONFIRMED,
    "dismiss": TaskStatus.DISMISSED,
    "complete": TaskStatus.COMPLETED,
    "restore": TaskStatus.CANDIDATE,
    "in_progress": TaskStatus.IN_PROGRESS,
    "waiting_for_reply": TaskStatus.WAITING_FOR_REPLY,
}


@router.post("/tasks/batch")
def batch(body: BatchBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    target = _BATCH_STATUS[body.action]
    changed: list[str] = []
    undo_event_ids: list[int] = []
    with transaction(c.factory) as session:
        for task_id in dict.fromkeys(body.ids):
            task = c.tasks.get(session, task_id)
            event = c.tasks.change_status(session, task, target, actor=Actor.USER, reason=f"batch:{body.action}")
            if event is not None:
                changed.append(task_id)
                undo_event_ids.append(event.id)
    not_removed: list[str] = []
    if target == TaskStatus.CONFIRMED:
        for task_id in changed:
            _maybe_auto_calendar(c, task_id)
    elif target == TaskStatus.DISMISSED:
        not_removed = _remove_calendar_events(c, changed)
    return {
        "changed": changed,
        "count": len(changed),
        "calendar_not_removed": not_removed,
        "undo_event_ids": undo_event_ids,
    }


class MergeBody(BaseModel):
    into_task_id: str
    # Required when the two tasks have different deadlines: keep the "existing" one or take the "new" one.
    due_choice: Literal["existing", "new"] | None = None


@router.post("/tasks/{task_id}/merge")
def merge(task_id: str, body: MergeBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        source = c.tasks.get(session, task_id)
        target = c.tasks.get(session, body.into_task_id)
        event = c.tasks.merge_tasks(session, source, target, actor=Actor.USER, due_choice=body.due_choice)
        c.calendar.mark_out_of_sync(session, target)  # the kept task may have taken over the other deadline
        undo_event_id = event.id
    _remove_calendar_events(c, [task_id])  # the merged-away task is dismissed
    with transaction(c.factory) as session:
        detail = _detail(c, session, body.into_task_id)
    detail["undo_event_id"] = undo_event_id
    return detail


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


class ResolveReviewBody(BaseModel):
    reasons: list[Literal["deadline_changed"]] = Field(min_length=1)


@router.post("/tasks/{task_id}/review/resolve")
def resolve_review(task_id: str, body: ResolveReviewBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    """The user checked a flagged point (e.g. an automatically changed deadline) and keeps it."""
    with transaction(c.factory) as session:
        task = c.tasks.get(session, task_id)
        event = c.tasks.resolve_review(session, task, list(body.reasons), actor=Actor.USER)
        undo_event_id = event.id if event is not None else None
    with transaction(c.factory) as session:
        detail = _detail(c, session, task_id)
    detail["undo_event_id"] = undo_event_id
    return detail


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        c.tasks.get(session, task_id)  # 404 before touching the calendar
    not_removed = _remove_calendar_events(c, [task_id])
    c.data.delete_task(task_id)
    result: dict[str, Any] = {"deleted": task_id}
    if not_removed:
        result["calendar_warning"] = "event_not_removed"  # the event has to be deleted in Google Calendar
    return result


@router.get("/review/recheck")
def recheck(c: Container = Depends(get_container)) -> dict[str, Any]:
    """Open tasks the current rules would not create (or would flag) from the same sources. Read-only:
    the user decides what to dismiss; nothing is deleted."""
    now = c.clock()
    thresholds = thresholds_for(c)
    return c.recheck.run(serialize=lambda t: task_summary(t, now=now, thresholds=thresholds))


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
        items = [_suggestion_view(session, s) for s in rows]
    return {"items": items}


class AcceptBody(BaseModel):
    due_choice: Literal["existing", "new"] | None = None


@router.post("/suggestions/{suggestion_id}/accept")
def accept_suggestion(
    suggestion_id: int, body: AcceptBody | None = None, c: Container = Depends(get_container)
) -> dict[str, Any]:
    with transaction(c.factory) as session:
        suggestion = c.tasks.accept_suggestion(
            session, suggestion_id, actor=Actor.USER, due_choice=body.due_choice if body else None
        )
        if suggestion.related_task_id and suggestion.kind == "possible_duplicate":
            c.calendar.mark_out_of_sync(session, c.tasks.get(session, suggestion.related_task_id))
        task_id = suggestion.task_id
        kind = suggestion.kind
        target_id = suggestion.related_task_id if kind == "possible_duplicate" else task_id
        undo_event_id = _resolution_event_id(session, suggestion)
    if kind in ("possible_duplicate", "mark_dismissed"):  # both dismiss suggestion.task_id
        _remove_calendar_events(c, [task_id])
    with transaction(c.factory) as session:
        detail = _detail(c, session, target_id or task_id)
    detail["undo_event_id"] = undo_event_id
    return detail


@router.post("/suggestions/{suggestion_id}/reject")
def reject_suggestion(suggestion_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    with transaction(c.factory) as session:
        suggestion = c.tasks.reject_suggestion(session, suggestion_id, actor=Actor.USER)
        task_id = suggestion.task_id
        undo_event_id = _resolution_event_id(session, suggestion)
    with transaction(c.factory) as session:
        detail = _detail(c, session, task_id)
    detail["undo_event_id"] = undo_event_id
    return detail


def _resolution_event_id(session: Session, suggestion: TaskSuggestion) -> int | None:
    """The event that records the decision on ``suggestion`` (undoing it reverts the decision)."""
    events = session.scalars(
        select(TaskEvent)
        .where(TaskEvent.task_id == suggestion.task_id, TaskEvent.event_type == EventType.SUGGESTION_RESOLVED.value)
        .order_by(TaskEvent.id.desc())
    )
    return next((e.id for e in events if (e.data or {}).get("suggestion_id") == suggestion.id), None)


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
