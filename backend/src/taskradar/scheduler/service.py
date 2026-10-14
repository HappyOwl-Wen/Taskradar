"""Background automation with APScheduler.

Jobs (intervals come from user settings and are re-applied when settings change):

* reminder scan          - deterministic urgency evaluation + deduplicated notifications
* watched-folder scan    - incremental change detection
* Gmail sync             - only when Gmail is connected and auto-sync is enabled
* retry of failed jobs   - exponential backoff, bounded attempts

Every job is guarded by a database lock (see :mod:`taskradar.services.jobs`), so overlapping
runs are skipped rather than duplicated. Checkpoints live in the database, so a restart resumes.
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import select

from taskradar.container import Container
from taskradar.db.models import Source
from taskradar.db.session import transaction
from taskradar.domain.enums import JobKind, JobTrigger, SourceKind
from taskradar.services.jobs import MAX_ATTEMPTS, JobAlreadyRunning
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
            self.scheduler.shutdown(wait=False)
            self._started = False

    def _on_settings_changed(self, settings: AppSettings, sections: set[str]) -> None:
        if sections & {"reminders", "folders", "gmail"}:
            self._configure(settings)

    def _configure(self, settings: AppSettings) -> None:
        jobs = [
            ("reminders", self.reminders, settings.reminders.scan_interval_minutes),
            ("folders", self.folders, settings.folders.scan_interval_minutes),
            ("gmail", self.gmail, settings.gmail.sync_interval_minutes),
            ("retries", self.retries, 2),
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

        wrapper.__name__ = getattr(fn, "__name__", "job")
        return wrapper

    # ------------------------------------------------------------------------------------------

    def reminders(self) -> None:
        self.c.notifications.scan(JobTrigger.SCHEDULED)

    def folders(self) -> None:
        self.c.folders.scan_all(JobTrigger.SCHEDULED)

    def gmail(self) -> None:
        if not self.c.settings.get().gmail.auto_sync or not self.c.oauth.connected("gmail"):
            return
        with transaction(self.c.factory) as session:
            ids = [
                s.id
                for s in session.scalars(
                    select(Source).where(Source.kind == SourceKind.GMAIL.value, Source.enabled.is_(True))
                )
            ]
        for source_id in ids:
            try:
                self.c.gmail.sync(source_id, trigger=JobTrigger.SCHEDULED)
            except JobAlreadyRunning:
                continue

    def retries(self) -> None:
        for job in self.c.jobs.due_retries():
            attempt = int(job["attempt"]) + 1
            if attempt > MAX_ATTEMPTS or job["source_id"] is None:
                self.c.jobs.mark_retried(job["id"], None)
                continue
            try:
                if job["kind"] == JobKind.GMAIL_SYNC.value:
                    result = self.c.gmail.sync(job["source_id"], trigger=JobTrigger.RETRY, attempt=attempt)
                elif job["kind"] == JobKind.FOLDER_SCAN.value:
                    result = self.c.folders.scan(job["source_id"], trigger=JobTrigger.RETRY, attempt=attempt)
                else:
                    self.c.jobs.mark_retried(job["id"], None)
                    continue
            except JobAlreadyRunning:
                continue
            except LookupError:
                self.c.jobs.mark_retried(job["id"], None)
                continue
            self.c.jobs.mark_retried(job["id"], result.get("id"))

    # ------------------------------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        jobs = []
        if self._started:
            for job in self.scheduler.get_jobs():
                jobs.append(
                    {"id": job.id, "next_run_time": job.next_run_time.isoformat() if job.next_run_time else None}
                )
        return {"running": self._started, "jobs": jobs}
