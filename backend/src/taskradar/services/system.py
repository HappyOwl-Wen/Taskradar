"""Optional Windows autostart (only on explicit user request) and file-explorer integration."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from taskradar.packaged import is_packaged

MARKER = "REM TaskRadar autostart (created on user request; delete this file to disable)"
FILENAME = "TaskRadar.cmd"


def default_startup_dir() -> Path | None:
    appdata = os.environ.get("APPDATA")
    if sys.platform != "win32" or not appdata:
        return None
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


class AutostartManager:
    def __init__(self, startup_dir: Path | None = None, python_exe: str | None = None) -> None:
        self.startup_dir = startup_dir if startup_dir is not None else default_startup_dir()
        self.python_exe = python_exe or sys.executable

    @property
    def supported(self) -> bool:
        return self.startup_dir is not None

    @property
    def path(self) -> Path | None:
        return self.startup_dir / FILENAME if self.startup_dir else None

    def enabled(self) -> bool:
        return bool(
            self.path and self.path.is_file() and MARKER in self.path.read_text(encoding="utf-8", errors="ignore")
        )

    def command(self) -> str:
        """The line that starts TaskRadar at login (without opening the browser)."""
        if is_packaged():
            # TaskRadar.exe: a minimised window in the taskbar shows that it runs; closing it stops TaskRadar.
            return f'start "" /min "{self.python_exe}" --no-browser'
        pythonw = Path(self.python_exe).with_name("pythonw.exe")
        exe = pythonw if pythonw.exists() else Path(self.python_exe)
        return f'start "" "{exe}" -m taskradar --no-browser'

    def enable(self) -> None:
        if not self.supported or self.path is None:
            raise RuntimeError("Autostart is only supported on Windows")
        content = "\r\n".join(["@echo off", MARKER, self.command(), ""])
        self.startup_dir.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
        self.path.write_text(content, encoding="utf-8")

    def disable(self) -> None:
        if self.path is not None and self.path.is_file():
            if MARKER not in self.path.read_text(encoding="utf-8", errors="ignore"):
                raise RuntimeError("Refusing to delete a startup entry that TaskRadar did not create")
            self.path.unlink()


def reveal_in_explorer(path: Path) -> bool:
    """Open Explorer with the file selected. Never executes the file itself."""
    if sys.platform != "win32":
        return False
    subprocess.Popen(["explorer.exe", "/select,", str(path)])  # noqa: S603, S607 - fixed binary, list args
    return True
