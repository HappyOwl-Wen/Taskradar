"""Task lifecycle service.

Every change is written as a :class:`TaskEvent`; status and field changes can be undone. Tasks are the user's own
to-dos (``manual``); tasks found in imported mails and files by earlier versions are kept as they are.
"""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from taskradar.db.base import utcnow
from taskradar.db.models import Task, TaskEvent
from taskradar.domain.enums import (
    ActionType,
    Actor,
    Category,
    EventType,
    Priority,
    TaskStatus,
    TimeSemantics,
)
from taskradar.domain.schemas import DueInfo


class TaskError(Exception):
    code = "task_error"
    status_code = 400

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        if code:
            self.code = code


class TaskNotFound(TaskError):
    code = "task_not_found"
    status_code = 404


class RevertConflict(TaskError):
    code = "revert_conflict"
    status_code = 409


class NotRevertible(TaskError):
    code = "not_revertible"
    status_code = 409


USER_EDITABLE_FIELDS = {
    "title",
    "description",
    "category",
    "action_required",
    "priority",
    "due_date",
    "due_time",
    "time_semantics",
}
_DUE_FIELDS = {"due_date", "due_time"}
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _jsonable(value: Any) -> Any:
    if isinstance(value, dt.datetime):
        return value.isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    return value


def _from_json(field: str, value: Any) -> Any:
    if value is None:
        return None
    if field == "due_date":
        return dt.date.fromisoformat(value)
    if field in ("confirmed_at", "completed_at", "dismissed_at"):
        return dt.datetime.fromisoformat(value)
    return value


def _status_fields(task: Task) -> dict[str, Any]:
    return {
        "status": task.status,
        "confirmed_at": _jsonable(task.confirmed_at),
        "completed_at": _jsonable(task.completed_at),
        "dismissed_at": _jsonable(task.dismissed_at),
        "needs_review": task.needs_review,
    }


STATUS_LABELS_ZH = {
    "candidate": "待确认",
    "confirmed": "待办",
    "in_progress": "进行中",
    "waiting_for_reply": "等待回复",
    "completed": "已完成",
    "dismissed": "已忽略",
}


