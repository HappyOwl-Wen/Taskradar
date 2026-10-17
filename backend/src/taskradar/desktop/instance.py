"""Which TaskRadar runs for a data folder (``instance.json``), so that a second start can hand over to it.

The data folder lock (:class:`taskradar.__main__.InstanceLock`) decides who runs; this file only says how to reach
the one that does: its process, whether it is the desktop window or the browser version, and its address.
"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
from typing import Any

from taskradar import __version__

FILENAME = "instance.json"


def write_instance(data_dir: Path, *, mode: str, url: str) -> None:
    data = {"pid": os.getpid(), "mode": mode, "url": url, "version": __version__}
    with contextlib.suppress(OSError):
        (data_dir / FILENAME).write_text(json.dumps(data), encoding="utf-8")


def read_instance(data_dir: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((data_dir / FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("pid"), int):
        return None
    return data


def clear_instance(data_dir: Path) -> None:
    current = read_instance(data_dir)
    if current is not None and current.get("pid") == os.getpid():
        with contextlib.suppress(OSError):
            (data_dir / FILENAME).unlink()
