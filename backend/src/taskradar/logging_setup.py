"""Unified logging configuration with secret redaction and rotating log files."""

from __future__ import annotations

import logging
import logging.handlers
import sys
from pathlib import Path

from taskradar.security.redact import RedactingFilter

_CONFIGURED = False
LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"


def configure_logging(logs_dir: Path | None, level: str = "INFO") -> None:
    """Configure root logging once. Safe to call repeatedly (tests, reloads)."""
    global _CONFIGURED
    root = logging.getLogger()
    if _CONFIGURED:
        root.setLevel(level)
        return

    redactor = RedactingFilter()
    formatter = logging.Formatter(LOG_FORMAT)

    handlers: list[logging.Handler] = []
    if sys.stderr is not None:  # the desktop app (windowed TaskRadar.exe) has no console; it logs to the file
        console = logging.StreamHandler()
        console.setFormatter(formatter)
        console.addFilter(redactor)
        handlers.append(console)

    if logs_dir is not None:
        logs_dir.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            logs_dir / "taskradar.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        file_handler.addFilter(redactor)
        handlers.append(file_handler)

    root.handlers = handlers
    root.setLevel(level)
    # Third-party loggers that are noisy or might echo request URLs.
    for name in (
        "googleapiclient.discovery_cache",
        "httpx",
        "httpcore",
        "openai",
        "apscheduler.executors",
        "alembic.runtime.plugins",
    ):
        logging.getLogger(name).setLevel(logging.WARNING)
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
    _CONFIGURED = True
