"""Explicit, conditional Google mutations backed by durable local drafts."""

from __future__ import annotations

import contextlib
import datetime as dt
import uuid
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from pydantic import ValidationError
from sqlalchemy import select

from taskradar.connectors.errors import ConflictError, ConnectorError, NotFoundError, PreconditionError
from taskradar.db.calendar_models import CalendarDraft, CalendarSource, CalendarWindow, GoogleEvent, WorkBlock
from taskradar.db.models import CalendarLink
from taskradar.db.session import transaction
from taskradar.domain.calendar import EventForm, simple_event
from taskradar.domain.schemas import DueInfo
from taskradar.security.permissions import PermissionDenied, SideEffect
from taskradar.services.calendar_sync import CalendarSyncError

if TYPE_CHECKING:
    from taskradar.connectors.calendar import CalendarClient
    from taskradar.services.calendar_workspace import CalendarWorkspace


class CalendarEditor:
    def __init__(self, workspace: CalendarWorkspace) -> None:
        self.w = workspace
        self.c = workspace.c

    def save_draft(self, draft_id: str, data: dict[str, Any]) -> dict[str, Any]:
        with self.w.lock, transaction(self.c.factory) as session:
            draft = session.get(CalendarDraft, draft_id)
            if draft and draft.status == "saved":
                return self.w.draft_dict(draft)
            if (
                draft
                and draft.status != "draft"
                and any(getattr(draft, k) != data.get(k) for k in ("operation", "calendar_id", "event_id"))
            ):
                raise CalendarSyncError("draft_target_locked", "Retry this operation before changing its target", 409)
            if not draft:
                draft = CalendarDraft(id=draft_id, operation=data["operation"], calendar_id=data["calendar_id"])
                session.add(draft)
            for key in ("operation", "calendar_id", "event_id", "work_block_id", "payload", "base_event"):
                if key in data:
                    setattr(draft, key, data[key])
            session.flush()
            return self.w.draft_dict(draft)

    def resolve(self, draft_id: str, choice: str) -> dict[str, Any]:
        with self.w.lock, transaction(self.c.factory) as session:
            draft = session.get(CalendarDraft, draft_id)
            if not draft:
                raise LookupError("Draft not found")
            if choice == "discard":
                session.delete(draft)
                return {"discarded": True}
            if (
                draft.status != "conflict"
                or not draft.remote_event.get("etag")
                or draft.remote_event.get("status") == "cancelled"
            ):
                raise CalendarSyncError(
                    "event_conflict", "The remote event cannot be rebased; keep the draft or discard it", 409
                )
            draft.base_event = draft.remote_event
            if draft.operation == "create":
                draft.operation, draft.event_id = "update", draft.remote_event["id"]
            draft.status, draft.last_error = "draft", None
            session.flush()
            return self.w.draft_dict(draft)

    def _authorize(self, client: CalendarClient, calendar_id: str, operation: str, confirm: bool) -> None:
        caps = self.c.oauth.capabilities()
        with transaction(self.c.factory) as session:
            source = session.get(CalendarSource, calendar_id)
            if not source:
                raise CalendarSyncError("calendar_not_selected", "Select the target calendar first", 403)
        # Refresh ACL before each write; cached permissions are only a UI hint.
        if caps["read"]:
            actual = client.get_calendar(calendar_id)
            role = actual.get("accessRole", "reader")
        else:
            role = "owner" if source.app_created and client.calendar_exists(calendar_id) else "reader"
        with transaction(self.c.factory) as session:
            stored = session.get(CalendarSource, calendar_id)
            assert stored
            stored.access_role = role
        own = source.app_created and caps["app"]
        self.c.guard.check(
            SideEffect.GOOGLE_EVENT_DELETE if operation == "delete" else SideEffect.GOOGLE_EVENT_WRITE,
            target=calendar_id,
            user_confirmed=confirm,
            selected=source.selected and source.available,
            scope_allowed=own or caps["edit"],
            app_allowed=own or self.c.settings.get().calendar.google_edit_enabled,
            access_role=role,
        )

    def commit(self, draft_id: str, *, confirm: bool) -> dict[str, Any]:
        with self.w.lock:
            with transaction(self.c.factory) as session:
                draft = session.get(CalendarDraft, draft_id)
                if not draft:
                    raise LookupError("Draft not found")
                if draft.status == "saved":
                    return self.w.draft_dict(draft)
                if draft.status == "conflict":
                    raise CalendarSyncError("event_conflict", "Resolve the saved conflict first", 409)
                if draft.work_block_id:
                    block = session.get(WorkBlock, draft.work_block_id)
                    if not block or (block.event_id and draft.operation == "create"):
                        raise CalendarSyncError("linked_event_exists", "This work block is already linked", 409)
                    task = self.c.tasks.get(session, block.task_id) if block.task_id else None
                    if task and task.sample:
                        raise CalendarSyncError("sample_task", "Test tasks cannot be sent to Google", 409)
                if draft.event_id and session.scalar(
                    select(CalendarLink).where(
                        CalendarLink.calendar_id == draft.calendar_id,
                        CalendarLink.event_id == draft.event_id,
                        CalendarLink.status != "removed",
                    )
                ):
                    raise CalendarSyncError("linked_task_event", "Manage this deadline from the linked task", 409)
            current: dict[str, Any] = {}
            try:
                client = self.c.calendar.client_factory()
                self._authorize(client, draft.calendar_id, draft.operation, confirm)
                body = {}
                if draft.operation != "delete":
                    try:
                        body = EventForm.model_validate(draft.payload).google_body()
                    except ValidationError as exc:
                        raise CalendarSyncError("invalid_event_time", str(exc.errors()[0]["msg"]), 422) from exc
                event_id = draft.event_id or ("trw" + uuid.UUID(draft.id).hex)
                if draft.operation == "create":
                    body["id"] = event_id
                    body["extendedProperties"] = {"private": {"taskradar_operation": draft.id}}
                    try:
                        result = client.insert_event(draft.calendar_id, body)
                    except ConflictError:
                        result = client.get_event(draft.calendar_id, event_id)
                        marker = result.get("extendedProperties", {}).get("private", {}).get("taskradar_operation")
                        if marker != draft.id or result.get("status") == "cancelled":
                            raise PreconditionError("The reserved event ID is no longer available") from None
                        if any(
                            result.get(key, "") != value
                            for key, value in body.items()
                            if key in ("summary", "description", "location", "start", "end")
                        ):
                            current = result
                            raise PreconditionError("The created event changed before the retry") from None
                        # Never overwrite a successful create that was edited later from Google.
                else:
                    try:
                        current = client.get_event(draft.calendar_id, event_id)
                    except NotFoundError:
                        current = {"id": event_id, "status": "cancelled"}
                    if draft.operation == "delete" and current.get("status") == "cancelled":
                        result = current
                    else:
                        if not current.get("etag") or current.get("etag") != draft.base_event.get("etag"):
                            raise PreconditionError("The event changed after the editor was opened")
                        if not simple_event(current):
                            raise CalendarSyncError(
                                "complex_event", "Edit recurring, invited or special events in Google Calendar", 409
                            )
                        if draft.operation == "delete":
                            client.delete_conditional(draft.calendar_id, event_id, current["etag"])
                            result = {"id": event_id, "status": "cancelled"}
                        else:
                            # PATCH only editable fields; preserve attendees, reminders and conferences.
                            result = client.patch_event(draft.calendar_id, event_id, body, current["etag"])
            except PreconditionError as exc:
                if not current:
                    try:
                        current = client.get_event(draft.calendar_id, draft.event_id or event_id)
                    except ConnectorError:
                        current = {"id": draft.event_id, "status": "unknown"}
                else:
                    with contextlib.suppress(ConnectorError):
                        current = client.get_event(draft.calendar_id, draft.event_id or event_id)
                self._failure(draft_id, exc.code, current)
                raise CalendarSyncError(
                    "event_conflict",
                    "Both versions are saved; choose how to proceed",
                    409,
                    details={"draft_id": draft_id, "remote": current},
                ) from exc
            except (ConnectorError, CalendarSyncError, PermissionDenied) as exc:
                self._failure(draft_id, exc.code)
                raise
            with transaction(self.c.factory) as session:
                saved = session.get(CalendarDraft, draft_id)
                assert saved
                saved.status, saved.result, saved.last_error = "saved", result, None
                if draft.work_block_id:
                    block = session.get(WorkBlock, draft.work_block_id)
                    if block:
                        block.calendar_id, block.event_id = draft.calendar_id, result["id"]
                self.w._reconcile(session, draft.calendar_id, result)
                self._cache_event(session, draft.calendar_id, result)
                session.flush()
                return self.w.draft_dict(saved)

    def _failure(self, draft_id: str, code: str, remote: dict[str, Any] | None = None) -> None:
        with transaction(self.c.factory) as session:
            saved = session.get(CalendarDraft, draft_id)
            assert saved
            saved.status = "conflict" if remote is not None else "failed"
            saved.last_error = code
            if remote is not None:
                saved.remote_event = remote

    @staticmethod
    def _cache_event(session: Any, calendar_id: str, event: dict[str, Any]) -> None:
        row = session.get(GoogleEvent, (calendar_id, event["id"]))
        if row:
            row.payload = event
        else:
            session.add(GoogleEvent(calendar_id=calendar_id, event_id=event["id"], payload=event))
        for window in session.scalars(select(CalendarWindow).where(CalendarWindow.calendar_id == calendar_id)):
            events = [e for e in window.events if e["id"] != event["id"]]
            if event.get("status") != "cancelled":
                zone = ZoneInfo(window.timezone)

                def instant(key: str, zone: ZoneInfo = zone) -> dt.datetime:
                    value = event[key]
                    return (
                        dt.datetime.fromisoformat(value["dateTime"])
                        if "dateTime" in value
                        else dt.datetime.combine(dt.date.fromisoformat(value["date"]), dt.time(), zone)
                    )

                if instant("start") < dt.datetime.combine(window.end_date, dt.time(), zone) and instant(
                    "end"
                ) > dt.datetime.combine(window.start_date, dt.time(), zone):
                    events.append(event)
            window.events = events

    def link_task(self, calendar_id: str, event_id: str, *, confirm: bool) -> dict[str, Any]:
        """User initiated import: an independent task + work block, no deadline inferred."""
        if not confirm:
            raise CalendarSyncError("confirmation_required", "Confirm task creation", 400)
        with self.w.lock, transaction(self.c.factory) as session:
            existing = session.scalar(
                select(WorkBlock).where(WorkBlock.calendar_id == calendar_id, WorkBlock.event_id == event_id)
            )
            if existing and existing.task_id:
                return {"task_id": existing.task_id}
            source = session.get(CalendarSource, calendar_id)
            row = session.get(GoogleEvent, (calendar_id, event_id))
            if not source or not source.selected or not row:
                raise LookupError("Select and refresh this calendar first")
            event = row.payload
            if (
                not simple_event(event)
                or "dateTime" not in event.get("start", {})
                or event.get("status") == "cancelled"
            ):
                raise CalendarSyncError(
                    "complex_event", "Only a normal timed event can become a linked work block", 422
                )
            task = self.c.tasks.create(
                session, title=event.get("summary") or "Google Calendar", due=DueInfo(), timezone=source.timezone
            )
            if existing:
                existing.task_id = task.id
            else:
                session.add(
                    WorkBlock(
                        id=str(uuid.uuid4()),
                        task_id=task.id,
                        title=task.title,
                        start_at=dt.datetime.fromisoformat(event["start"]["dateTime"]),
                        end_at=dt.datetime.fromisoformat(event["end"]["dateTime"]),
                        timezone=source.timezone,
                        calendar_id=calendar_id,
                        event_id=event_id,
                        etag=event.get("etag"),
                        sync_status="synced",
                    )
                )
            return {"task_id": task.id}
