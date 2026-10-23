"""Local-first calendar read model and Google cache coordination.

Collection sync uses singleEvents=False and no time bounds. Visible windows use a separate
singleEvents=True request with timeMin/timeMax and NEVER syncToken. Google expands recurrence
rules and exceptions in the event's zone. Each paginated result is committed atomically.
"""

from __future__ import annotations

import datetime as dt
import threading
import uuid
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select

from taskradar.connectors.calendar import CalendarClient, GoogleCalendarClient
from taskradar.connectors.errors import ConnectorError, NotFoundError, SyncTokenExpired
from taskradar.connectors.google_oauth import LIST_SCOPE, OAuthError
from taskradar.db.calendar_models import CalendarDraft, CalendarSource, CalendarWindow, GoogleEvent, WorkBlock
from taskradar.db.models import CalendarLink, Setting, Task
from taskradar.db.session import transaction
from taskradar.domain.calendar import EventForm, simple_event
from taskradar.domain.enums import Actor, JobKind, JobStatus, JobTrigger
from taskradar.services.calendar_sync import CalendarSyncError, build_event, payload_hash
from taskradar.services.jobs import JobContext, retry_delay

if TYPE_CHECKING:
    from taskradar.container import Container


def iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value else None


def event_times(event: dict[str, Any]) -> tuple[str, str, bool]:
    start, end = event.get("start", {}), event.get("end", {})
    return start.get("dateTime") or start.get("date", ""), end.get("dateTime") or end.get("date", ""), "date" in start


def safe_link(event: dict[str, Any]) -> str | None:
    link = event.get("htmlLink", "")
    return (
        link
        if link.startswith("https://calendar.google.com/") or link.startswith("https://www.google.com/calendar/")
        else None
    )


def block_dict(block: WorkBlock) -> dict[str, Any]:
    return {
        "id": f"work:{block.id}",
        "work_block_id": block.id,
        "kind": "work",
        "title": block.title,
        "start": block.start_at.isoformat(),
        "end": block.end_at.isoformat(),
        "all_day": False,
        "timezone": block.timezone,
        "task_id": block.task_id,
        "revision": block.revision,
        "calendar_id": block.calendar_id,
        "event_id": block.event_id,
        "sync_status": block.sync_status,
        "editable": not block.event_id,
        "source_name": "local",
        "color": "#4f46e5",
    }


