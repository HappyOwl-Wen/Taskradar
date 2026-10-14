"""Connector error taxonomy and a bounded retry helper with exponential backoff and jitter."""

from __future__ import annotations

import logging
import random
import threading
import time
from collections.abc import Callable

log = logging.getLogger(__name__)


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


def backoff_delay(
    exc: ConnectorError,
    attempt: int,
    *,
    base_delay: float,
    max_delay: float,
    rate_limit_base_delay: float | None = None,
    rand: Callable[[], float] = random.random,
) -> float:
    """Exponential back-off with jitter for the given (1-based) attempt.

    Rate limits start from a longer base delay. A server-provided ``Retry-After`` is a minimum: the delay
    is never shorter than what the server asked for.
    """
    base = rate_limit_base_delay if isinstance(exc, RateLimitedError) and rate_limit_base_delay else base_delay
    delay = min(max_delay, base * 2 ** (attempt - 1)) * (0.5 + rand() / 2)
    if exc.retry_after:
        delay = max(delay, exc.retry_after * (1 + rand() / 10))
    return delay


def call_with_retries[T](
    fn: Callable[[], T],
    *,
    max_attempts: int = 5,
    base_delay: float = 1.0,
    max_delay: float = 32.0,
    rate_limit_base_delay: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Call ``fn`` and retry rate limits / transient errors with back-off.

    When the server asks to wait longer than ``2 * max_delay`` the error is raised instead, so the caller's
    job can fail recoverably and be rescheduled rather than blocking for minutes.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            return fn()
        except RETRYABLE as exc:
            if attempt >= max_attempts or (exc.retry_after or 0) > 2 * max_delay:
                raise
            delay = backoff_delay(
                exc, attempt, base_delay=base_delay, max_delay=max_delay, rate_limit_base_delay=rate_limit_base_delay
            )
            log.info("%s (attempt %s/%s); retrying in %.1fs", exc.code, attempt, max_attempts, delay)
            sleep(delay)


class RequestPacer:
    """Spaces out API requests (at most one every ``min_interval`` seconds), thread-safe.

    Google's per-user rate limiter reacts to bursts; a steady pace avoids most 403 rateLimitExceeded errors.
    """

    def __init__(
        self,
        min_interval: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.min_interval = min_interval
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next_slot = 0.0

    def wait(self) -> None:
        with self._lock:
            now = self._clock()
            slot = max(now, self._next_slot)
            self._next_slot = slot + self.min_interval
        if slot > now:
            self._sleep(slot - now)
