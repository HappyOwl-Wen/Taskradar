"""Background job bookkeeping: mutual exclusion, statistics, failure classification and retries.

A partial unique index on ``sync_jobs(lock_key) WHERE status='running'`` guarantees that the same
sync cannot run twice concurrently - even across threads or processes sharing the database.
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from taskradar.connectors.errors import AuthRequiredError, ConnectorError
from taskradar.db.base import utcnow
from taskradar.db.models import SyncJob
from taskradar.db.session import transaction
from taskradar.domain.enums import JobKind, JobStatus, JobTrigger
from taskradar.security.redact import redact_secrets

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 5


class JobAlreadyRunning(Exception):
    code = "job_already_running"


class RecoverableJobError(Exception):
    """A failure that the scheduler may retry automatically later."""

    def __init__(self, code: str, message: str, *, auto_retry: bool = True):
        super().__init__(message)
        self.code = code
        self.message = message
        self.auto_retry = auto_retry


@dataclass
class JobContext:
    job_id: int
    counters: dict[str, int] = field(
        default_factory=lambda: {
            "items_seen": 0,
            "items_processed": 0,
            "items_skipped": 0,
            "items_failed": 0,
            "tasks_created": 0,
            "tasks_updated": 0,
        }
    )
    details: dict[str, Any] = field(default_factory=dict)

    def bump(self, name: str, n: int = 1) -> None:
        self.counters[name] = self.counters.get(name, 0) + n


def retry_delay(attempt: int) -> dt.timedelta:
    return dt.timedelta(minutes=min(60, 2**attempt))


class JobRunner:
    def __init__(self, session_factory: sessionmaker[Session], clock: Callable[[], dt.datetime] = utcnow) -> None:
        self._factory = session_factory
        self.clock = clock

    def start(
        self, kind: JobKind, *, lock_key: str, source_id: int | None, trigger: JobTrigger, attempt: int = 1
    ) -> int:
        try:
            with transaction(self._factory) as session:
                job = SyncJob(
                    source_id=source_id,
                    kind=kind.value,
                    trigger=trigger.value,
                    lock_key=lock_key,
                    status=JobStatus.RUNNING.value,
                    started_at=self.clock(),
                    attempt=attempt,
                )
                session.add(job)
                session.flush()
                return job.id
        except IntegrityError as exc:
            raise JobAlreadyRunning(f"A {kind.value} job is already running") from exc

    def finish(
        self,
        job_id: int,
        ctx: JobContext,
        *,
        status: JobStatus,
        error_code: str | None = None,
        error_message: str | None = None,
        recoverable: bool = True,
        next_retry_at: dt.datetime | None = None,
    ) -> dict[str, Any]:
        with transaction(self._factory) as session:
            job = session.get(SyncJob, job_id)
            assert job is not None
            job.status = status.value
            job.finished_at = self.clock()
            for key, value in ctx.counters.items():
                if hasattr(job, key):
                    setattr(job, key, value)
            job.error_code = error_code
            job.error_message = redact_secrets(error_message)[:1000] if error_message else None
            job.recoverable = recoverable
            job.next_retry_at = next_retry_at
            job.details = ctx.details
            session.flush()
            return job_to_dict(job)

    def run(
        self,
        kind: JobKind,
        *,
        lock_key: str,
        fn: Callable[[JobContext], JobStatus],
        source_id: int | None = None,
        trigger: JobTrigger = JobTrigger.MANUAL,
        attempt: int = 1,
    ) -> dict[str, Any]:
        job_id = self.start(kind, lock_key=lock_key, source_id=source_id, trigger=trigger, attempt=attempt)
        return self.execute(job_id, kind, fn, attempt=attempt)

    def execute(
        self, job_id: int, kind: JobKind, fn: Callable[[JobContext], JobStatus], *, attempt: int = 1
    ) -> dict[str, Any]:
        """Run the body of a job created with :meth:`start` and record its outcome."""
        ctx = JobContext(job_id)
        try:
            status = fn(ctx)
        except AuthRequiredError as exc:
            return self.finish(
                job_id,
                ctx,
                status=JobStatus.FAILED,
                error_code=exc.code,
                error_message=str(exc),
                recoverable=True,
                next_retry_at=None,
            )
        except RecoverableJobError as exc:
            next_retry = self.clock() + retry_delay(attempt) if exc.auto_retry and attempt < MAX_ATTEMPTS else None
            return self.finish(
                job_id,
                ctx,
                status=JobStatus.FAILED,
                error_code=exc.code,
                error_message=exc.message,
                recoverable=True,
                next_retry_at=next_retry,
            )
        except ConnectorError as exc:
            next_retry = self.clock() + retry_delay(attempt) if exc.recoverable and attempt < MAX_ATTEMPTS else None
            return self.finish(
                job_id,
                ctx,
                status=JobStatus.FAILED,
                error_code=exc.code,
                error_message=str(exc),
                recoverable=exc.recoverable,
                next_retry_at=next_retry,
            )
        except Exception as exc:
            log.exception("Job %s (%s) failed unexpectedly", job_id, kind.value)
            return self.finish(
                job_id,
                ctx,
                status=JobStatus.FAILED,
                error_code="internal_error",
                error_message=f"{exc.__class__.__name__}: {exc}",
                recoverable=False,
            )
        return self.finish(job_id, ctx, status=status)

    def recover_interrupted(self) -> int:
        """Called at startup: jobs left 'running' by a crash or shutdown are marked interrupted."""
        with transaction(self._factory) as session:
            jobs = session.scalars(select(SyncJob).where(SyncJob.status == JobStatus.RUNNING.value)).all()
            for job in jobs:
                job.status = JobStatus.INTERRUPTED.value
                job.finished_at = self.clock()
                job.error_code = "interrupted"
                job.error_message = "TaskRadar was stopped while this job was running; it will run again."
                job.recoverable = True
                job.next_retry_at = self.clock()
            return len(jobs)

    def due_retries(self) -> list[dict[str, Any]]:
        now = self.clock()
        with transaction(self._factory) as session:
            jobs = session.scalars(
                select(SyncJob).where(
                    SyncJob.status.in_([JobStatus.FAILED.value, JobStatus.INTERRUPTED.value]),
                    SyncJob.recoverable.is_(True),
                    SyncJob.next_retry_at.isnot(None),
                    SyncJob.next_retry_at <= now,
                    SyncJob.retried_by_job_id.is_(None),
                )
            ).all()
            return [job_to_dict(j) for j in jobs]

    def mark_retried(self, job_id: int, new_job_id: int | None) -> None:
        with transaction(self._factory) as session:
            job = session.get(SyncJob, job_id)
            if job is not None:
                job.retried_by_job_id = new_job_id if new_job_id is not None else -1


def job_to_dict(job: SyncJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "source_id": job.source_id,
        "kind": job.kind,
        "trigger": job.trigger,
        "status": job.status,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "items_seen": job.items_seen,
        "items_processed": job.items_processed,
        "items_skipped": job.items_skipped,
        "items_failed": job.items_failed,
        "tasks_created": job.tasks_created,
        "tasks_updated": job.tasks_updated,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "recoverable": job.recoverable,
        "attempt": job.attempt,
        "next_retry_at": job.next_retry_at.isoformat() if job.next_retry_at else None,
        "details": job.details or {},
    }
