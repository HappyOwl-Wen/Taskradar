"""Runtime problems as a short, plain-language status summary.

The UI shows these items instead of job logs: each one says what is wrong (a code the UI translates),
how many things are affected, since when, and what the user can do. Nothing here changes data.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.db.base import utcnow
from taskradar.db.models import CalendarLink, SyncJob, Task
from taskradar.db.session import transaction
from taskradar.domain.enums import JobKind

Level = Literal["error", "warning", "info"]
_LEVEL_ORDER = {"error": 0, "warning": 1, "info": 2}


@dataclass
class StatusItem:
    code: str
    level: Level
    area: str
    params: dict[str, Any] = field(default_factory=dict)
    since: str | None = None
    action: str | None = None  # where the user can fix it: "calendar", "notifications" (settings), "tasks"

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "level": self.level,
            "area": self.area,
            "params": self.params,
            "since": self.since,
            "action": self.action,
        }


def _iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


class StatusSummaryService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        calendar_connected: Callable[[], bool],
        clock: Callable[[], dt.datetime] = utcnow,
    ) -> None:
        self._factory = session_factory
        self._calendar_connected = calendar_connected
        self.clock = clock

    def summary(self, *, scheduler_running: bool, banners_missing: bool = False) -> dict[str, Any]:
        now = self.clock()
        items: list[StatusItem] = []
        with transaction(self._factory) as session:
            items += self._calendar(session)
            items += self._reminders(session, now)
        if not scheduler_running:
            items.append(StatusItem("scheduler_off", "warning", "system"))
        if banners_missing:
            # Notifications arrive, but only in Windows' notification centre: no banner on the screen.
            items.append(StatusItem("notification_banners_off", "warning", "notifications", action="notifications"))
        items.sort(key=lambda i: _LEVEL_ORDER[i.level])
        levels = {i.level for i in items}
        overall = "problem" if "error" in levels else "attention" if "warning" in levels else "ok"
        return {"overall": overall, "checked_at": now.isoformat(), "items": [i.to_dict() for i in items]}

    # ------------------------------------------------------------------------------------------

    def _calendar(self, session: Session) -> list[StatusItem]:
        counts = dict(
            session.execute(
                select(CalendarLink.status, func.count())
                .join(Task, Task.id == CalendarLink.task_id)
                .where(
                    CalendarLink.status.in_(("failed", "out_of_sync")),
                    Task.status.not_in(("completed", "dismissed")),
                    Task.deleted_at.is_(None),
                )
                .group_by(CalendarLink.status)
            ).all()
        )
        items: list[StatusItem] = []
        in_calendar = session.scalar(
            select(func.count())
            .select_from(CalendarLink)
            .join(Task, Task.id == CalendarLink.task_id)
            .where(
                CalendarLink.status != "removed",
                Task.status.not_in(("completed", "dismissed")),
                Task.deleted_at.is_(None),
            )
        )
        if in_calendar and not self._calendar_connected():
            # Tasks are in Google Calendar, but changes can no longer reach it.
            items.append(
                StatusItem("calendar_disconnected", "warning", "calendar", {"count": in_calendar}, action="calendar")
            )
        if counts.get("failed"):
            items.append(
                StatusItem("calendar_failed", "warning", "calendar", {"count": counts["failed"]}, action="tasks")
            )
        if counts.get("out_of_sync"):
            items.append(
                StatusItem("calendar_out_of_sync", "info", "calendar", {"count": counts["out_of_sync"]}, action="tasks")
            )
        return items

    def _reminders(self, session: Session, now: dt.datetime) -> list[StatusItem]:
        last = session.scalars(
            select(SyncJob)
            .where(SyncJob.kind == JobKind.REMINDER_SCAN.value, SyncJob.status != "running")
            .order_by(SyncJob.started_at.desc())
        ).first()
        if last is not None and last.status == "failed":
            return [
                StatusItem(
                    "reminders_failing",
                    "warning",
                    "reminders",
                    {"error": last.error_code or "unknown"},
                    since=_iso(last.started_at),
                )
            ]
        return []
