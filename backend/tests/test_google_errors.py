"""Google API error mapping, including an API that is switched off in the user's Cloud project.

Seen with a real account: Gmail worked, but writing to the calendar failed with 403 accessNotConfigured
because the Google Calendar API had not been enabled - and the app called it a retryable Gmail error.
"""

from __future__ import annotations

import json
from typing import Any

from taskradar.connectors.calendar import FakeCalendarClient
from taskradar.connectors.errors import ApiNotEnabledError, PermanentError, RateLimitedError, TransientError
from taskradar.connectors.gmail import map_http_error
from taskradar.security import secrets as sk

ACTIVATION = "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456789012"
MESSAGE = (
    "Google Calendar API has not been used in project 123456789012 before or it is disabled. "
    f"Enable it by visiting {ACTIVATION} then retry. If you enabled this API recently, wait a few minutes."
)


def disabled_api_error(*, with_details: bool = True, url: str = ACTIVATION) -> bytes:
    """The shape of Google's error response for a disabled API (synthetic project number)."""
    error: dict[str, Any] = {
        "code": 403,
        "message": MESSAGE.replace(ACTIVATION, url),
        "errors": [{"message": "...", "domain": "usageLimits", "reason": "accessNotConfigured"}],
        "status": "PERMISSION_DENIED",
    }
    if with_details:
        error["details"] = [
            {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": "SERVICE_DISABLED",
                "domain": "googleapis.com",
                "metadata": {"service": "calendar-json.googleapis.com", "activationUrl": url},
            }
        ]
    return json.dumps({"error": error}).encode()


def test_disabled_api_is_reported_as_such_with_googles_link() -> None:
    exc = map_http_error(403, disabled_api_error(), api="Google Calendar API")
    assert isinstance(exc, ApiNotEnabledError)
    assert exc.code == "api_not_enabled" and exc.recoverable is False
    assert "Google Calendar API is not enabled" in str(exc) and "Gmail" not in str(exc)
    assert exc.activation_url == ACTIVATION


def test_activation_link_is_taken_from_the_message_when_details_are_missing() -> None:
    exc = map_http_error(403, disabled_api_error(with_details=False), api="Google Calendar API")
    assert isinstance(exc, ApiNotEnabledError)
    assert exc.activation_url == ACTIVATION  # without the trailing words


def test_only_google_cloud_console_links_are_passed_on() -> None:
    exc = map_http_error(403, disabled_api_error(url="https://evil.example/enable"), api="Google Calendar API")
    assert isinstance(exc, ApiNotEnabledError)
    assert exc.activation_url is None


def test_other_errors_name_the_api_that_failed() -> None:
    limited = map_http_error(
        403, json.dumps({"error": {"errors": [{"reason": "rateLimitExceeded"}]}}), api="Google Calendar API"
    )
    assert isinstance(limited, RateLimitedError) and "Google Calendar API" in str(limited)
    assert isinstance(map_http_error(503, b"", api="Google Calendar API"), TransientError)
    other = map_http_error(400, json.dumps({"error": {"errors": [{"reason": "badRequest"}]}}))
    assert isinstance(other, PermanentError) and str(other) == "Gmail API request failed (400 badRequest)"


def test_disabled_calendar_api_is_explained_and_writing_works_once_enabled(
    api: Any, calendar_client: FakeCalendarClient
) -> None:
    api.container.secrets.set(sk.GOOGLE_TOKEN_CALENDAR, '{"token": "fake"}')
    task = api.post("/api/tasks", json={"title": "Calendar test", "due_date": "2026-10-15"}).json()
    calendar_client.fail_with = map_http_error(403, disabled_api_error(), api="Google Calendar API")

    response = api.post(f"/api/tasks/{task['id']}/calendar", json={"confirm": True})
    error = response.json()["error"]
    assert response.status_code == 502
    assert (error["code"], error["recoverable"]) == ("api_not_enabled", False)
    assert "retry" not in error["message"]
    assert error["details"] == {"activation_url": ACTIVATION}
    assert calendar_client.calls == ["create_calendar"] and not calendar_client.calendars  # nothing written
    assert api.get(f"/api/tasks/{task['id']}").json()["calendar"]["last_error"].startswith("api_not_enabled:")

    calendar_client.fail_with = None  # the user enabled the API
    assert api.post(f"/api/tasks/{task['id']}/calendar", json={"confirm": True}).json()["status"] == "synced"
    assert len(calendar_client.events) == 1
