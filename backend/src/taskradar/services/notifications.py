"""Reminder scanning: deterministic urgency evaluation + deduplicated, throttled notifications."""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Callable
from typing import Any

from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.db.base import utcnow
from taskradar.db.models import Notification, Task
from taskradar.db.session import transaction
from taskradar.deadlines.engine import Thresholds, evaluate, format_due_at
from taskradar.deadlines.reminders import ReminderSettings, plan_reminder
from taskradar.domain.enums import ACTIVE_STATUSES, JobKind, JobStatus, JobTrigger
from taskradar.notify import windows
from taskradar.security.permissions import PermissionGuard, SideEffect
from taskradar.services.jobs import JobContext, JobRunner
from taskradar.services.settings import SettingsService

log = logging.getLogger(__name__)


class NotificationService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        settings: SettingsService,
        guard: PermissionGuard,
        jobs: JobRunner,
        clock: Callable[[], dt.datetime] = utcnow,
        toast: Callable[[str, str], bool] = windows.show,
    ) -> None:
        self._factory = session_factory
        self.settings = settings
        self.guard = guard
        self.jobs = jobs
        self.clock = clock
        self.toast = toast

    def scan(self, trigger: JobTrigger = JobTrigger.SCHEDULED) -> dict[str, Any]:
        return self.jobs.run(JobKind.REMINDER_SCAN, lock_key="reminders", trigger=trigger, fn=self._scan)

    def _scan(self, ctx: JobContext) -> JobStatus:
        cfg = self.settings.get()
        thresholds = Thresholds(cfg.reminders.urgent_hours, cfg.reminders.high_days, cfg.reminders.upcoming_days)
        reminder_settings = ReminderSettings(
            notify_candidates=cfg.reminders.notify_candidates,
            overdue_repeat_hours=cfg.reminders.overdue_repeat_hours,
            notify_upcoming=cfg.reminders.notify_upcoming,
        )
        now = self.clock()
        created: list[tuple[int, str, str]] = []
        with transaction(self._factory) as session:
            tasks = session.scalars(
                select(Task).where(
                    Task.status.in_([s.value for s in ACTIVE_STATUSES]),
                    Task.due_date.isnot(None),
                    Task.sample.is_(False),  # demo / test data never reminds
                    Task.deleted_at.is_(None),
                )
            ).all()
            for task in tasks:
                ctx.bump("items_seen")
                status = evaluate(
                    status=task.status,
                    due_date=task.due_date,
                    due_time=task.due_time,
                    tz_name=task.timezone,
                    now=now,
                    thresholds=thresholds,
                )
                decision = plan_reminder(
                    task_id=task.id,
                    title=task.title,
                    status=task.status,
                    due_version=task.due_version,
                    due_label=format_due_at(task.due_date, task.due_time, task.timezone) or "",
                    deadline=status,
                    now=now,
                    settings=reminder_settings,
                    language=cfg.general.language,
                )
                if decision is None:
                    continue
                exists = session.scalar(select(Notification.id).where(Notification.dedupe_key == decision.dedupe_key))
                if exists is not None:
                    ctx.bump("items_skipped")
                    continue
                if len(created) >= cfg.notifications.max_per_scan:
                    ctx.details["throttled"] = True
                    break
                # The scan runs under the "reminders" job lock and dedupe keys are unique in the
                # database, so a concurrent duplicate is impossible; a violation would abort the
                # whole scan (rolled back) and the next scan would redo it.
                note = Notification(
                    task_id=task.id,
                    level=decision.level.value,
                    title=decision.title,
                    body=decision.body,
                    dedupe_key=decision.dedupe_key,
                    created_at=now,
                )
                session.add(note)
                session.flush()
                created.append((note.id, decision.title, decision.body))
                ctx.bump("items_processed")
        if created and self.guard.is_allowed(SideEffect.DESKTOP_NOTIFY):
            self._deliver_desktop(created)
        ctx.details["created"] = len(created)
        return JobStatus.SUCCEEDED

    def _deliver_desktop(self, created: list[tuple[int, str, str]]) -> None:
        self.guard.check(SideEffect.DESKTOP_NOTIFY, target=f"{len(created)} reminders")
        if len(created) > 3:
            delivered = self.toast(f"TaskRadar: {len(created)} 条新提醒", created[0][1])
        else:
            delivered = all(self.toast(title, body) for _, title, body in created)
        if delivered:
            with transaction(self._factory) as session:
                for note_id, _, _ in created:
                    note = session.get(Notification, note_id)
                    if note is not None:
                        note.desktop_sent_at = self.clock()

    def list_notifications(self, *, unread_only: bool = False, limit: int = 50) -> list[dict[str, Any]]:
        with transaction(self._factory) as session:
            stmt = _real(select(Notification)).order_by(Notification.created_at.desc()).limit(limit)
            if unread_only:
                stmt = stmt.where(Notification.read_at.is_(None))
            return [notification_to_dict(n) for n in session.scalars(stmt)]

    def unread_count(self) -> int:
        with transaction(self._factory) as session:
            return len(session.scalars(_real(select(Notification.id)).where(Notification.read_at.is_(None))).all())

    def mark_read(self, notification_id: int | None = None) -> None:
        with transaction(self._factory) as session:
            stmt = select(Notification).where(Notification.read_at.is_(None))
            if notification_id is not None:
                stmt = stmt.where(Notification.id == notification_id)
            for note in session.scalars(stmt):
                note.read_at = self.clock()


def _real(stmt: Select[Any]) -> Select[Any]:
    """Leave out notifications about tasks that were later marked as test data."""
    return stmt.outerjoin(Task, Task.id == Notification.task_id).where(
        or_(Notification.task_id.is_(None), Task.sample.is_(False) & Task.deleted_at.is_(None))
    )


def notification_to_dict(n: Notification) -> dict[str, Any]:
    return {
        "id": n.id,
        "task_id": n.task_id,
        "level": n.level,
        "title": n.title,
        "body": n.body,
        "created_at": n.created_at.isoformat(),
        "read": n.read_at is not None,
    }
