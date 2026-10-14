"""Gmail API access (read-only). Only ``gmail.readonly`` is ever requested.

The client never modifies mailbox state: no label changes, no read/unread changes, no sending.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from typing import Any, Protocol

from taskradar.connectors.errors import (
    ApiNotEnabledError,
    AuthRequiredError,
    NotFoundError,
    PermanentError,
    RateLimitedError,
    RequestPacer,
    TransientError,
)

# At most ~5 Gmail API requests per second. Well below Google's documented quota, but bursts of a few
# requests per second already triggered 403 rateLimitExceeded on a real (new) project.
GMAIL_MIN_INTERVAL = 0.2

log = logging.getLogger(__name__)


class GmailClient(Protocol):
    def get_profile(self) -> dict[str, Any]: ...

    def list_message_ids(
        self, query: str, page_token: str | None, max_results: int = 100
    ) -> tuple[list[str], str | None]: ...

    def get_message(self, message_id: str) -> dict[str, Any]: ...

    def get_attachment(self, message_id: str, attachment_id: str) -> bytes: ...

    def list_history(
        self, start_history_id: str, page_token: str | None
    ) -> tuple[list[str], str | None, str | None]: ...


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
    api: str = "Gmail API",
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
    if status >= 500:
        return TransientError(f"{api} server error ({status})")
    return PermanentError(f"{api} request failed ({status} {reason})".strip())


class GoogleGmailClient:
    def __init__(self, credentials: Any, *, timeout: float = 30.0, min_interval: float = GMAIL_MIN_INTERVAL) -> None:
        import google_auth_httplib2
        import httplib2
        from googleapiclient.discovery import build

        http = google_auth_httplib2.AuthorizedHttp(credentials, http=httplib2.Http(timeout=timeout))
        self._service = build("gmail", "v1", http=http, cache_discovery=False, static_discovery=True)
        self._pacer = RequestPacer(min_interval)

    def _execute(self, request: Any) -> Any:
        from google.auth.exceptions import RefreshError, TransportError
        from googleapiclient.errors import HttpError

        self._pacer.wait()
        try:
            return request.execute(num_retries=0)
        except HttpError as exc:
            headers = {k.lower(): v for k, v in dict(getattr(exc, "resp", {}) or {}).items()}
            raise map_http_error(int(exc.resp.status), exc.content, headers) from exc
        except RefreshError as exc:
            raise AuthRequiredError("The Google authorization expired or was revoked; please reconnect") from exc
        except (TransportError, TimeoutError, ConnectionError, OSError) as exc:
            raise TransientError(f"Network error while contacting Gmail: {exc.__class__.__name__}") from exc
        except Exception as exc:
            import httplib2

            if isinstance(exc, httplib2.HttpLib2Error):
                raise TransientError(f"Network error while contacting Gmail: {exc.__class__.__name__}") from exc
            raise

    def get_profile(self) -> dict[str, Any]:
        return self._execute(self._service.users().getProfile(userId="me"))

    def list_message_ids(
        self, query: str, page_token: str | None, max_results: int = 100
    ) -> tuple[list[str], str | None]:
        resp = self._execute(
            self._service.users()
            .messages()
            .list(userId="me", q=query, pageToken=page_token, maxResults=max_results, includeSpamTrash=False)
        )
        return [m["id"] for m in resp.get("messages", [])], resp.get("nextPageToken")

    def get_message(self, message_id: str) -> dict[str, Any]:
        return self._execute(self._service.users().messages().get(userId="me", id=message_id, format="full"))

    def get_attachment(self, message_id: str, attachment_id: str) -> bytes:
        resp = self._execute(
            self._service.users().messages().attachments().get(userId="me", messageId=message_id, id=attachment_id)
        )
        data = resp.get("data", "")
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))

    def list_history(self, start_history_id: str, page_token: str | None) -> tuple[list[str], str | None, str | None]:
        resp = self._execute(
            self._service.users()
            .history()
            .list(userId="me", startHistoryId=start_history_id, historyTypes=["messageAdded"], pageToken=page_token)
        )
        ids: list[str] = []
        for record in resp.get("history", []):
            for added in record.get("messagesAdded", []):
                msg = added.get("message") or {}
                if msg.get("id"):
                    ids.append(msg["id"])
        return ids, resp.get("nextPageToken"), resp.get("historyId")
