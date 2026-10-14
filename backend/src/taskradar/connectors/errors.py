"""Connector error taxonomy and a bounded retry helper with exponential backoff and jitter."""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable
from typing import TypeVar

log = logging.getLogger(__name__)
T = TypeVar("T")


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


class PermanentError(ConnectorError):
    code = "permanent_error"
    recoverable = False


RETRYABLE = (RateLimitedError, TransientError)


def call_with_retries(
    fn: Callable[[], T],
    *,
    max_attempts: int = 5,
    base_delay: float = 1.0,
    max_delay: float = 32.0,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    attempt = 0
    while True:
        attempt += 1
        try:
            return fn()
        except RETRYABLE as exc:
            if attempt >= max_attempts:
                raise
            delay = exc.retry_after if exc.retry_after else min(max_delay, base_delay * 2 ** (attempt - 1))
            delay = delay * (0.5 + random.random() / 2)  # noqa: S311 - jitter, not crypto
            log.info("%s (attempt %s/%s); retrying in %.1fs", exc.code, attempt, max_attempts, delay)
            sleep(delay)
