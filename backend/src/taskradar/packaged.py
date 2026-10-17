"""Whether TaskRadar runs as the packaged program (TaskRadar.exe, built with PyInstaller) or from source."""

from __future__ import annotations

import sys
from pathlib import Path


def is_packaged() -> bool:
    return bool(getattr(sys, "frozen", False))


def program_dir() -> Path | None:
    """The folder that holds TaskRadar.exe; None when running from source."""
    return Path(sys.executable).resolve().parent if is_packaged() else None
