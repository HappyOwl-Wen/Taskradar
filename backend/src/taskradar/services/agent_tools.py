"""Bounded workspace tools. Model calls propose changes; only the Apply endpoint executes them."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from taskradar.connectors.agent import AgentError
from taskradar.db.calendar_models import CalendarBuffer, CalendarSource, WorkBlock
from taskradar.db.models import Task
from taskradar.db.session import transaction
from taskradar.domain.agent import (
    Availability,
    BlockId,
    CalendarRange,
    CreateTask,
    FindTasks,
    SaveBlock,
    SaveEvent,
    TaskId,
    UpdateTask,
)
from taskradar.domain.calendar import EventForm, simple_event
from taskradar.domain.enums import Actor, Category, Priority, TaskStatus, TimeSemantics
from taskradar.domain.schemas import DueInfo
from taskradar.extraction.temporal_calendar import wall_time_status
from taskradar.services.calendar_conflicts import CalendarConflicts, buffer_dict, store_buffer, work_key
from taskradar.services.calendar_workspace import block_dict

if TYPE_CHECKING:
    from taskradar.container import Container


TOOL_MODELS: dict[str, tuple[type[BaseModel], str]] = {
    "find_tasks": (
        FindTasks,
        "Find existing tasks by title/notes and optional status. Excludes trash and sample data. "
        "Read IDs before editing; disambiguate multiple matches.",
    ),
    "get_calendar": (
        CalendarRange,
        "Read local tasks, work blocks, selected Google calendars and their write permissions. "
        "End date is exclusive. Google data is cached; report stale/missing coverage.",
    ),
    "check_availability": (
        Availability,
        "Check a timed plan against cached meetings, work blocks, appointments and buffers, "
        "and suggest the next free slot. Never assumes missing Google data is free.",
    ),
    "create_task": (
        CreateTask,
        "Propose a new to-do. Dates YYYY-MM-DD, times HH:MM in the user's timezone. "
        "Do not invent a time for a date-only deadline. Returns a task_id usable in a work block in this proposal.",
    ),
    "update_task": (
        UpdateTask,
        "Propose edits/status changes to one task. Send only changed fields; null due_date clears the deadline, "
        "null due_time removes only the clock time. One edit per task per turn.",
    ),
    "delete_task": (
        TaskId,
        "Propose moving a task to the 30-day recycle bin. Never permanently deletes. One edit per task per turn.",
    ),
    "save_work_block": (
        SaveBlock,
        "Propose a local work session or appointment; block_id omitted creates one. task_id optionally links a to-do. "
        "Read calendar and consider conflicts first; start/end must be unambiguous ISO times. "
        "Include timezone. One edit per block per turn. Local blocks retain title/time/link/buffers only; "
        "put additional notes in the linked task or include a location in the title.",
    ),
    "delete_work_block": (
        BlockId,
        "Propose removing one local work block. Linked Google events must be managed with save_calendar_event.",
    ),
    "save_calendar_event": (
        SaveEvent,
        "Propose creating/updating/deleting an ordinary Google event on a selected writable calendar. "
        "Read get_calendar first for IDs and current event. Requires existing calendar permissions. "
        "Recurring/invited/special events stay managed in Google. A local plan should use save_work_block.",
    ),
}


def definitions() -> list[dict[str, Any]]:
    return [
        {"name": name, "description": description, "parameters": model.model_json_schema()}
        for name, (model, description) in TOOL_MODELS.items()
    ]


def task_snapshot(task: Task) -> dict[str, Any]:
    return {
        "task_id": task.id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "category": task.category,
        "due_date": task.due_date.isoformat() if task.due_date else None,
        "due_time": task.due_time,
        "timezone": task.timezone,
        "time_semantics": task.time_semantics,
        "due_version": task.due_version,
        "calendar_outdated": any(link.status not in ("removed",) for link in task.calendar_links),
    }


def block_snapshot(session: Session, block: WorkBlock) -> dict[str, Any]:
    return {**block_dict(block), "buffer": buffer_dict(session.get(CalendarBuffer, work_key(block.id)))}


class AgentTools:
    def __init__(self, container: Container) -> None:
        self.c = container
        self.changes: list[dict[str, Any]] = []
        self.seen_events: dict[tuple[str, str], dict[str, Any]] = {}

    def run(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name not in TOOL_MODELS:
            raise ValueError("Unknown tool")
        if isinstance(arguments, dict):
            if name in ("save_work_block", "check_availability"):
                arguments = {"timezone": self.c.settings.get().general.timezone, **arguments}
            elif name == "save_calendar_event" and isinstance(arguments.get("event"), dict):
                arguments = {
                    **arguments,
                    "event": {"timezone": self.c.settings.get().general.timezone, **arguments["event"]},
                }
        model = TOOL_MODELS[name][0].model_validate(arguments)
        if name == "find_tasks":
            assert isinstance(model, FindTasks)
            with transaction(self.c.factory) as session:
                stmt = select(Task).where(Task.deleted_at.is_(None), Task.sample.is_(False))
                if model.query:
                    stmt = stmt.where(
                        or_(
                            Task.title.contains(model.query, autoescape=True),
                            Task.description.contains(model.query, autoescape=True),
                        )
                    )
                if model.status:
                    stmt = stmt.where(Task.status == model.status.value)
                tasks = list(session.scalars(stmt.order_by(Task.updated_at.desc(), Task.id).limit(model.limit + 1)))
                return {
                    "items": [{**task_snapshot(t), "description": t.description[:1000]} for t in tasks[: model.limit]],
                    "has_more": len(tasks) > model.limit,
                }
        if name == "get_calendar":
            assert isinstance(model, CalendarRange)
            view = self.c.workspace.view(model.start, model.end)
            for item in view["items"]:
                if item.get("calendar_id") and item.get("event_id") and item.get("remote"):
                    self.seen_events[(item["calendar_id"], item["event_id"])] = item
            return {
                "timezone": view["timezone"],
                "sources": view["sources"],
                "window_updated": view["window_updated"],
                "items": [
                    {key: value for key, value in item.items() if key != "remote"} for item in view["items"][:300]
                ],
                "truncated": len(view["items"]) > 300,
            }
        if name == "check_availability":
            assert isinstance(model, Availability)
            return CalendarConflicts(self.c.workspace).check(**model.model_dump())
        if len(self.changes) >= 20:
            raise ValueError("At most 20 changes per message; split this request")
        payload = model.model_dump(mode="json", exclude_unset=True)
        expected: dict[str, Any] | None = None
        conflicts: dict[str, Any] | None = None
        target = ""
        title = ""
        if isinstance(model, CreateTask):
            self._validate_due(payload, {})
            payload["task_id"] = str(uuid.uuid4())
            payload["timezone"] = self.c.settings.get().general.timezone
            title = model.title
            target = f"task:{payload['task_id']}"
        elif isinstance(model, (UpdateTask, TaskId)):
            with transaction(self.c.factory) as session:
                task = self.c.tasks.get(session, str(model.task_id))
                expected = task_snapshot(task)
            target, title = f"task:{model.task_id}", expected["title"]
            if isinstance(model, UpdateTask):
                if not payload["changes"]:
                    raise ValueError("No changes supplied")
                self._validate_due(payload["changes"], expected)
        elif isinstance(model, (SaveBlock, BlockId)):
            block_id = str(model.block_id) if model.block_id else str(uuid.uuid4())
            if model.block_id:
                with transaction(self.c.factory) as session:
                    block = session.get(WorkBlock, block_id)
                    if not block:
                        raise LookupError("Work block not found")
                    if block.event_id:
                        raise ValueError("Use save_calendar_event to edit a linked Google event")
                    expected = block_snapshot(session, block)
            target = f"work:{block_id}"
            payload["block_id"] = block_id
            title = model.title if isinstance(model, SaveBlock) else (expected or {})["title"]
            if isinstance(model, SaveBlock):
                if model.task_id and not any(
                    ch["kind"] == "create_task" and ch["payload"]["task_id"] == str(model.task_id)
                    for ch in self.changes
                ):
                    with transaction(self.c.factory) as session:
                        self.c.tasks.get(session, str(model.task_id))
                conflicts = self._conflicts(model, [target] if expected else [])
        elif isinstance(model, SaveEvent):
            with transaction(self.c.factory) as session:
                source = session.get(CalendarSource, model.calendar_id)
                if not source or not source.selected or not source.available or not self.c.workspace.can_write(source):
                    raise ValueError("Select a writable calendar and enable its editing permission first")
            if model.operation != "create":
                seen = self.seen_events.get((model.calendar_id, model.event_id or ""))
                if not seen or not seen.get("editable") or not simple_event(seen["remote"]):
                    raise ValueError("Read an editable ordinary event with get_calendar first")
                expected = seen["remote"]
                payload["base_event"] = expected
                if seen.get("work_block_id"):
                    payload["work_block_id"] = seen["work_block_id"]
                title = seen["title"]
            if model.event:
                title = model.event.title
                conflicts = self._conflicts(model.event, [f"google:{model.calendar_id}:{model.event_id}"])
            target = f"google:{model.calendar_id}:{model.event_id or uuid.uuid4()}"
        if any(change["target"] == target for change in self.changes):
            raise ValueError("This item already has a proposed change in this message; combine edits in one call")
        change = {
            "id": str(uuid.uuid4()),
            "kind": name,
            "title": title,
            "target": target,
            "payload": payload,
            "expected": expected,
            "conflicts": conflicts,
            "status": "pending",
            "error": None,
        }
        self.changes.append(change)
        return {
            "proposed": True,
            "applied": False,
            "change_id": change["id"],
            "details": payload,
            "conflicts": conflicts,
        }

    def _validate_due(self, changes: dict[str, Any], before: dict[str, Any]) -> None:
        if changes.get("due_date", True) is None:
            changes["due_time"] = None
        date = changes.get("due_date", before.get("due_date"))
        time = changes.get("due_time", before.get("due_time"))
        if time and not date:
            raise ValueError("A time requires a date")
        if date and time:
            status = wall_time_status(
                dt.date.fromisoformat(date),
                dt.time.fromisoformat(time),
                before.get("timezone") or self.c.settings.get().general.timezone,
            )
            if status != "valid":
                raise ValueError(status + ": ask for an unambiguous local time")

    def _conflicts(self, form: EventForm, exclude: list[str]) -> dict[str, Any] | None:
        if form.all_day:
            return None
        result = CalendarConflicts(self.c.workspace).check(
            start=form.start,
            end=form.end,
            timezone=form.timezone,
            start_fold=form.start_fold,
            end_fold=form.end_fold,
            buffer=form.buffer,
            exclude=exclude,
        )
        # Include other proposed blocks/events, which are not in the database yet.
        for change in self.changes:
            other = (
                change["payload"]
                if change["kind"] == "save_work_block"
                else change["payload"].get("event")
                if change["kind"] == "save_calendar_event"
                else None
            )
            if other and not other.get("all_day"):
                event = EventForm.model_validate(
                    other
                    if change["kind"] != "save_work_block"
                    else {k: v for k, v in other.items() if k not in ("block_id", "task_id")}
                )
                other_start = event.start_at - dt.timedelta(minutes=event.buffer.before_minutes if event.buffer else 0)
                other_end = event.end_at + dt.timedelta(minutes=event.buffer.after_minutes if event.buffer else 0)
                own_start = form.start_at - dt.timedelta(minutes=form.buffer.before_minutes if form.buffer else 0)
                own_end = form.end_at + dt.timedelta(minutes=form.buffer.after_minutes if form.buffer else 0)
                if other_start < own_end and other_end > own_start:
                    result["conflicts"].append(
                        {
                            "id": change["id"],
                            "title": change["title"],
                            "start": event.start,
                            "end": event.end,
                            "kind": "proposed",
                        }
                    )
        return result

    def apply_local(self, session: Session, change: dict[str, Any]) -> dict[str, Any]:
        kind, payload, expected = change["kind"], change["payload"], change["expected"]
        if kind == "create_task":
            self._validate_due(payload, {})
            task = self.c.tasks.create(
                session,
                task_id=payload["task_id"],
                title=payload["title"],
                description=payload.get("description", ""),
                timezone=payload["timezone"],
                due=DueInfo(
                    date=payload.get("due_date"),
                    time=payload.get("due_time"),
                    semantics=payload.get("time_semantics", TimeSemantics.DEADLINE),
                ),
                category=Category(payload.get("category", "other")),
                priority=Priority(payload.get("priority", "medium")),
            )
            if payload.get("status"):
                self.c.tasks.change_status(
                    session, task, TaskStatus(payload["status"]), actor=Actor.USER, reason="AI Agent"
                )
            return {"task_id": task.id}
        if kind in ("update_task", "delete_task"):
            task = self.c.tasks.get(session, payload["task_id"])
            if task_snapshot(task) != expected:
                raise AgentError("agent_change_conflict", 409)
            if kind == "delete_task":
                self.c.tasks.trash(session, task)
            else:
                changes = dict(payload["changes"])
                self._validate_due(changes, expected)
                status = changes.pop("status", None)
                self.c.tasks.update_fields(session, task, changes, actor=Actor.USER, reason="AI Agent", lock=True)
                if status:
                    self.c.tasks.change_status(session, task, TaskStatus(status), actor=Actor.USER, reason="AI Agent")
                self.c.calendar.mark_out_of_sync(session, task)
            return {"task_id": task.id, "calendar_outdated": expected["calendar_outdated"]}
        if kind in ("save_work_block", "delete_work_block"):
            block = session.get(WorkBlock, payload["block_id"])
            if expected and (not block or block_snapshot(session, block) != expected):
                raise AgentError("agent_change_conflict", 409)
            if kind == "delete_work_block":
                if block:
                    store_buffer(session, work_key(block.id), None)
                    session.delete(block)
                return {"deleted": True}
            form = SaveBlock.model_validate(payload)
            if form.task_id:
                self.c.tasks.get(session, str(form.task_id))
            if not block:
                block = WorkBlock(
                    id=payload["block_id"],
                    title=form.title,
                    start_at=form.start_at,
                    end_at=form.end_at,
                    timezone=form.timezone,
                )
                session.add(block)
            else:
                block.revision += 1
            block.title, block.start_at, block.end_at, block.timezone = (
                form.title,
                form.start_at,
                form.end_at,
                form.timezone,
            )
            if "task_id" in payload:
                block.task_id = payload["task_id"]
            if form.buffer is not None:
                store_buffer(session, work_key(block.id), form.buffer)
            session.flush()
            return {"work_block_id": block.id}
        raise ValueError("Unsupported local change")
