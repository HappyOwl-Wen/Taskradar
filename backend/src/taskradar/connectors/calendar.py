"""Backend Google Calendar transport, including paginated reads and ETag mutations."""

from __future__ import annotations

import copy
import datetime as dt
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from taskradar.connectors.errors import (
    AuthRequiredError,
    ConflictError,
    NotFoundError,
    PermanentError,
    PreconditionError,
    RateLimitedError,
    SyncTokenExpired,
    TransientError,
    map_http_error,
)


class CalendarClient(Protocol):
    def list_calendars(self, **params: Any) -> dict[str, Any]: ...

    def get_calendar(self, calendar_id: str) -> dict[str, Any]: ...

    def list_events(self, calendar_id: str, **params: Any) -> dict[str, Any]: ...

    def patch_event(self, calendar_id: str, event_id: str, body: dict[str, Any], etag: str) -> dict[str, Any]: ...

    def delete_conditional(self, calendar_id: str, event_id: str, etag: str) -> None: ...
    def create_calendar(self, summary: str, time_zone: str) -> str: ...

    def calendar_exists(self, calendar_id: str) -> bool: ...

    def insert_event(self, calendar_id: str, body: dict[str, Any]) -> dict[str, Any]: ...

    def get_event(self, calendar_id: str, event_id: str) -> dict[str, Any]: ...

    def update_event(self, calendar_id: str, event_id: str, body: dict[str, Any]) -> dict[str, Any]: ...

    def delete_event(self, calendar_id: str, event_id: str) -> None: ...


