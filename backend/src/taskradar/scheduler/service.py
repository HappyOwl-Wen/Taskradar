"""Background automation with APScheduler.

Jobs (intervals come from user settings and are re-applied when settings change):

* reminder scan          - deterministic urgency evaluation + deduplicated notifications
* timer-<id>             - a wake-up at the end of each running Pomodoro phase or countdown

Every job is guarded by a database lock (see :mod:`taskradar.services.jobs`), so overlapping
runs are skipped rather than duplicated.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import logging
from typing import Any

from apscheduler.jobstores.base import JobLookupError
from apscheduler.schedulers.background import BackgroundScheduler

from taskradar.container import Container
from taskradar.domain.enums import JobTrigger
from taskradar.services.jobs import JobAlreadyRunning
from taskradar.services.settings import AppSettings

log = logging.getLogger(__name__)


class SchedulerService:
    def __init__(self, container: Container) -> None:
        self.c = container
        self.scheduler = BackgroundScheduler(
            timezone="UTC",
            job_defaults={"coalesce": True, "max_instances": 1, "misfire_grace_time": 600},
        )
        self._started = False

    # ------------------------------------------------------------------------------------------

    def start(self) -> None:
        if self._started:
            return
        recovered = self.c.jobs.recover_interrupted()
        if recovered:
            log.info("Marked %s interrupted job(s) for retry", recovered)
        self._configure(self.c.settings.get())
        self.c.settings.subscribe(self._on_settings_changed)
        self.scheduler.start()
        self._started = True
        self.c.timers.on_schedule = self._schedule_timer
        self.c.timers.on_unschedule = self._unschedule_timer
        try:
            self.c.timers.resume_schedule()
        except Exception:
            log.exception("Could not resume the running timers")
        # A first reminder pass shortly after start-up.
        self.scheduler.add_job(
            self._safe(self.reminders),
            "date",
            run_date=dt.datetime.now(dt.UTC) + dt.timedelta(seconds=10),
            id="reminders-initial",
            replace_existing=True,
        )
        log.info("Background scheduler started")

    def shutdown(self) -> None:
        if self._started:
            self.c.timers.on_schedule = None
            self.c.timers.on_unschedule = None
            self.scheduler.shutdown(wait=False)
            self._started = False

    def _schedule_timer(self, timer_id: int, at: dt.datetime) -> None:
        def due() -> None:
            self.c.timers.on_due(timer_id)

        due.__name__ = f"timer-{timer_id}"
        # However late (the computer slept): the timer still ends, and its notification says when it ended.
        self.scheduler.add_job(
            self._safe(due), "date", run_date=at, id=f"timer-{timer_id}", replace_existing=True, misfire_grace_time=None
        )

    def _unschedule_timer(self, timer_id: int) -> None:
        with contextlib.suppress(JobLookupError):
            self.scheduler.remove_job(f"timer-{timer_id}")

    def _on_settings_changed(self, settings: AppSettings, sections: set[str]) -> None:
        if sections & {"reminders", "calendar"}:
            self._configure(settings)

    def _configure(self, settings: AppSettings) -> None:
        jobs = [
            ("reminders", self.reminders, settings.reminders.scan_interval_minutes),
            ("calendar-workspace", self.calendar, settings.calendar.background_sync_minutes),
            ("trash-cleanup", self.trash, 60),
        ]
        for job_id, fn, minutes in jobs:
            self.scheduler.add_job(
                self._safe(fn),
                "interval",
                minutes=minutes,
                id=job_id,
                replace_existing=True,
                next_run_time=dt.datetime.now(dt.UTC) + dt.timedelta(minutes=minutes),
            )

    @staticmethod
    def _safe(fn: Any) -> Any:
        def wrapper() -> None:
            try:
                fn()
            except JobAlreadyRunning:
                log.debug("Skipped %s: already running", fn.__name__)
            except Exception:
                log.exception("Scheduled job %s failed", fn.__name__)

        wrapper.__name__ = wrapper.__qualname__ = getattr(fn, "__name__", "job")  # the job's name in the log
        return wrapper

    # ------------------------------------------------------------------------------------------

    def reminders(self) -> None:
        self.c.notifications.scan(JobTrigger.SCHEDULED)

    def calendar(self) -> None:
        self.c.workspace.refresh(background=True)

    def trash(self) -> None:
        with self.c.workspace.lock:
            self.c.data.purge_expired_tasks()

    # ------------------------------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        jobs = []
        if self._started:
            for job in self.scheduler.get_jobs():
                jobs.append(
                    {"id": job.id, "next_run_time": job.next_run_time.isoformat() if job.next_run_time else None}
                )
        return {"running": self._started, "jobs": jobs}
