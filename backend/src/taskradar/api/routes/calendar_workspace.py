"""Calendar workbench; all remote requests and credentials stay in the backend."""

from __future__ import annotations

import datetime as dt
import json
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, StringConstraints, model_validator

from taskradar.api.deps import get_container
from taskradar.container import Container
from taskradar.domain.calendar import EventForm
from taskradar.domain.calendar_buffers import Buffer
from taskradar.services.calendar_conflicts import CalendarConflicts
from taskradar.services.calendar_editor import CalendarEditor

router = APIRouter(prefix="/api/calendar", tags=["calendar workspace"])


class RangeBody(BaseModel):
    start: dt.date
    end: dt.date


@router.get("/view")
def view(start: dt.date, end: dt.date, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.workspace.view(start, end)


@router.get("/sources")
def sources(c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.workspace.sources()


@router.post("/refresh")
def refresh(body: RangeBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    c.workspace.ensure_window(body.start, body.end)
    return c.workspace.refresh(body.start, body.end)


class SourceSelection(BaseModel):
    selected: list[str] = Field(max_length=200)
    default_calendar_id: str | None = None
    google_edit_enabled: bool = False


@router.put("/sources")
def select_sources(body: SourceSelection, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.workspace.select_sources(body.selected, body.default_calendar_id, body.google_edit_enabled)


class BlockBody(EventForm):
    task_id: str | None = None
    revision: int | None = None


@router.post("/work-blocks", status_code=201)
def create_block(body: BlockBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.workspace.save_block(body.task_id, body)


@router.put("/work-blocks/{block_id}")
def update_block(block_id: UUID, body: BlockBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.workspace.save_block(body.task_id, body, str(block_id), body.revision)


@router.delete("/work-blocks/{block_id}")
def delete_block(block_id: UUID, c: Container = Depends(get_container)) -> dict[str, bool]:
    c.workspace.delete_block(str(block_id))
    return {"deleted": True}


@router.get("/tasks/{task_id}/work-blocks")
def task_blocks(task_id: str, c: Container = Depends(get_container)) -> list[dict[str, Any]]:
    return c.workspace.task_blocks(task_id)


class ConflictBody(BaseModel):
    start: str = Field(max_length=64)
    end: str = Field(max_length=64)
    timezone: str = Field(default="Europe/Berlin", max_length=100)
    all_day: bool = False
    start_fold: Literal[0, 1] | None = None
    end_fold: Literal[0, 1] | None = None
    buffer: Buffer | None = None
    # The item being edited, so that it does not overlap itself.
    exclude: list[Annotated[str, StringConstraints(max_length=1600)]] = Field(default_factory=list, max_length=10)


@router.post("/conflicts")
def conflicts(body: ConflictBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    """A warning for a planned time; reads only, so saving stays possible whatever it finds."""
    if body.all_day:
        return {"conflicts": [], "unchecked": [], "suggestion": None}
    return CalendarConflicts(c.workspace).check(
        start=body.start,
        end=body.end,
        timezone=body.timezone,
        start_fold=body.start_fold,
        end_fold=body.end_fold,
        buffer=body.buffer,
        exclude=body.exclude,
    )


class BufferBody(Buffer):
    work_block_id: UUID | None = None
    calendar_id: str | None = Field(default=None, max_length=512)
    event_id: str | None = Field(default=None, max_length=1024)
    # For an occurrence of a recurring Google event: reserve the time around every occurrence.
    series: bool = False

    @model_validator(mode="after")
    def one_item(self) -> BufferBody:
        if bool(self.work_block_id) == bool(self.calendar_id and self.event_id):
            raise ValueError("Name one work block or one Google event")
        return self


@router.put("/buffers")
def set_buffer(body: BufferBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    buffer = Buffer.model_validate(body.model_dump(include=set(Buffer.model_fields)))
    return {
        "buffer": CalendarConflicts(c.workspace).set_buffer(
            buffer,
            work_block_id=str(body.work_block_id) if body.work_block_id else None,
            calendar_id=body.calendar_id,
            event_id=body.event_id,
            series=body.series,
        )
    }


@router.post("/work-blocks/{block_id}/detach")
def detach_block(block_id: UUID, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.workspace.detach_block(str(block_id))


class TaskResolution(BaseModel):
    choice: Literal["local", "remote"]
    etag: str
    confirm: Literal[True]


@router.post("/tasks/{task_id}/resolve-link")
def resolve_task_link(task_id: str, body: TaskResolution, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.workspace.resolve_task_link(task_id, body.choice, body.etag)


class DraftBody(BaseModel):
    operation: Literal["create", "update", "delete"]
    calendar_id: str = Field(min_length=1, max_length=512)
    event_id: str | None = Field(default=None, max_length=1024)
    work_block_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    base_event: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def bounded(self) -> DraftBody:
        if len(json.dumps(self.model_dump())) > 100_000:
            raise ValueError("Draft too large")
        if self.operation != "create" and not self.event_id:
            raise ValueError("Event ID required")
        return self


@router.put("/drafts/{draft_id}")
def draft(draft_id: UUID, body: DraftBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return CalendarEditor(c.workspace).save_draft(str(draft_id), body.model_dump())


class ConfirmBody(BaseModel):
    confirm: bool = False


@router.post("/drafts/{draft_id}/commit")
def commit(draft_id: UUID, body: ConfirmBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return CalendarEditor(c.workspace).commit(str(draft_id), confirm=body.confirm)


class ResolveBody(BaseModel):
    choice: Literal["discard", "rebase"]


@router.post("/drafts/{draft_id}/resolve")
def resolve(draft_id: UUID, body: ResolveBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return CalendarEditor(c.workspace).resolve(str(draft_id), body.choice)


class LinkBody(ConfirmBody):
    calendar_id: str
    event_id: str


@router.post("/link-task")
def link_task(body: LinkBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return CalendarEditor(c.workspace).link_task(body.calendar_id, body.event_id, confirm=body.confirm)
