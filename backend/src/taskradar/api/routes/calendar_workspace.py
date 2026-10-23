"""Calendar workbench; all remote requests and credentials stay in the backend."""

from __future__ import annotations

import datetime as dt
import json
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator

from taskradar.api.deps import get_container
from taskradar.container import Container
from taskradar.domain.calendar import EventForm
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