class TaskService:
    def __init__(self, clock: Callable[[], dt.datetime] = utcnow) -> None:
        self.clock = clock

    def get(self, session: Session, task_id: str) -> Task:
        task = session.get(Task, task_id)
        if task is None:
            raise TaskNotFound("Task not found")
        return task

    def record(
        self,
        session: Session,
        task: Task,
        event_type: EventType,
        actor: Actor,
        summary: str,
        *,
        data: dict[str, Any] | None = None,
        reason: str | None = None,
        revertible: bool = False,
    ) -> TaskEvent:
        event = TaskEvent(
            task_id=task.id,
            event_type=event_type.value,
            actor=actor.value,
            summary=summary[:1000],
            reason=reason,
            data=data or {},
            revertible=revertible,
            created_at=self.clock(),
        )
        session.add(event)
        session.flush()
        return event

    # ------------------------------------------------------------------------------------------
    # Creation
    # ------------------------------------------------------------------------------------------

    @staticmethod
    def apply_due(task: Task, due: DueInfo) -> None:
        task.due_date = due.date
        task.due_time = due.time.strftime("%H:%M") if due.time else None
        task.due_precision = due.precision.value
        task.due_text = due.text
        task.due_is_relative = due.is_relative
        task.due_needs_confirmation = due.needs_confirmation
        task.due_anchor = due.anchor.value if due.anchor else None
        task.time_semantics = due.semantics.value

    def create(
        self,
        session: Session,
        *,
        title: str,
        due: DueInfo,
        timezone: str,
        description: str = "",
        category: Category = Category.OTHER,
        action_type: ActionType = ActionType.OTHER,
        action_required: str = "",
        priority: Priority = Priority.MEDIUM,
        sample: bool = False,
        time_resolution: str = "explicit",
    ) -> Task:
        """A to-do the user wrote themselves: it counts and reminds at once (no confirmation step)."""
        now = self.clock()
        title = title.strip()[:200]
        task = Task(
            sample=sample,
            manual=True,
            title=title,
            description=description,
            category=category.value,
            action_type=action_type.value,
            action_required=action_required or title,
            status=TaskStatus.CONFIRMED.value,
            priority=priority.value,
            confidence=1.0,
            timezone=timezone,
            detected_at=now,
            created_at=now,
            updated_at=now,
            confirmed_at=now,
        )
        self.apply_due(task, due)
        session.add(task)
        session.flush()
        self.record(
            session,
            task,
            EventType.CREATED,
            Actor.USER,
            "手动创建任务",
            data={"origin": "manual", "time_resolution": time_resolution},
        )
        return task

    # ------------------------------------------------------------------------------------------
    # Mutations
    # ------------------------------------------------------------------------------------------

    def change_status(
        self,
        session: Session,
        task: Task,
        new_status: TaskStatus,
        *,
        actor: Actor,
        reason: str | None = None,
        summary: str | None = None,
        revertible: bool = True,
    ) -> TaskEvent | None:
        if task.status == new_status.value:
            return None
        before = _status_fields(task)
        now = self.clock()
        task.status = new_status.value
        if new_status == TaskStatus.CONFIRMED and task.confirmed_at is None:
            task.confirmed_at = now
        if new_status == TaskStatus.COMPLETED:
            task.completed_at = now
        elif new_status != TaskStatus.DISMISSED:
            task.completed_at = None
        if new_status == TaskStatus.DISMISSED:
            task.dismissed_at = now
        else:
            task.dismissed_at = None
        if actor == Actor.USER and new_status != TaskStatus.CANDIDATE:
            task.needs_review = False
        task.updated_at = now
        after = _status_fields(task)
        label = summary or (
            f"状态：{STATUS_LABELS_ZH.get(before['status'], before['status'])} → "
            f"{STATUS_LABELS_ZH.get(new_status.value, new_status.value)}"
        )
        return self.record(
            session,
            task,
            EventType.STATUS_CHANGED,
            actor,
            label,
            data={"before": before, "after": after},
            reason=reason,
            revertible=revertible,
        )

    def update_fields(
        self,
        session: Session,
        task: Task,
        changes: dict[str, Any],
        *,
        actor: Actor,
        reason: str | None = None,
        lock: bool = False,
        revertible: bool = True,
        summary: str | None = None,
        due_text: str | None = None,
    ) -> TaskEvent | None:
        normalized: dict[str, Any] = {}
        for key, value in changes.items():
            if key not in USER_EDITABLE_FIELDS:
                raise TaskError(f"Field {key} cannot be edited", code="field_not_editable")
            normalized[key] = self._normalize_field(key, value)
        before: dict[str, Any] = {}
        after: dict[str, Any] = {}
        for key, value in normalized.items():
            current = getattr(task, key)
            if current == value:
                continue
            before[key] = _jsonable(current)
            after[key] = _jsonable(value)
            setattr(task, key, value)
        if not after:
            return None
        if _DUE_FIELDS & set(after):
            for key in ("due_precision", "due_needs_confirmation", "due_text", "due_anchor", "due_is_relative"):
                before[key] = getattr(task, key)
            task.due_precision = "none" if task.due_date is None else ("date" if task.due_time is None else "datetime")
            if task.due_date is None:
                task.due_time = None
            task.due_version += 1
            if actor == Actor.USER:
                task.due_needs_confirmation = False
                task.due_anchor = None
                task.due_is_relative = False
            if due_text is not None:
                task.due_text = due_text
            for key in ("due_precision", "due_needs_confirmation", "due_text", "due_anchor", "due_is_relative"):
                after[key] = getattr(task, key)
        if lock and actor == Actor.USER:
            locked = set(task.user_locked_fields or [])
            locked.update("due" if k in _DUE_FIELDS else k for k in after if k in USER_EDITABLE_FIELDS)
            task.user_locked_fields = sorted(locked)
        if actor == Actor.USER and _DUE_FIELDS & set(after) and "deadline_changed" in (task.review_reasons or []):
            # The user set the date themselves: an earlier automatic change no longer needs a look.
            task.review_reasons = [r for r in task.review_reasons if r != "deadline_changed"]
            task.needs_review = task.needs_review and bool(task.review_reasons)
        task.updated_at = self.clock()
        names = ", ".join(k for k in after if k in USER_EDITABLE_FIELDS)
        return self.record(
            session,
            task,
            EventType.FIELDS_UPDATED,
            actor,
            summary or f"修改了 {names}",
            data={"before": before, "after": after},
            reason=reason,
            revertible=revertible,
        )

    @staticmethod
    def _normalize_field(key: str, value: Any) -> Any:
        if key == "title":
            value = (value or "").strip()
            if not value:
                raise TaskError("Title must not be empty", code="invalid_title")
            return value[:200]
        if key == "due_date":
            if value in (None, ""):
                return None
            return value if isinstance(value, dt.date) else dt.date.fromisoformat(str(value))
        if key == "due_time":
            if value in (None, ""):
                return None
            value = value.strftime("%H:%M") if isinstance(value, dt.time) else str(value)
            if not _HHMM.match(value):
                raise TaskError("Time must be HH:MM", code="invalid_time")
            return value
        if key == "category":
            return Category(value).value
        if key == "priority":
            return Priority(value).value
        if key == "time_semantics":
            return TimeSemantics(value).value
        return value or ""

    def set_sample(self, session: Session, task: Task, sample: bool, *, actor: Actor = Actor.USER) -> TaskEvent | None:
        """Mark a task as test data (or back as a real task); undoable like a field change."""
        if task.sample == sample:
            return None
        task.sample = sample
        task.updated_at = self.clock()
        return self.record(
            session,
            task,
            EventType.FIELDS_UPDATED,
            actor,
            "标记为测试数据（不计入统计、不提醒、不写入日历）" if sample else "取消测试数据标记",
            data={"before": {"sample": not sample}, "after": {"sample": sample}},
            revertible=True,
        )

    # ------------------------------------------------------------------------------------------
    # Undo
    # ------------------------------------------------------------------------------------------

    def revert_event(self, session: Session, event_id: int, *, actor: Actor = Actor.USER) -> TaskEvent:
        event = session.get(TaskEvent, event_id)
        if event is None:
            raise TaskError("Event not found", code="event_not_found")
        if not event.revertible:
            raise NotRevertible("This change cannot be undone")
        if event.reverted_at is not None:
            raise RevertConflict("This change was already undone")
        task = event.task
        data = event.data or {}

        if event.event_type == EventType.STATUS_CHANGED.value:
            if task.status != data["after"]["status"]:
                raise RevertConflict("The status has changed since; undo is no longer possible")
            for key, value in data["before"].items():
                setattr(task, key, _from_json(key, value))
        elif event.event_type == EventType.FIELDS_UPDATED.value:
            for key, value in data["after"].items():
                if _jsonable(getattr(task, key)) != value:
                    raise RevertConflict(f"Field {key} has changed since; undo is no longer possible")
            for key, value in data["before"].items():
                setattr(task, key, _from_json(key, value))
            if _DUE_FIELDS & set(data["after"]):
                task.due_version += 1
            added = data.get("added_review_reasons") or []
            if added:  # the flag that asked the user to check an automatic change
                task.review_reasons = [r for r in (task.review_reasons or []) if r not in added]
                task.needs_review = bool(data.get("needs_review_before", False))
        else:
            # Merges, suggestions and attached mails of earlier versions stay in the history as they are.
            raise NotRevertible("This change cannot be undone")

        now = self.clock()
        task.updated_at = now
        event.reverted_at = now
        revert = self.record(
            session,
            task,
            EventType.REVERTED,
            actor,
            f"已撤销：{event.summary}",
            data={"reverted_event_id": event.id},
        )
        event.reverted_by_event_id = revert.id
        return revert
