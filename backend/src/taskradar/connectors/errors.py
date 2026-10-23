"""Errors of the Google Calendar connector, by what can be done about them (retry, reconnect, nothing)."""

from __future__ import annotations

import json
import re
from typing import Any


class ConnectorError(RuntimeError):
    code = "connector_error"
    recoverable = True
    retry_after: float | None = None

    def __init__(self, message: str, *, retry_after: float | None = None):
        super().__init__(message)
        if retry_after is not None:
            self.retry_after = retry_after


class AuthRequiredError(ConnectorError):
    """Credentials are missing, expired or revoked. Needs user action - never auto-retried."""

    code = "auth_required"


class RateLimitedError(ConnectorError):
    code = "rate_limited"


class TransientError(ConnectorError):
    code = "transient_error"


class NotFoundError(ConnectorError):
    code = "not_found"
    recoverable = False


class ConflictError(ConnectorError):
    code = "conflict"
    recoverable = False


class PreconditionError(ConflictError):
    code = "event_conflict"


class SyncTokenExpired(ConnectorError):
    code = "sync_token_expired"


class PermanentError(ConnectorError):
    code = "permanent_error"
    recoverable = False


class ApiNotEnabledError(ConnectorError):
    """The API is switched off in the user's Google Cloud project: only the user can enable it, so this
    is never retried automatically. ``activation_url`` is Google's link to the switch, if it sent one."""

    code = "api_not_enabled"
    recoverable = False

    def __init__(self, message: str, *, activation_url: str | None = None):
        super().__init__(message)
        self.activation_url = activation_url


# Google's link to switch an API on; only ever shown as a link, so accept nothing but the Cloud Console.
_ACTIVATION_URL = re.compile(r"https://console\.(?:developers|cloud)\.google\.com/[^\s\"'<>]+")


def _activation_url(error: dict[str, Any]) -> str | None:
    for detail in error.get("details") or []:
        url = ((detail or {}).get("metadata") or {}).get("activationUrl")
        if isinstance(url, str) and _ACTIVATION_URL.fullmatch(url):
            return url
    found = _ACTIVATION_URL.search(str(error.get("message") or ""))
    return found.group(0).rstrip(".,;)") if found else None


def map_http_error(
    status: int,
    content: bytes | str | None,
    headers: dict[str, str] | None = None,
    *,
    api: str = "Google API",
) -> Exception:
    """Translate an HTTP failure from a Google API into the connector error taxonomy."""
    reason = ""
    error: dict[str, Any] = {}
    try:
        payload = json.loads(content or b"{}")
        error = payload.get("error", {}) if isinstance(payload.get("error"), dict) else {}
        errors = error.get("errors") or []
        reason = (errors[0].get("reason") if errors else "") or error.get("status", "")
    except (ValueError, AttributeError, TypeError):
        pass
    detail_reasons = {(d or {}).get("reason") for d in error.get("details") or [] if isinstance(d, dict)}
    retry_after = None
    if headers:
        raw = headers.get("retry-after") or headers.get("Retry-After")
        if raw and str(raw).isdigit():
            retry_after = float(raw)
    if status == 401:
        return AuthRequiredError("Google rejected the stored credentials; please reconnect")
    if status == 403 and (
        reason in ("accessNotConfigured", "SERVICE_DISABLED") or "SERVICE_DISABLED" in detail_reasons
    ):
        return ApiNotEnabledError(
            f"The {api} is not enabled in your Google Cloud project. Enable it, wait a minute, then try again.",
            activation_url=_activation_url(error),
        )
    if status == 429 or (status == 403 and reason in ("rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded")):
        return RateLimitedError(f"{api} rate limit reached", retry_after=retry_after)
    if status == 403 and reason in ("insufficientPermissions", "forbidden", "PERMISSION_DENIED"):
        return AuthRequiredError("The Google authorization does not include the required permission")
    if status == 404:
        return NotFoundError("Resource not found")
    if status == 412:
        return PreconditionError("The event changed in Google Calendar")
    if status >= 500:
        return TransientError(f"{api} server error ({status})")
    return PermanentError(f"{api} request failed ({status} {reason})".strip())
