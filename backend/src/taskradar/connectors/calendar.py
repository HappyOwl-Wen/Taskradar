"""Google Calendar access limited to calendars created by TaskRadar (``calendar.app.created``)."""

from __future__ import annotations

import socket
from typing import Any, Protocol

from taskradar.connectors.errors import (
    AuthRequiredError,
    ConflictError,
    NotFoundError,
    PermanentError,
    RateLimitedError,
    TransientError,
)
from taskradar.connectors.gmail import map_http_error


class CalendarClient(Protocol):
    def create_calendar(self, summary: str, time_zone: str) -> str: ...

    def calendar_exists(self, calendar_id: str) -> bool: ...

    def insert_event(self, calendar_id: str, body: dict[str, Any]) -> dict[str, Any]: ...

    def get_event(self, calendar_id: str, event_id: str) -> dict[str, Any]: ...

    def update_event(self, calendar_id: str, event_id: str, body: dict[str, Any]) -> dict[str, Any]: ...


class GoogleCalendarClient:
    def __init__(self, credentials: Any, *, timeout: float = 30.0) -> None:
        import google_auth_httplib2
        import httplib2
        from googleapiclient.discovery import build

        http = google_auth_httplib2.AuthorizedHttp(credentials, http=httplib2.Http(timeout=timeout))
        self._service = build("calendar", "v3", http=http, cache_discovery=False, static_discovery=True)

    def _execute(self, request: Any) -> Any:
        from google.auth.exceptions import RefreshError, TransportError
        from googleapiclient.errors import HttpError

        try:
            return request.execute(num_retries=0)
        except HttpError as exc:
            status = int(exc.resp.status)
            if status == 409:
                raise ConflictError("The event already exists") from exc
            raise map_http_error(status, exc.content) from exc
        except RefreshError as exc:
            raise AuthRequiredError("The Google Calendar authorization expired; please reconnect") from exc
        except (TransportError, TimeoutError, socket.timeout, ConnectionError, OSError) as exc:
            raise TransientError(f"Network error while contacting Google Calendar: {exc.__class__.__name__}") from exc

    def create_calendar(self, summary: str, time_zone: str) -> str:
        result = self._execute(self._service.calendars().insert(body={"summary": summary, "timeZone": time_zone}))
        return str(result["id"])

    def calendar_exists(self, calendar_id: str) -> bool:
        try:
            self._execute(self._service.calendars().get(calendarId=calendar_id))
            return True
        except NotFoundError:
            return False

    def insert_event(self, calendar_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._execute(  # type: ignore[no-any-return]
            self._service.events().insert(calendarId=calendar_id, body=body, sendUpdates="none")
        )

    def get_event(self, calendar_id: str, event_id: str) -> dict[str, Any]:
        return self._execute(self._service.events().get(calendarId=calendar_id, eventId=event_id))  # type: ignore[no-any-return]

    def update_event(self, calendar_id: str, event_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._execute(  # type: ignore[no-any-return]
            self._service.events().update(calendarId=calendar_id, eventId=event_id, body=body, sendUpdates="none")
        )


class FakeCalendarClient:
    """In-memory calendar for tests."""

    def __init__(self, *, fail_with: Exception | None = None) -> None:
        self.calendars: dict[str, dict[str, Any]] = {}
        self.events: dict[tuple[str, str], dict[str, Any]] = {}
        self.fail_with = fail_with
        self.calls: list[str] = []

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
        event = {**body, "htmlLink": f"https://calendar.google.com/event?eid={body['id']}"}
        self.events[key] = event
        return event

    def get_event(self, calendar_id: str, event_id: str) -> dict[str, Any]:
        self._check("get_event")
        try:
            return self.events[(calendar_id, event_id)]
        except KeyError as exc:
            raise NotFoundError("event not found") from exc

    def update_event(self, calendar_id: str, event_id: str, body: dict[str, Any]) -> dict[str, Any]:
        self._check("update_event")
        if (calendar_id, event_id) not in self.events:
            raise NotFoundError("event not found")
        event = {**body, "id": event_id, "htmlLink": f"https://calendar.google.com/event?eid={event_id}"}
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
