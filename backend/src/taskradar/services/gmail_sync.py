"""Gmail synchronisation (initial window + incremental history), idempotent and resumable.

* First sync (or after the look-back window changed): list messages of the last N days.
* Later syncs: Gmail history since the stored ``historyId`` (falls back to a window listing when
  the history is too old).
* Messages are processed oldest-first so reminders and confirmations come after the original.
* Already processed messages are skipped (Gmail messages are immutable), so retries are safe.
* The checkpoint only advances when every message of the batch was handled; failed items are
  retried by the next run.
* Unread / read state is never read as "done" and never modified.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.connectors.errors import (
    AuthRequiredError,
    ConnectorError,
    NotFoundError,
    RateLimitedError,
    TransientError,
    call_with_retries,
)
from taskradar.connectors.gmail import GmailClient
from taskradar.db.base import utcnow
from taskradar.db.models import Message, Source, SyncCheckpoint
from taskradar.db.session import transaction
from taskradar.domain.enums import ItemStatus, JobKind, JobStatus, JobTrigger, SourceKind, SourceStatus
from taskradar.parsing.email_mime import gmail_web_link, parse_gmail_message
from taskradar.security.permissions import PermissionDenied, PermissionGuard, SideEffect
from taskradar.services.documents import DocumentService, ImportResult
from taskradar.services.jobs import JobContext, JobRunner, RecoverableJobError
from taskradar.services.settings import SettingsService

log = logging.getLogger(__name__)

ClientFactory = Callable[[Source], GmailClient]


class GmailSyncService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        settings: SettingsService,
        documents: DocumentService,
        jobs: JobRunner,
        guard: PermissionGuard,
        client_factory: ClientFactory,
        clock: Callable[[], dt.datetime] = utcnow,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._factory = session_factory
        self.settings = settings
        self.documents = documents
        self.jobs = jobs
        self.guard = guard
        self.client_factory = client_factory
        self.clock = clock
        self.sleep = sleep

    # ------------------------------------------------------------------------------------------

    def sync(self, source_id: int, *, trigger: JobTrigger = JobTrigger.MANUAL, attempt: int = 1) -> dict[str, Any]:
        return self.jobs.run(
            JobKind.GMAIL_SYNC, lock_key=f"gmail:{source_id}", source_id=source_id, trigger=trigger, attempt=attempt,
            fn=lambda ctx: self._sync(ctx, source_id),
        )

    def _retry(self, fn: Callable[[], Any]) -> Any:
        return call_with_retries(fn, max_attempts=4, base_delay=1.0, max_delay=16.0, sleep=self.sleep)

    def _checkpoint(self, session: Session, source_id: int, key: str) -> str | None:
        row = session.scalar(select(SyncCheckpoint).where(SyncCheckpoint.source_id == source_id, SyncCheckpoint.key == key))
        return row.value if row else None

    def _set_checkpoint(self, session: Session, source_id: int, key: str, value: str) -> None:
        row = session.scalar(select(SyncCheckpoint).where(SyncCheckpoint.source_id == source_id, SyncCheckpoint.key == key))
        if row is None:
            session.add(SyncCheckpoint(source_id=source_id, key=key, value=value))
        else:
            row.value = value

    def _source_state(self, source_id: int, *, status: SourceStatus, code: str | None = None,
                      message: str | None = None, success: bool = False, account: str | None = None) -> None:
        with transaction(self._factory) as session:
            source = session.get(Source, source_id)
            if source is None:
                return
            source.status = status.value
            source.last_sync_at = self.clock()
            source.last_error_code = code
            source.last_error_message = message
            if success:
                source.last_success_at = self.clock()
            if account and not source.account:
                source.account = account

    # ------------------------------------------------------------------------------------------

    def _sync(self, ctx: JobContext, source_id: int) -> JobStatus:
        settings = self.settings.get().gmail
        with transaction(self._factory) as session:
            source = session.get(Source, source_id)
            if source is None or source.kind not in (SourceKind.GMAIL.value, SourceKind.DEMO_MAIL.value):
                raise LookupError("Mail source not found")
            is_demo = source.kind == SourceKind.DEMO_MAIL.value
            account = source.account
            checkpoint = self._checkpoint(session, source_id, "history_id")
            window = self._checkpoint(session, source_id, "lookback_days")
            session.expunge(source)

        try:
            self.guard.check(SideEffect.GMAIL_READ, target=account or "gmail", demo=is_demo)
        except PermissionDenied as exc:
            self._source_state(source_id, status=SourceStatus.AUTH_REQUIRED, code=exc.code, message=exc.message)
            raise AuthRequiredError(exc.message) from exc

        try:
            client = self.client_factory(source)
            ids, new_history, profile_email = self._collect_ids(client, checkpoint, window, settings)
            ctx.details["mode"] = "incremental" if checkpoint and window == str(settings.lookback_days) else "window"
            ctx.bump("items_seen", len(ids))
            failures = 0
            for gmail_id in ids:
                try:
                    handled = self._handle_message(ctx, client, source, gmail_id, settings, is_demo)
                except (AuthRequiredError, RateLimitedError, TransientError):
                    raise
                except ConnectorError as exc:
                    log.warning("Skipping Gmail message after error: %s", exc.code)
                    ctx.bump("items_failed")
                    failures += 1
                    continue
                if not handled:
                    failures += 1
            with transaction(self._factory) as session:
                if failures == 0 and new_history:
                    self._set_checkpoint(session, source_id, "history_id", str(new_history))
                    self._set_checkpoint(session, source_id, "lookback_days", str(settings.lookback_days))
                self._set_checkpoint(session, source_id, "last_run_at", self.clock().isoformat())
            self._source_state(source_id, status=SourceStatus.OK, success=failures == 0, account=profile_email)
            return JobStatus.PARTIAL if failures else JobStatus.SUCCEEDED
        except AuthRequiredError as exc:
            self._source_state(source_id, status=SourceStatus.AUTH_REQUIRED, code=exc.code, message=str(exc))
            raise
        except (RateLimitedError, TransientError) as exc:
            self._source_state(source_id, status=SourceStatus.ERROR, code=exc.code, message=str(exc))
            raise RecoverableJobError(exc.code, f"{exc} - data is kept and the sync will be retried") from exc

    def _collect_ids(
        self, client: GmailClient, checkpoint: str | None, window: str | None, settings: Any
    ) -> tuple[list[str], str | None, str | None]:
        if checkpoint and window == str(settings.lookback_days):
            try:
                ids: list[str] = []
                page: str | None = None
                latest = checkpoint
                while True:
                    batch, page, history = self._retry(lambda: client.list_history(checkpoint, page))
                    ids.extend(batch)
                    latest = history or latest
                    if not page:
                        break
                # history is chronological already; de-duplicate while keeping order
                seen: set[str] = set()
                ordered = [i for i in ids if not (i in seen or seen.add(i))]  # type: ignore[func-returns-value]
                return ordered[: settings.max_messages_per_sync], latest, None
            except NotFoundError:
                log.info("Gmail history checkpoint expired; falling back to a window sync")
        profile = self._retry(client.get_profile)
        query = f"newer_than:{settings.lookback_days}d -in:chats {settings.query_extra}".strip()
        ids = []
        page = None
        while True:
            batch, page = self._retry(lambda: client.list_message_ids(query, page, 100))
            ids.extend(batch)
            if not page or len(ids) >= settings.max_messages_per_sync:
                break
        ids = ids[: settings.max_messages_per_sync]
        ids.reverse()  # Gmail lists newest first; process oldest first
        return ids, str(profile.get("historyId") or ""), profile.get("emailAddress")

    def _handle_message(
        self, ctx: JobContext, client: GmailClient, source: Source, gmail_id: str, settings: Any, is_demo: bool
    ) -> bool:
        with transaction(self._factory) as session:
            existing = session.scalar(
                select(Message).where(Message.source_id == source.id, Message.external_id == gmail_id)
            )
            if existing is not None and existing.status in (ItemStatus.PROCESSED.value, ItemStatus.SKIPPED.value):
                ctx.bump("items_skipped")
                return True
            existing_id = existing.id if existing is not None else None

        if existing_id is None:
            raw = self._retry(lambda: client.get_message(gmail_id))
            labels = set(raw.get("labelIds") or [])
            normalized = parse_gmail_message(raw)
            with transaction(self._factory) as session:
                db_source = session.get(Source, source.id)
                assert db_source is not None
                message, _ = self.documents.store_message(
                    session, normalized, source=db_source,
                    web_link=None if is_demo else gmail_web_link(gmail_id, db_source.account),
                )
                if "DRAFT" in labels or ("SENT" in labels and "INBOX" not in labels):
                    message.status = ItemStatus.SKIPPED.value
                    message.skip_reason = "sent_or_draft"
                    ctx.bump("items_skipped")
                    return True
                message_id = message.id
                if settings.process_attachments:
                    limit = settings.max_attachment_mb * 1024 * 1024
                    for att in normalized.attachments:
                        if att.inline_data or not att.attachment_id:
                            continue  # inline data was stored by store_message
                        if att.size > limit:
                            ctx.details.setdefault("skipped_attachments", 0)
                            ctx.details["skipped_attachments"] += 1
                            continue
                        data = self._retry(lambda a=att: client.get_attachment(gmail_id, a.attachment_id))
                        self.documents.store_attachment(session, data, att.filename, message=message)
        else:
            message_id = existing_id

        result = self.documents.process_message_with_attachments(
            message_id, None, ImportResult(filename=gmail_id, status="processed", created=True, message_id=message_id)
        )
        if result.status == "failed":
            ctx.bump("items_failed")
            return False
        ctx.bump("items_processed")
        ctx.bump("tasks_created", result.tasks_created)
        ctx.bump("tasks_updated", result.tasks_updated + result.completions_applied)
        return True
