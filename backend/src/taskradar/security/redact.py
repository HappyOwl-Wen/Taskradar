"""Redaction helpers for logs and error messages.

Anything that might end up in a log file or an API error payload passes through
:func:`redact_secrets` so OAuth tokens, API keys and authorization codes never leak.
"""

from __future__ import annotations

import logging
import re

_SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # OpenAI style keys (sk-..., sk-proj-...)
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{12,}"), "sk-***"),
    # Google OAuth access / refresh tokens and client secrets
    (re.compile(r"\bya29\.[0-9A-Za-z_\-\.]+"), "ya29.***"),
    (re.compile(r"\b1//[0-9A-Za-z_\-]{16,}"), "1//***"),
    (re.compile(r"\bGOCSPX-[A-Za-z0-9_\-]+"), "GOCSPX-***"),
    # Authorization headers
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9_\-\.=~+/]+"), r"\1***"),
    # key=value / "key": "value" pairs with sensitive names
    (
        re.compile(
            r"(?i)(\"?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|"
            r"id[_-]?token|secret)\"?\s*[:=]\s*\"?)([^\"\s,}&]+)"
        ),
        r"\1***",
    ),
    # OAuth codes / states in URLs (e.g. access logs of the OAuth callback)
    (re.compile(r"(?i)([?&](?:code|state|token|access_token|refresh_token)=)[^&\s\"']+"), r"\1***"),
]


def redact_secrets(text: str) -> str:
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class RedactingFilter(logging.Filter):
    """Logging filter that renders the message and strips secrets from it."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - malformed log call
            message = str(record.msg)
        redacted = redact_secrets(message)
        if redacted != message or record.args:
            record.msg = redacted
            record.args = None
        if record.exc_text:
            record.exc_text = redact_secrets(record.exc_text)
        return True
