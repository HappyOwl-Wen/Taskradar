"""In-memory Gmail double with failure injection.

Used by the automated tests and by the offline "synthetic mailbox" demo source, so the complete
sync pipeline (pagination, incremental history, attachments, retries, error states) can be
exercised without a real Google account.
"""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Callable
from typing import Any

from taskradar.connectors.errors import AuthRequiredError, NotFoundError, RateLimitedError, TransientError

FAILURE_MODES = ("none", "rate_limit", "server_error", "auth", "network")


class FakeGmailClient:
    def __init__(
        self,
        messages: list[dict[str, Any]],
        *,
        email: str = "demo@taskradar.local",
        attachments: dict[tuple[str, str], bytes] | None = None,
        clock: Callable[[], dt.datetime] | None = None,
        failure_mode: str = "none",
        failures_remaining: int | None = None,
        page_size: int = 50,
    ) -> None:
        self.email = email
        self._messages = {m["id"]: m for m in messages}
        self._attachments = attachments or {}
        self._clock = clock or (lambda: dt.datetime.now(dt.UTC))
        self.failure_mode = failure_mode
        self.failures_remaining = failures_remaining  # None = fail forever while mode is set
        self.page_size = page_size
        self.calls: list[str] = []
        self.history_id = str(1000 + len(messages))
        self._history: list[tuple[int, str]] = []

    # -- failure injection -------------------------------------------------------------------

    def _maybe_fail(self, op: str) -> None:
        self.calls.append(op)
        if self.failure_mode == "none":
            return
        if self.failures_remaining is not None:
            if self.failures_remaining <= 0:
                return
            self.failures_remaining -= 1
        if self.failure_mode == "rate_limit":
            raise RateLimitedError("Simulated Gmail 429 Too Many Requests", retry_after=0.01)
        if self.failure_mode == "server_error":
            raise TransientError("Simulated Gmail 503 Service Unavailable")
        if self.failure_mode == "network":
            raise TransientError("Simulated network failure")
        if self.failure_mode == "auth":
            raise AuthRequiredError("Simulated invalid OAuth token (invalid_grant)")

    # -- mailbox mutation helpers for tests ----------------------------------------------------

    def add_message(self, message: dict[str, Any]) -> None:
        self._messages[message["id"]] = message
        self.history_id = str(int(self.history_id) + 1)
        self._history.append((int(self.history_id), message["id"]))

    # -- GmailClient protocol ----------------------------------------------------------------

    def get_profile(self) -> dict[str, Any]:
        self._maybe_fail("get_profile")
        return {"emailAddress": self.email, "historyId": self.history_id, "messagesTotal": len(self._messages)}

    def _matches(self, msg: dict[str, Any], query: str) -> bool:
        m = re.search(r"newer_than:(\d+)d", query)
        if m:
            cutoff = self._clock() - dt.timedelta(days=int(m.group(1)))
            sent = dt.datetime.fromtimestamp(int(msg["internalDate"]) / 1000, tz=dt.UTC)
            if sent < cutoff:
                return False
        labels = set(msg.get("labelIds", []))
        if "-in:chats" in query and "CHAT" in labels:
            return False
        return not ({"SPAM", "TRASH"} & labels)

    def list_message_ids(self, query: str, page_token: str | None, max_results: int = 100) -> tuple[list[str], str | None]:
        self._maybe_fail("list_message_ids")
        ordered = sorted(
            (m for m in self._messages.values() if self._matches(m, query)),
            key=lambda m: int(m["internalDate"]),
            reverse=True,
        )
        start = int(page_token or 0)
        size = min(max_results, self.page_size)
        page = ordered[start : start + size]
        next_token = str(start + size) if start + size < len(ordered) else None
        return [m["id"] for m in page], next_token

    def get_message(self, message_id: str) -> dict[str, Any]:
        self._maybe_fail("get_message")
        if message_id not in self._messages:
            raise NotFoundError("message not found")
        return self._messages[message_id]

    def get_attachment(self, message_id: str, attachment_id: str) -> bytes:
        self._maybe_fail("get_attachment")
        try:
            return self._attachments[(message_id, attachment_id)]
        except KeyError as exc:
            raise NotFoundError("attachment not found") from exc

    def list_history(self, start_history_id: str, page_token: str | None) -> tuple[list[str], str | None, str | None]:
        self._maybe_fail("list_history")
        start = int(start_history_id)
        if self._history and start < self._history[0][0] - 1000:
            raise NotFoundError("history expired")
        ids = [mid for hid, mid in self._history if hid > start]
        return ids, None, self.history_id