class GoogleCalendarClient:
    def __init__(self, credentials: Any, *, timeout: float = 30.0) -> None:
        import google_auth_httplib2
        import httplib2
        from googleapiclient.discovery import build

        http = google_auth_httplib2.AuthorizedHttp(credentials, http=httplib2.Http(timeout=timeout))
        self._service = build("calendar", "v3", http=http, cache_discovery=False, static_discovery=True)

    def _execute(self, request: Any, *, listing: bool = False) -> Any:
        from google.auth.exceptions import RefreshError, TransportError
        from googleapiclient.errors import HttpError

        try:
            return request.execute(num_retries=0)
        except HttpError as exc:
            status = int(exc.resp.status)
            if status == 409:
                raise ConflictError("The event already exists") from exc
            if status == 410:
                if listing:
                    raise SyncTokenExpired("The calendar sync token expired") from exc
                raise NotFoundError("The event was already deleted") from exc
            raise map_http_error(status, exc.content, headers=dict(exc.resp), api="Google Calendar API") from exc
        except RefreshError as exc:
            raise AuthRequiredError("The Google Calendar authorization expired; please reconnect") from exc
        except (TransportError, TimeoutError, ConnectionError, OSError) as exc:
            raise TransientError(f"Network error while contacting Google Calendar: {exc.__class__.__name__}") from exc

    def create_calendar(self, summary: str, time_zone: str) -> str:
        result = self._execute(self._service.calendars().insert(body={"summary": summary, "timeZone": time_zone}))
        return str(result["id"])

    def list_calendars(self, **params: Any) -> dict[str, Any]:
        return self._execute(self._service.calendarList().list(**params), listing=True)

    def get_calendar(self, calendar_id: str) -> dict[str, Any]:
        return self._execute(self._service.calendarList().get(calendarId=calendar_id))

    def list_events(self, calendar_id: str, **params: Any) -> dict[str, Any]:
        return self._execute(self._service.events().list(calendarId=calendar_id, **params), listing=True)

    def patch_event(self, calendar_id: str, event_id: str, body: dict[str, Any], etag: str) -> dict[str, Any]:
        request = self._service.events().patch(calendarId=calendar_id, eventId=event_id, body=body, sendUpdates="none")
        request.headers["If-Match"] = etag
        return self._execute(request)

    def delete_conditional(self, calendar_id: str, event_id: str, etag: str) -> None:
        request = self._service.events().delete(calendarId=calendar_id, eventId=event_id, sendUpdates="none")
        request.headers["If-Match"] = etag
        self._execute(request)

    def calendar_exists(self, calendar_id: str) -> bool:
        try:
            self._execute(self._service.calendars().get(calendarId=calendar_id))
            return True
        except NotFoundError:
            return False

    def insert_event(self, calendar_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._execute(self._service.events().insert(calendarId=calendar_id, body=body, sendUpdates="none"))

    def get_event(self, calendar_id: str, event_id: str) -> dict[str, Any]:
        return self._execute(self._service.events().get(calendarId=calendar_id, eventId=event_id))

    def update_event(self, calendar_id: str, event_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._execute(
            self._service.events().update(calendarId=calendar_id, eventId=event_id, body=body, sendUpdates="none")
        )

    def delete_event(self, calendar_id: str, event_id: str) -> None:
        self._execute(self._service.events().delete(calendarId=calendar_id, eventId=event_id, sendUpdates="none"))


class FakeCalendarClient:
    """In-memory calendar for tests."""

    def __init__(self, *, fail_with: Exception | None = None) -> None:
        self.calendars: dict[str, dict[str, Any]] = {}
        self.events: dict[tuple[str, str], dict[str, Any]] = {}
        self.fail_with = fail_with
        self.calls: list[str] = []
        self.requests: list[dict[str, Any]] = []
        self.page_size = 2500
        self.expired_tokens: set[str] = set()
        self.fail_calendars: dict[str, Exception] = {}
        self._revision = 0

    def _version(self, body: dict[str, Any]) -> dict[str, Any]:
        self._revision += 1
        return {**copy.deepcopy(body), "etag": f'"fake-{self._revision}"'}

    def _page(self, items: list[dict[str, Any]], params: dict[str, Any]) -> dict[str, Any]:
        offset = int(params.get("pageToken", "0"))
        size = min(params.get("maxResults", 2500), self.page_size)
        result: dict[str, Any] = {"items": copy.deepcopy(items[offset : offset + size])}
        if offset + size < len(items):
            result["nextPageToken"] = str(offset + size)
        else:
            result["nextSyncToken"] = f"sync-{self._revision}"
        return result

    def list_calendars(self, **params: Any) -> dict[str, Any]:
        self._check("list_calendars")
        return self._page([{"id": k, "accessRole": "owner", **v} for k, v in self.calendars.items()], params)

    def get_calendar(self, calendar_id: str) -> dict[str, Any]:
        self._check("get_calendar")
        if calendar_id == "primary":
            calendar_id = next((k for k, v in self.calendars.items() if v.get("primary")), calendar_id)
        if calendar_id not in self.calendars:
            raise NotFoundError("calendar not found")
        return {"id": calendar_id, "accessRole": "owner", **copy.deepcopy(self.calendars[calendar_id])}

    def list_events(self, calendar_id: str, **params: Any) -> dict[str, Any]:
        self._check("list_events")
        self.requests.append({"calendarId": calendar_id, **params})
        if calendar_id in self.fail_calendars:
            raise self.fail_calendars[calendar_id]
        if params.get("syncToken") in self.expired_tokens:
            raise SyncTokenExpired("expired token")
        if params.get("syncToken") and any(k in params for k in ("timeMin", "timeMax", "orderBy", "q")):
            raise AssertionError("syncToken cannot be combined with range/search parameters")
        items = [e for (c, _), e in self.events.items() if c == calendar_id]
        if params.get("singleEvents"):

            def overlaps(e: dict[str, Any]) -> bool:
                if e.get("recurrence") or e.get("status") == "cancelled":
                    return False

                def instant(v: dict[str, Any]) -> dt.datetime:
                    return (
                        dt.datetime.fromisoformat(v["date"]).replace(
                            tzinfo=ZoneInfo(self.calendars[calendar_id].get("timeZone", "UTC"))
                        )
                        if "date" in v
                        else dt.datetime.fromisoformat(v["dateTime"])
                    )

                return instant(e["start"]) < dt.datetime.fromisoformat(params["timeMax"]) and instant(
                    e["end"]
                ) > dt.datetime.fromisoformat(params["timeMin"])

            items = [e for e in items if overlaps(e)]
        return self._page(items, params)

    def patch_event(self, calendar_id: str, event_id: str, body: dict[str, Any], etag: str) -> dict[str, Any]:
        self._check("patch_event")
        current = self.get_event(calendar_id, event_id)
        if current.get("etag") != etag:
            raise PreconditionError("event changed")
        return self.update_event(calendar_id, event_id, {**current, **body})

    def delete_conditional(self, calendar_id: str, event_id: str, etag: str) -> None:
        current = self.get_event(calendar_id, event_id)
        if current.get("etag") != etag:
            raise PreconditionError("event changed")
        self.delete_event(calendar_id, event_id)

    def _check(self, op: str) -> None:
        self.calls.append(op)
        if self.fail_with is not None:
            raise self.fail_with

    def create_calendar(self, summary: str, time_zone: str) -> str:
        self._check("create_calendar")
        cal_id = f"cal{len(self.calendars) + 1}@group.calendar.google.com"
        self.calendars[cal_id] = {"summary": summary, "timeZone": time_zone}
        return cal_id

    def calendar_exists(self, calendar_id: str) -> bool:
        self._check("calendar_exists")
        return calendar_id in self.calendars

    def insert_event(self, calendar_id: str, body: dict[str, Any]) -> dict[str, Any]:
        self._check("insert_event")
        if calendar_id not in self.calendars:
            raise NotFoundError("calendar not found")
        key = (calendar_id, body["id"])
        if key in self.events:
            raise ConflictError("duplicate event id")
        event = self._version({**body, "htmlLink": f"https://calendar.google.com/event?eid={body['id']}"})
        self.events[key] = event
        return event

    def get_event(self, calendar_id: str, event_id: str) -> dict[str, Any]:
        self._check("get_event")
        try:
            return copy.deepcopy(self.events[(calendar_id, event_id)])
        except KeyError as exc:
            raise NotFoundError("event not found") from exc

    def delete_event(self, calendar_id: str, event_id: str) -> None:
        """Like Google: the event becomes "cancelled" and its id stays reserved."""
        self._check("delete_event")
        event = self.events.get((calendar_id, event_id))
        if event is None or event.get("status") == "cancelled":
            raise NotFoundError("event not found or already deleted")
        self.events[(calendar_id, event_id)] = self._version({"id": event_id, "status": "cancelled"})

    def update_event(self, calendar_id: str, event_id: str, body: dict[str, Any]) -> dict[str, Any]:
        self._check("update_event")
        if (calendar_id, event_id) not in self.events:
            raise NotFoundError("event not found")
        event = self._version({**body, "id": event_id, "htmlLink": f"https://calendar.google.com/event?eid={event_id}"})
        self.events[(calendar_id, event_id)] = event
        return event


__all__ = [
    "CalendarClient",
    "ConflictError",
    "FakeCalendarClient",
    "GoogleCalendarClient",
    "PermanentError",
    "RateLimitedError",
]
