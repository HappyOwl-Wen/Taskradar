"""Optional Windows autostart and Start menu entry (both only on explicit user request)."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from taskradar.packaged import is_packaged

MARKER = "REM TaskRadar autostart (created on user request; delete this file to disable)"
FILENAME = "TaskRadar.cmd"


def default_programs_dir() -> Path | None:
    """The current user's Start menu programs folder (Windows only)."""
    appdata = os.environ.get("APPDATA")
    if sys.platform != "win32" or not appdata:
        return None
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"


def default_startup_dir() -> Path | None:
    programs = default_programs_dir()
    return programs / "Startup" if programs else None


def _launch(python_exe: str) -> tuple[Path, str]:
    """The program that starts TaskRadar's window and its arguments: TaskRadar.exe, or Python with the package."""
    if is_packaged():
        return Path(python_exe), ""
    pythonw = Path(python_exe).with_name("pythonw.exe")
    return (pythonw if pythonw.exists() else Path(python_exe)), "-m taskradar desktop"


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
        """The line that starts TaskRadar at login, in the tray."""
        exe, arguments = _launch(self.python_exe)
        return f'start "" "{exe}" {arguments} --minimized'.replace("  ", " ")

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


LINK_NAME = "TaskRadar.lnk"


class StartMenuEntry:
    """TaskRadar in the Start menu, carrying its app ID.

    Windows shows an app's notifications as banners only when a Start menu entry stands for the app; without one
    they go to the notification centre silently. The installer creates the entry; for the source and the portable
    version the user can add it (and remove it again) in the settings. An entry that starts another TaskRadar (the
    installed one) is never replaced or removed here; one without the app ID (made by an earlier installer) only
    gets the ID added.
    """

    def __init__(self, programs_dir: Path | None = None, python_exe: str | None = None, app_id: str | None = None):
        from taskradar.notify import windows as notifications

        self.programs_dir = programs_dir if programs_dir is not None else default_programs_dir()
        self.python_exe = python_exe or sys.executable
        self.app_id = app_id or notifications.APP_ID

    @property
    def supported(self) -> bool:
        return self.programs_dir is not None and sys.platform == "win32"

    @property
    def path(self) -> Path | None:
        return self.programs_dir / LINK_NAME if self.programs_dir else None

    def status(self) -> dict[str, Any]:
        from taskradar.desktop.install import shortcut_app_id, shortcut_target

        path = self.path
        present = bool(path and path.is_file())
        app_id = shortcut_app_id(path) if present and path else None
        target = shortcut_target(path) if present and path else None
        return {
            "supported": self.supported,
            "present": present,
            # Windows shows TaskRadar's notifications as banners.
            "banners": app_id == self.app_id,
            # The entry starts this TaskRadar (so it may be removed here).
            "ours": target is not None and _same_file(target, _launch(self.python_exe)[0]),
        }

    def add(self) -> None:
        from taskradar.desktop.install import create_shortcut, set_shortcut_app_id, shortcut_app_id

        if not self.supported or self.path is None:
            raise RuntimeError("The Start menu entry is only supported on Windows")
        if self.path.is_file():
            if shortcut_app_id(self.path) != self.app_id:
                set_shortcut_app_id(self.path, self.app_id)
            return
        exe, arguments = _launch(self.python_exe)
        icon = Path(__file__).resolve().parent.parent / "desktop" / "taskradar.ico"
        create_shortcut(
            self.path,
            exe,
            arguments=arguments,
            description="TaskRadar",
            app_id=self.app_id,
            icon=icon if not is_packaged() and icon.is_file() else None,
        )

    def remove(self) -> None:
        if self.path is None or not self.path.is_file():
            return
        if not self.status()["ours"]:
            raise RuntimeError("Refusing to remove a Start menu entry that starts another TaskRadar")
        self.path.unlink()


def _same_file(a: str | Path, b: str | Path) -> bool:
    try:
        return Path(a).resolve() == Path(b).resolve()
    except (OSError, ValueError):
        return False