class CalendarWorkspace:
    def __init__(self, container: Container) -> None:
        self.c = container
        self.lock = threading.RLock()
        self.window_lock = threading.Lock()

    def validate_account(self, credentials: Any, scopes: set[str]) -> None:
        """Do not replace an existing account's token during incremental consent."""
        client = GoogleCalendarClient(credentials)
        if LIST_SCOPE in scopes:
            primary = client.get_calendar("primary")["id"]
            with transaction(self.c.factory) as session:
                row = session.get(Setting, "calendar_account")
                if row and row.value.get("id") != primary:
                    raise OAuthError("calendar_account_mismatch", "This workspace is bound to another Google account")
        own = self.c.calendar.status().get("calendar_id")
        if own and not client.calendar_exists(own):
            raise OAuthError("calendar_account_mismatch", "Use the account that owns the existing TaskRadar calendar")

    def sources(self) -> dict[str, Any]:
        caps = self.c.oauth.capabilities()
        cfg = self.c.settings.get().calendar
        with transaction(self.c.factory) as session:
            sources = [
                {
                    "id": s.id,
                    "summary": s.summary,
                    "timezone": s.timezone,
                    "color": s.color,
                    "access_role": s.access_role,
                    "primary": s.primary,
                    "selected": s.selected,
                    "app_created": s.app_created,
                    "available": s.available,
                    "last_synced_at": iso(s.last_synced_at),
                    "last_error": s.last_error,
                    "retry_at": iso(s.retry_at),
                    "writable": self.can_write(s, caps),
                }
                for s in session.scalars(select(CalendarSource).order_by(CalendarSource.summary))
            ]
        return {
            "sources": sources,
            "capabilities": caps,
            "default_calendar_id": cfg.default_calendar_id,
            "google_edit_enabled": cfg.google_edit_enabled,
        }

    def can_write(self, source: CalendarSource, caps: dict[str, Any] | None = None) -> bool:
        caps = caps or self.c.oauth.capabilities()
        return bool(
            caps["connected"]
            and source.available
            and source.selected
            and source.access_role in ("writer", "owner")
            and (
                (source.app_created and caps["app"])
                or (caps["edit"] and self.c.settings.get().calendar.google_edit_enabled)
            )
        )

    def select_sources(self, selected: list[str], default: str | None, editing: bool) -> dict[str, Any]:
        with self.lock, transaction(self.c.factory) as session:
            sources = session.scalars(select(CalendarSource)).all()
            if set(selected) - {s.id for s in sources}:
                raise CalendarSyncError("calendar_not_found", "Refresh the calendar list first", 422)
            for source in sources:
                source.selected = source.id in selected
            if default and not any(
                s.id == default and s.selected and s.available and s.access_role in ("owner", "writer") for s in sources
            ):
                raise CalendarSyncError("calendar_read_only", "Choose a selected writable default calendar", 422)
        self.c.settings.update({"calendar": {"default_calendar_id": default, "google_edit_enabled": editing}})
        return self.sources()

    def discover(self, client: CalendarClient) -> None:
        caps = self.c.oauth.capabilities()
        own = self.c.calendar.status().get("calendar_id")
        entries: list[dict[str, Any]] = []
        if caps["read"]:
            entries, _ = self._pages(lambda **p: client.list_calendars(**p), {"maxResults": 250, "showHidden": True})
        elif own and caps["app"]:
            entries = [
                {
                    "id": own,
                    "summary": self.c.settings.get().calendar.calendar_name,
                    "timeZone": self.c.settings.get().general.timezone,
                    "accessRole": "owner",
                }
            ]
        with transaction(self.c.factory) as session:
            primary = next((e["id"] for e in entries if e.get("primary")), None)
            account = session.get(Setting, "calendar_account")
            if primary and account and account.value.get("id") != primary:
                raise CalendarSyncError("calendar_account_mismatch", "Use the same Google account", 409)
            if primary and not account:
                session.add(Setting(key="calendar_account", value={"id": primary}))
            if caps["read"]:
                for old_source in session.scalars(select(CalendarSource)):
                    old_source.available = False
            for entry in entries:
                source = session.get(CalendarSource, entry["id"])
                if source is None:
                    source = CalendarSource(
                        id=entry["id"],
                        summary=entry.get("summary", entry["id"]),
                        selected=bool(entry.get("primary") or entry["id"] == own),
                    )
                    session.add(source)
                source.summary = entry.get("summary", source.summary)
                source.timezone = entry.get("timeZone", self.c.settings.get().general.timezone)
                source.color = entry.get("backgroundColor", "#4285f4")
                source.access_role = entry.get("accessRole", "reader")
                source.primary = bool(entry.get("primary"))
                source.app_created = entry["id"] == own
                source.available = not entry.get("deleted", False)

    @staticmethod
    def _pages(fetch: Any, params: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
        items: list[dict[str, Any]] = []
        page: str | None = None
        seen: set[str] = set()
        while True:
            response = fetch(**params, **({"pageToken": page} if page else {}))
            items.extend(response.get("items", []))
            page = response.get("nextPageToken")
            if not page:
                return items, response.get("nextSyncToken")
            if page in seen:
                raise CalendarSyncError("calendar_pagination", "Google returned a repeated page token", 502)
            seen.add(page)

    def ensure_window(self, start: dt.date, end: dt.date) -> None:
        timezone = self.c.settings.get().general.timezone
        if not 0 < (end - start).days <= 100:
            raise CalendarSyncError("invalid_range", "Choose a range of 1 to 100 days", 422)
        with self.window_lock, transaction(self.c.factory) as session:
            for source in session.scalars(select(CalendarSource).where(CalendarSource.selected.is_(True))):
                window = session.scalar(
                    select(CalendarWindow).where(
                        CalendarWindow.calendar_id == source.id,
                        CalendarWindow.start_date == start,
                        CalendarWindow.end_date == end,
                        CalendarWindow.timezone == timezone,
                    )
                )
                if window:
                    window.accessed_at = self.c.clock()
                else:
                    session.add(
                        CalendarWindow(calendar_id=source.id, start_date=start, end_date=end, timezone=timezone)
                    )

    def refresh(
        self, start: dt.date | None = None, end: dt.date | None = None, *, background: bool = False
    ) -> dict[str, Any]:
        if not self.c.oauth.connected("calendar"):
            return {"status": "local", **self.sources()}
        if background:
            with transaction(self.c.factory) as session:
                row = session.get(Setting, "calendar_refresh_state")
                state = row.value if row else {}
            if state.get("auth_required") and state.get("authorization_seq") == (self.c.oauth.last_result or {}).get(
                "seq", 0
            ):
                return {"status": "waiting_for_authorization"}
            if state.get("retry_at") and dt.datetime.fromisoformat(state["retry_at"]) > self.c.clock():
                return {"status": "backoff"}

        def run(ctx: JobContext) -> JobStatus:
            with self.lock:
                try:
                    client = self.c.calendar.client_factory()
                    self.discover(client)
                except ConnectorError as exc:
                    with transaction(self.c.factory) as session:
                        row = session.get(Setting, "calendar_refresh_state")
                        failures = int((row.value if row else {}).get("failures", 0)) + 1
                        delay = max(retry_delay(failures).total_seconds(), exc.retry_after or 0)
                        value = {
                            "auth_required": exc.code == "auth_required",
                            "authorization_seq": (self.c.oauth.last_result or {}).get("seq", 0),
                            "retry_at": iso(self.c.clock() + dt.timedelta(seconds=delay)),
                            "failures": failures,
                        }
                        if row:
                            row.value = value
                        else:
                            session.add(Setting(key="calendar_refresh_state", value=value))
                    raise
                with transaction(self.c.factory) as session:
                    row = session.get(Setting, "calendar_refresh_state")
                    if row:
                        row.value = {}
                if start and end:
                    self.ensure_window(start, end)
                with transaction(self.c.factory) as session:
                    sources = session.scalars(
                        select(CalendarSource).where(
                            CalendarSource.selected.is_(True), CalendarSource.available.is_(True)
                        )
                    ).all()
                for source in sources:
                    # Auth/ACL errors require user action; transient failures use bounded exponential backoff.
                    if background and (
                        source.last_error == "auth_required" or (source.retry_at and source.retry_at > self.c.clock())
                    ):
                        continue
                    try:
                        self._sync_source(client, source)
                        ctx.bump("items_processed")
                    except (ConnectorError, CalendarSyncError) as exc:
                        ctx.bump("items_failed")
                        with transaction(self.c.factory) as session:
                            failed_source = session.get(CalendarSource, source.id)
                            assert failed_source
                            failed_source.last_error = exc.code
                            failed_source.failures += 1
                            delay = max(
                                retry_delay(failed_source.failures).total_seconds(), getattr(exc, "retry_after", 0) or 0
                            )
                            failed_source.retry_at = self.c.clock() + dt.timedelta(seconds=delay)
                return JobStatus.PARTIAL if ctx.counters["items_failed"] else JobStatus.SUCCEEDED

        return self.c.jobs.run(
            JobKind.CALENDAR_SYNC,
            lock_key="calendar-workspace",
            fn=run,
            trigger=JobTrigger.SCHEDULED if background else JobTrigger.MANUAL,
        )

    def _sync_source(self, client: CalendarClient, source: CalendarSource) -> None:
        params: dict[str, Any] = {"singleEvents": False, "showDeleted": True, "maxResults": 2500}
        full = not source.sync_token
        if source.sync_token:
            params["syncToken"] = source.sync_token
        try:
            changes, token = self._pages(lambda **p: client.list_events(source.id, **p), params)
        except SyncTokenExpired:
            params.pop("syncToken", None)
            changes, token = self._pages(lambda **p: client.list_events(source.id, **p), params)
            full = True
        if not token:
            raise CalendarSyncError("calendar_sync_incomplete", "Missing final sync token; cache retained", 502)
        if full:
            # Deleted events may no longer appear in a full collection after token expiry.
            with transaction(self.c.factory) as session:
                linked_ids = set(
                    session.scalars(
                        select(CalendarLink.event_id).where(
                            CalendarLink.calendar_id == source.id, CalendarLink.status != "removed"
                        )
                    )
                )
                linked_ids.update(
                    session.scalars(
                        select(WorkBlock.event_id).where(
                            WorkBlock.calendar_id == source.id, WorkBlock.event_id.isnot(None)
                        )
                    )
                )
            for event_id in linked_ids - {event["id"] for event in changes}:
                if not event_id:
                    continue
                try:
                    changes.append(client.get_event(source.id, event_id))
                except NotFoundError:
                    changes.append({"id": event_id, "status": "cancelled"})
        with transaction(self.c.factory) as session:
            if full:
                session.execute(delete(GoogleEvent).where(GoogleEvent.calendar_id == source.id))
            for event in changes:
                row = session.get(GoogleEvent, (source.id, event["id"]))
                if row:
                    row.payload = event
                else:
                    session.add(GoogleEvent(calendar_id=source.id, event_id=event["id"], payload=event))
                self._reconcile(session, source.id, event)
            stored = session.get(CalendarSource, source.id)
            assert stored
            stored.sync_token = token
        # Refresh up to six recently visited windows; others remain readable with their original timestamp.
        with transaction(self.c.factory) as session:
            windows = session.scalars(
                select(CalendarWindow)
                .where(CalendarWindow.calendar_id == source.id)
                .order_by(CalendarWindow.accessed_at.desc(), CalendarWindow.id.desc())
                .limit(6)
            ).all()
        for window in windows:
            zone = ZoneInfo(window.timezone)
            lo = dt.datetime.combine(window.start_date, dt.time(), zone).isoformat()
            hi = dt.datetime.combine(window.end_date, dt.time(), zone).isoformat()
            events, _ = self._pages(
                lambda **p: client.list_events(source.id, **p),
                {
                    "singleEvents": True,
                    "showDeleted": False,
                    "maxResults": 2500,
                    "timeMin": lo,
                    "timeMax": hi,
                    "timeZone": window.timezone,
                },
            )
            with transaction(self.c.factory) as session:
                saved = session.get(CalendarWindow, window.id)
                if saved:
                    saved.events = events
                    saved.last_synced_at = self.c.clock()
        with transaction(self.c.factory) as session:
            stored = session.get(CalendarSource, source.id)
            assert stored
            stored.last_synced_at = self.c.clock()
            stored.last_error, stored.retry_at, stored.failures = None, None, 0

    def _reconcile(self, session: Any, calendar_id: str, event: dict[str, Any]) -> None:
        """Links, never title matching, define identity. A remote delete never deletes a task/block."""
        link = session.scalar(
            select(CalendarLink).where(CalendarLink.calendar_id == calendar_id, CalendarLink.event_id == event["id"])
        )
        if link and link.status != "removed":
            if event.get("status") == "cancelled":
                link.status, link.last_error = "removed", "remote_deleted"
            elif link.etag and link.etag != event.get("etag"):
                link.status, link.last_error = "out_of_sync", "remote_changed"
            link.remote_payload = event
            # Preserve the last accepted etag so a task push cannot erase remote edits.
            if not link.etag:
                link.etag = event.get("etag")
        block = session.scalar(
            select(WorkBlock).where(WorkBlock.calendar_id == calendar_id, WorkBlock.event_id == event["id"])
        )
        if not block:
            return
        if event.get("status") == "cancelled":
            block.sync_status = "remote_deleted"
        elif simple_event(event) and "dateTime" in event.get("start", {}) and "dateTime" in event.get("end", {}):
            block.title = event.get("summary", block.title)[:200]
            block.start_at = dt.datetime.fromisoformat(event["start"]["dateTime"])
            block.end_at = dt.datetime.fromisoformat(event["end"]["dateTime"])
            if block.etag != event.get("etag"):
                block.revision += 1
            block.etag, block.sync_status = event.get("etag"), "synced"
        else:
            block.sync_status = "needs_review"

    def view(self, start: dt.date, end: dt.date) -> dict[str, Any]:
        self.ensure_window(start, end)
        zone = ZoneInfo(self.c.settings.get().general.timezone)
        lo, hi = dt.datetime.combine(start, dt.time(), zone), dt.datetime.combine(end, dt.time(), zone)
        items: list[dict[str, Any]] = []
        unscheduled = []
        with transaction(self.c.factory) as session:
            tasks = session.execute(
                select(Task.id, Task.title, Task.status, Task.due_date, Task.due_time, Task.timezone).where(
                    Task.sample.is_(False), Task.status != "dismissed", Task.deleted_at.is_(None)
                )
            ).all()
            links = {link.task_id: link for link in session.scalars(select(CalendarLink))}
            blocks = session.scalars(select(WorkBlock)).all()
            scheduled_task_ids = {block.task_id for block in blocks if block.task_id is not None}
            task_map = {t.id: t for t in tasks}
            trashed_ids = set(session.scalars(select(Task.id).where(Task.deleted_at.isnot(None))))
            sources = {s.id: s for s in session.scalars(select(CalendarSource))}
            remote: dict[tuple[str, str], dict[str, Any]] = {}
            windows = session.scalars(
                select(CalendarWindow).where(
                    CalendarWindow.start_date == start,
                    CalendarWindow.end_date == end,
                    CalendarWindow.timezone == str(zone),
                )
            ).all()
            updated = {}
            for window in windows:
                source = sources[window.calendar_id]
                if not source.selected:
                    continue
                updated[source.id] = iso(window.last_synced_at)
                for cached_event in window.events:
                    if cached_event.get("status") != "cancelled":
                        remote[(source.id, cached_event["id"])] = cached_event
            for task in tasks:
                if not task.due_date:
                    if task.status != "completed" and task.id not in scheduled_task_ids:
                        unscheduled.append({"id": task.id, "title": task.title})
                    continue
                date = task.due_date
                if task.due_time:
                    due = dt.datetime.combine(date, dt.time.fromisoformat(task.due_time), ZoneInfo(task.timezone))
                    date = due.astimezone(zone).date()
                if not start <= date < end:
                    continue
                link = links.get(task.id)
                event = remote.pop((link.calendar_id, link.event_id), None) if link else None
                items.append(
                    {
                        "id": f"task:{task.id}",
                        "kind": "deadline",
                        "title": task.title,
                        "start": date.isoformat(),
                        "end": (date + dt.timedelta(days=1)).isoformat(),
                        "all_day": True,
                        "task_id": task.id,
                        "task_status": task.status,
                        "timezone": task.timezone,
                        "due_date": task.due_date.isoformat(),
                        "due_time": task.due_time,
                        "sync_status": link.status if link else "local",
                        "calendar_id": link.calendar_id if link else None,
                        "event_id": link.event_id if link else None,
                        "remote": event or (link.remote_payload if link else None),
                        "source_name": sources[link.calendar_id].summary
                        if link and link.calendar_id in sources
                        else "local",
                        "editable": False,
                        "color": "#b45309",
                        "html_link": link.html_link if link else None,
                        "needs_review": bool(link and link.last_error == "remote_changed"),
                    }
                )
            for block in blocks:
                event = remote.pop((block.calendar_id or "", block.event_id), None) if block.event_id else None
                if block.start_at < hi and block.end_at > lo:
                    item = block_dict(block)
                    block_source = sources.get(block.calendar_id or "")
                    item.update(
                        {
                            "remote": event,
                            "source_name": block_source.summary if block_source else "local",
                            "editable": self.can_write(block_source) and simple_event(event)
                            if block_source and event
                            else not block.event_id,
                            "html_link": safe_link(event) if event else None,
                            "task_status": task_map[block.task_id].status if block.task_id in task_map else None,
                            "task_id": block.task_id if block.task_id not in trashed_ids else None,
                        }
                    )
                    items.append(item)
            # A legacy task whose deadline moved outside this window still owns its event identity.
            owner_by_remote = {
                (link.calendar_id, link.event_id): link.task_id for link in links.values() if link.task_id in task_map
            }
            for (cal_id, event_id), event in remote.items():
                source = sources[cal_id]
                a, b, all_day = event_times(event)
                if not a or not b:
                    continue
                items.append(
                    {
                        "id": f"google:{cal_id}:{event_id}",
                        "kind": "google",
                        "title": event.get("summary", ""),
                        "start": a,
                        "end": b,
                        "all_day": all_day,
                        "calendar_id": cal_id,
                        "event_id": event_id,
                        "task_id": owner_by_remote.get((cal_id, event_id)),
                        "timezone": source.timezone,
                        "source_name": source.summary,
                        "color": source.color,
                        "remote": event,
                        "editable": self.can_write(source)
                        and simple_event(event)
                        and (cal_id, event_id) not in owner_by_remote,
                        "sync_status": "cached",
                        "html_link": safe_link(event),
                        "complex": not simple_event(event),
                    }
                )
            drafts = [
                self.draft_dict(d)
                for d in session.scalars(select(CalendarDraft).where(CalendarDraft.status != "saved"))
            ]
        return {
            **self.sources(),
            "items": items,
            "unscheduled": unscheduled,
            "drafts": drafts,
            "window_updated": updated,
            "timezone": str(zone),
        }

    def save_block(
        self, task_id: str | None, form: EventForm, block_id: str | None = None, revision: int | None = None
    ) -> dict[str, Any]:
        if form.all_day:
            raise CalendarSyncError("work_requires_time", "A work block needs start and end times", 422)
        with self.lock, transaction(self.c.factory) as session:
            if task_id:
                self.c.tasks.get(session, task_id)
            if block_id:
                block = session.get(WorkBlock, block_id)
                if not block:
                    raise LookupError("Work block not found")
                if block.event_id:
                    raise CalendarSyncError("linked_event_edit", "Edit the linked Google event through its draft", 409)
                if block.revision != revision:
                    raise CalendarSyncError("event_conflict", "The work block changed; reopen it", 409)
                block.revision += 1
            else:
                block = WorkBlock(
                    id=str(uuid.uuid4()),
                    task_id=task_id,
                    title=form.title,
                    start_at=form.start_at,
                    end_at=form.end_at,
                    timezone=form.timezone,
                )
                session.add(block)
            block.title, block.start_at, block.end_at, block.timezone = (
                form.title,
                form.start_at,
                form.end_at,
                form.timezone,
            )
            session.flush()
            return block_dict(block)

    def delete_block(self, block_id: str) -> None:
        with self.lock, transaction(self.c.factory) as session:
            block = session.get(WorkBlock, block_id)
            if not block:
                raise LookupError("Work block not found")
            # Deleting a local work plan only unlinks it. Any Google event remains independently manageable.
            session.delete(block)

    def detach_block(self, block_id: str) -> dict[str, Any]:
        with self.lock, transaction(self.c.factory) as session:
            block = session.get(WorkBlock, block_id)
            if not block:
                raise LookupError("Work block not found")
            block.calendar_id, block.event_id, block.etag = None, None, None
            block.sync_status = "local"
            block.revision += 1
            return block_dict(block)

    def resolve_task_link(self, task_id: str, choice: str, etag: str) -> dict[str, Any]:
        with self.lock:
            with transaction(self.c.factory) as session:
                link = session.scalar(select(CalendarLink).where(CalendarLink.task_id == task_id))
                if not link:
                    raise LookupError("Calendar link not found")
                calendar_id, event_id = link.calendar_id, link.event_id
            current = self.c.calendar.client_factory().get_event(calendar_id, event_id)
            if current.get("etag") != etag:
                raise CalendarSyncError("event_conflict", "Refresh and compare the latest Google version first", 409)
            owner = current.get("extendedProperties", {}).get("private", {}).get("taskradar_task_id")
            if owner != task_id or not simple_event(current) or current.get("status") == "cancelled":
                raise CalendarSyncError(
                    "complex_event", "This change has no safe task mapping; use Google Calendar", 409
                )
            with transaction(self.c.factory) as session:
                task = self.c.tasks.get(session, task_id)
                link = session.scalar(select(CalendarLink).where(CalendarLink.task_id == task_id))
                assert link
                if choice == "remote":
                    start, end, all_day = event_times(current)
                    if all_day:
                        date = dt.date.fromisoformat(start)
                        if dt.date.fromisoformat(end) - date != dt.timedelta(days=1):
                            raise CalendarSyncError(
                                "complex_event", "A multi-day event cannot map to one deadline", 409
                            )
                        time = None
                    else:
                        instant = dt.datetime.fromisoformat(
                            end if task.time_semantics == "deadline" else start
                        ).astimezone(ZoneInfo(task.timezone))
                        date, time = instant.date(), instant.strftime("%H:%M")
                    title = current.get("summary", task.title).removeprefix("截止：").removeprefix("Deadline: ")
                    self.c.tasks.update_fields(
                        session, task, {"title": title, "due_date": date, "due_time": time}, actor=Actor.USER, lock=True
                    )
                    settings = self.c.settings.get()
                    link.payload_hash = payload_hash(
                        build_event(
                            task,
                            reminder_minutes=settings.calendar.reminder_minutes,
                            base_url=self.c.config.base_url,
                            language=settings.general.language,
                        )
                    )
                    link.synced_due_version, link.status = task.due_version, "synced"
                else:
                    link.payload_hash, link.status = None, "out_of_sync"
                link.etag, link.remote_payload, link.last_error = current.get("etag"), current, None
            if choice == "local":
                return self.c.calendar.sync(task_id, user_confirmed=True)
            return {"resolved": True}

    def task_blocks(self, task_id: str) -> list[dict[str, Any]]:
        with transaction(self.c.factory) as session:
            self.c.tasks.get(session, task_id)
            return [block_dict(b) for b in session.scalars(select(WorkBlock).where(WorkBlock.task_id == task_id))]

    @staticmethod
    def draft_dict(d: CalendarDraft) -> dict[str, Any]:
        return {
            "id": d.id,
            "operation": d.operation,
            "calendar_id": d.calendar_id,
            "event_id": d.event_id,
            "work_block_id": d.work_block_id,
            "payload": d.payload,
            "base_event": d.base_event,
            "remote_event": d.remote_event,
            "status": d.status,
            "last_error": d.last_error,
            "result": d.result,
            "updated_at": iso(d.updated_at),
        }
