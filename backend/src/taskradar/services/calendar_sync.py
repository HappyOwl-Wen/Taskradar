"""Google Calendar sync for confirmed tasks.

* Preview first; writing requires explicit confirmation (or an opt-in auto-sync rule).
* Events go into a dedicated "TaskRadar" calendar; the OAuth scope only allows calendars created by
  TaskRadar, so other events can never be modified.
* Deterministic event IDs + a stored link make writes idempotent (no duplicates on retry).
* Deadlines and appointments are rendered differently and labelled clearly.
* No attendees, no invitations (``sendUpdates="none"``).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
from collections.abc import Callable
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.connectors.calendar import CalendarClient
from taskradar.connectors.errors import ConflictError, ConnectorError, NotFoundError
from taskradar.db.base import utcnow
from taskradar.db.models import CalendarLink, Setting, Task
from taskradar.db.session import transaction
from taskradar.deadlines.engine import parse_hhmm
from taskradar.domain.enums import Actor, EventType
from taskradar.security.permissions import PermissionDenied, PermissionGuard, SideEffect
from taskradar.services.settings import SettingsService
from taskradar.services.tasks import TaskService

log = logging.getLogger(__name__)

STATE_KEY = "calendar_state"
DEADLINE_LEAD_MINUTES = 15
APPOINTMENT_DEFAULT_MINUTES = 60


class CalendarSyncError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def event_id_for(task_id: str) -> str:
    """Google event ids must be base32hex (a-v, 0-9); a uuid hex string qualifies."""
    return "tr" + task_id.replace("-", "").lower()


def build_event(task: Task, *, reminder_minutes: int, base_url: str, language: str = "zh-CN") -> dict[str, Any]:
    if task.due_date is None:
        raise CalendarSyncError("task_without_date", "The task has no date", 422)
    zh = language == "zh-CN"
    is_deadline = task.time_semantics == "deadline"
    tz = ZoneInfo(task.timezone)
    clock = parse_hhmm(task.due_time)
    if is_deadline:
        prefix = "截止：" if zh else "Deadline: "
        kind_text = (
            "截止日期（需在此时间之前完成，不是会议时间）"
            if zh
            else "Deadline (to be done before this time - not a meeting)"
        )
    else:
        prefix = ""
        kind_text = "预约 / 会议时间" if zh else "Appointment / meeting time"
    lines = [
        task.action_required or task.title,
        "",
        f"{'类型' if zh else 'Type'}: {kind_text}",
    ]
    if task.due_text:
        lines.append(f"{'原文' if zh else 'Original wording'}: {task.due_text}")
    if clock is not None and not is_deadline:
        lines.append("持续时间未知，默认 1 小时" if zh else "Duration unknown; 1 hour assumed")
    lines += ["", f"{'由 TaskRadar 创建' if zh else 'Created by TaskRadar'} · {base_url}/tasks/{task.id}"]

    body: dict[str, Any] = {
        "summary": f"{prefix}{task.title}"[:250],
        "description": "\n".join(lines)[:4000],
        "transparency": "transparent" if is_deadline else "opaque",
        "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": reminder_minutes}]},
        "extendedProperties": {"private": {"taskradar_task_id": task.id, "taskradar_kind": task.time_semantics}},
        "source": {"title": "TaskRadar", "url": f"{base_url}/tasks/{task.id}"},
    }
    if clock is None:
        body["start"] = {"date": task.due_date.isoformat()}
        body["end"] = {"date": (task.due_date + dt.timedelta(days=1)).isoformat()}
    else:
        local = dt.datetime.combine(task.due_date, clock).replace(tzinfo=tz)
        if is_deadline:
            start, end = local - dt.timedelta(minutes=DEADLINE_LEAD_MINUTES), local
        else:
            start, end = local, local + dt.timedelta(minutes=APPOINTMENT_DEFAULT_MINUTES)
        body["start"] = {"dateTime": start.isoformat(), "timeZone": task.timezone}
        body["end"] = {"dateTime": end.isoformat(), "timeZone": task.timezone}
    return body


def payload_hash(body: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


class CalendarSyncService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        settings: SettingsService,
        guard: PermissionGuard,
        tasks: TaskService,
        client_factory: Callable[[], CalendarClient],
        connected: Callable[[], bool],
        base_url: str,
        clock: Callable[[], dt.datetime] = utcnow,
    ) -> None:
        self._factory = session_factory
        self.settings = settings
        self.guard = guard
        self.tasks = tasks
        self.client_factory = client_factory
        self.connected = connected
        self.base_url = base_url
        self.clock = clock

    # -- state -------------------------------------------------------------------------------

    def _state(self, session: Session) -> dict[str, Any]:
        row = session.get(Setting, STATE_KEY)
        return dict(row.value) if row else {}

    def _save_state(self, session: Session, state: dict[str, Any]) -> None:
        row = session.get(Setting, STATE_KEY)
        if row is None:
            session.add(Setting(key=STATE_KEY, value=state))
        else:
            row.value = state

    def status(self) -> dict[str, Any]:
        with transaction(self._factory) as session:
            state = self._state(session)
        return {
            "connected": self.connected(),
            "calendar_id": state.get("calendar_id"),
            "calendar_name": self.settings.get().calendar.calendar_name,
        }

    # -- preview & sync ----------------------------------------------------------------------

    def preview(self, task_id: str) -> dict[str, Any]:
        settings = self.settings.get()
        with transaction(self._factory) as session:
            task = self.tasks.get(session, task_id)
            body = build_event(
                task,
                reminder_minutes=settings.calendar.reminder_minutes,
                base_url=self.base_url,
                language=settings.general.language,
            )
            link = session.scalar(select(CalendarLink).where(CalendarLink.task_id == task_id))
            warnings: list[str] = []
            if task.status not in ("confirmed", "in_progress", "waiting_for_reply"):
                warnings.append("task_not_confirmed")
            if task.due_needs_confirmation:
                warnings.append("date_needs_confirmation")
            return {
                "event": body,
                "event_kind": ("all_day_" if task.due_time is None else "timed_") + task.time_semantics,
                "calendar_name": settings.calendar.calendar_name,
                "connected": self.connected(),
                "already_synced": bool(link and link.status == "synced" and link.payload_hash == payload_hash(body)),
                "link": link_to_dict(link) if link else None,
                "warnings": warnings,
            }

    def sync(self, task_id: str, *, user_confirmed: bool, auto_rule: bool = False) -> dict[str, Any]:
        settings = self.settings.get()
        with transaction(self._factory) as session:
            task = self.tasks.get(session, task_id)
            try:
                self.guard.check(
                    SideEffect.CALENDAR_WRITE,
                    target=task_id,
                    session=session,
                    user_confirmed=user_confirmed,
                    auto_rule=auto_rule,
                    task_status=task.status,
                    has_due=task.due_date is not None,
                )
            except PermissionDenied as exc:
                status = 409 if exc.code in ("calendar_not_connected", "task_not_confirmed") else 400
                raise CalendarSyncError(exc.code, exc.message, status) from exc
            body = build_event(
                task,
                reminder_minutes=settings.calendar.reminder_minutes,
                base_url=self.base_url,
                language=settings.general.language,
            )
            digest = payload_hash(body)
            state = self._state(session)
            link = session.scalar(select(CalendarLink).where(CalendarLink.task_id == task_id))
            if link is not None and link.status == "synced" and link.payload_hash == digest:
                return {**link_to_dict(link), "unchanged": True}
            due_version = task.due_version

        client = self.client_factory()
        try:
            calendar_id = self._ensure_calendar(
                client, state, settings.calendar.calendar_name, settings.general.timezone
            )
            event_id = event_id_for(task_id)
            if (
                link is not None
                and link.calendar_id == calendar_id
                and link.status in ("synced", "out_of_sync", "failed")
            ):
                result = self._update_owned(client, calendar_id, link.event_id or event_id, task_id, body)
            else:
                try:
                    result = client.insert_event(calendar_id, {**body, "id": event_id})
                except ConflictError:
                    result = self._update_owned(client, calendar_id, event_id, task_id, body)
        except CalendarSyncError:
            raise
        except ConnectorError as exc:
            self._record_failure(task_id, state.get("calendar_id") or "", exc)
            raise CalendarSyncError(exc.code, f"{exc} - you can retry", 502) from exc

        with transaction(self._factory) as session:
            state["calendar_id"] = calendar_id
            self._save_state(session, state)
            task = self.tasks.get(session, task_id)
            link = session.scalar(select(CalendarLink).where(CalendarLink.task_id == task_id))
            if link is None:
                link = CalendarLink(
                    task_id=task_id,
                    calendar_id=calendar_id,
                    event_id=result.get("id", event_id),
                    event_kind=task.time_semantics,
                    status="synced",
                )
                session.add(link)
            link.calendar_id = calendar_id
            link.event_id = result.get("id", event_id)
            link.event_kind = ("all_day_" if task.due_time is None else "timed_") + task.time_semantics
            link.status = "synced"
            link.synced_due_version = due_version
            link.html_link = result.get("htmlLink")
            link.payload_hash = digest
            link.last_error = None
            link.attempts = (link.attempts or 0) + 1
            link.last_synced_at = self.clock()
            session.flush()
            self.tasks.record(
                session,
                task,
                EventType.CALENDAR_SYNCED,
                Actor.USER if user_confirmed else Actor.SYSTEM,
                "已写入 Google Calendar",
                data={"event_id": link.event_id, "calendar_id": calendar_id},
            )
            return link_to_dict(link)

    def _ensure_calendar(self, client: CalendarClient, state: dict[str, Any], name: str, tz: str) -> str:
        calendar_id = state.get("calendar_id")
        if calendar_id and client.calendar_exists(calendar_id):
            return str(calendar_id)
        return client.create_calendar(name, tz)

    @staticmethod
    def _update_owned(
        client: CalendarClient, calendar_id: str, event_id: str, task_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            current = client.get_event(calendar_id, event_id)
        except NotFoundError:
            return client.insert_event(calendar_id, {**body, "id": event_id})
        owner = ((current.get("extendedProperties") or {}).get("private") or {}).get("taskradar_task_id")
        if owner != task_id:
            raise CalendarSyncError("event_not_owned", "Refusing to modify an event that TaskRadar did not create", 409)
        return client.update_event(calendar_id, event_id, body)

    def _record_failure(self, task_id: str, calendar_id: str, exc: ConnectorError) -> None:
        with transaction(self._factory) as session:
            task = self.tasks.get(session, task_id)
            link = session.scalar(select(CalendarLink).where(CalendarLink.task_id == task_id))
            if link is None:
                link = CalendarLink(
                    task_id=task_id,
                    calendar_id=calendar_id or "pending",
                    event_id=event_id_for(task_id),
                    event_kind=task.time_semantics,
                    status="failed",
                )
                session.add(link)
            link.status = "failed"
            link.last_error = f"{exc.code}: {exc}"[:1000]
            link.attempts = (link.attempts or 0) + 1
            session.flush()
            self.tasks.record(
                session,
                task,
                EventType.CALENDAR_FAILED,
                Actor.SYSTEM,
                "写入 Google Calendar 失败（可重试）",
                data={"error": exc.code},
            )

    def mark_out_of_sync(self, session: Session, task: Task) -> None:
        for link in task.calendar_links:
            if link.status == "synced" and link.synced_due_version != task.due_version:
                link.status = "out_of_sync"


def link_to_dict(link: CalendarLink) -> dict[str, Any]:
    return {
        "calendar_id": link.calendar_id,
        "event_id": link.event_id,
        "event_kind": link.event_kind,
        "status": link.status,
        "html_link": link.html_link,
        "last_error": link.last_error,
        "attempts": link.attempts,
        "last_synced_at": link.last_synced_at.isoformat() if link.last_synced_at else None,
        "synced_due_version": link.synced_due_version,
    }
