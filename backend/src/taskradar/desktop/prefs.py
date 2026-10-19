"""What the desktop app remembers between starts (``desktop.json`` in the data folder).

* where the window was: its normal (not maximised) rectangle in physical pixels, the display scale it had then,
  and whether it was maximised;
* the app's appearance (theme and language), so that the window and its start screen open in the right colours
  before the web UI has loaded.

The next start checks the saved rectangle against the monitors that exist now: a window is never placed where
its title bar cannot be reached (a monitor was unplugged, the resolution or the scale changed).
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from taskradar.desktop.win32 import Monitor, Rect

log = logging.getLogger(__name__)

# Logical pixels (DIP). The minimum fits a maximised window on 1366 x 768 at 150 % (910 x 464 without the taskbar).
MIN_SIZE = (720, 440)
DEFAULT_SIZE = (1280, 860)
# Below this work area (DIP) the window opens maximised: on small screens every pixel counts.
SMALL_SCREEN = (1100, 680)
# How much of the title bar must be on a screen for the saved position to be used.
TITLE_BAR = 32
REACHABLE_WIDTH = 120
INVISIBLE_BORDER = 8


@dataclass(frozen=True)
class SavedWindow:
    rect: Rect  # normal rectangle, physical pixels
    dpi: int
    maximized: bool


@dataclass(frozen=True)
class Placement:
    """Where pywebview creates the window: logical pixels at the scale of the primary monitor."""

    x: int | None
    y: int | None
    width: int
    height: int
    maximized: bool


@dataclass
class Appearance:
    theme: str | None = None  # "light" | "dark"
    language: str | None = None  # "zh-CN" | "en"


class DesktopPrefs:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.window: SavedWindow | None = None
        self.appearance = Appearance()
        # Whether the user was told once that closing the window leaves TaskRadar running in the tray.
        self.tray_hint_shown = False

    @classmethod
    def load(cls, path: Path) -> DesktopPrefs:
        prefs = cls(path)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return prefs
        if not isinstance(data, dict):
            return prefs
        prefs.window = _window_from(data.get("window"))
        prefs.tray_hint_shown = data.get("tray_hint_shown") is True
        appearance = data.get("appearance")
        if isinstance(appearance, dict):
            theme, language = appearance.get("theme"), appearance.get("language")
            prefs.appearance = Appearance(
                theme=theme if theme in ("light", "dark") else None,
                language=language if language in ("zh-CN", "en") else None,
            )
        return prefs

    def save(self) -> None:
        data: dict[str, Any] = {"version": 1}
        if self.window is not None:
            rect = self.window.rect
            data["window"] = {
                "left": rect.left,
                "top": rect.top,
                "right": rect.right,
                "bottom": rect.bottom,
                "dpi": self.window.dpi,
                "maximized": self.window.maximized,
            }
        data["appearance"] = {"theme": self.appearance.theme, "language": self.appearance.language}
        data["tray_hint_shown"] = self.tray_hint_shown
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError as exc:  # never fatal: the window just opens at the default place next time
            log.warning("Could not save the window position: %s", exc.__class__.__name__)
            with contextlib.suppress(OSError):
                tmp.unlink()


def _window_from(raw: object) -> SavedWindow | None:
    if not isinstance(raw, dict):
        return None
    try:
        rect = Rect(int(raw["left"]), int(raw["top"]), int(raw["right"]), int(raw["bottom"]))
        dpi = int(raw.get("dpi", 96))
    except (KeyError, TypeError, ValueError):
        return None
    if rect.width <= 0 or rect.height <= 0 or not 48 <= dpi <= 960:
        return None
    return SavedWindow(rect=rect, dpi=dpi, maximized=bool(raw.get("maximized", False)))


def _scaled(value: float, dpi: int) -> int:
    return round(value * dpi / 96)


def initial_placement(saved: SavedWindow | None, screens: list[Monitor]) -> Placement:
    """Where the window opens: as it was left if that is still on a screen, otherwise centred on the primary one."""
    if not screens:
        return Placement(None, None, DEFAULT_SIZE[0], DEFAULT_SIZE[1], maximized=False)
    primary = next((m for m in screens if m.primary), screens[0])
    rect, maximized = (_restored(saved, screens) if saved else None) or _default(primary)
    # pywebview multiplies by the scale of the monitor the window is created on (the primary one).
    scale = primary.dpi / 96
    return Placement(
        x=round(rect.left / scale),
        y=round(rect.top / scale),
        width=round(rect.width / scale),
        height=round(rect.height / scale),
        maximized=maximized,
    )


def _default(monitor: Monitor) -> tuple[Rect, bool]:
    work, dpi = monitor.work, monitor.dpi
    small = work.width < _scaled(SMALL_SCREEN[0], dpi) or work.height < _scaled(SMALL_SCREEN[1], dpi)
    width = min(_scaled(DEFAULT_SIZE[0], dpi), round(work.width * 0.9))
    height = min(_scaled(DEFAULT_SIZE[1], dpi), round(work.height * 0.9))
    width, height = (
        max(width, min(_scaled(MIN_SIZE[0], dpi), work.width)),
        max(height, min(_scaled(MIN_SIZE[1], dpi), work.height)),
    )
    left = work.left + (work.width - width) // 2
    top = work.top + (work.height - height) // 2
    return Rect(left, top, left + width, top + height), small


def _restored(saved: SavedWindow, screens: list[Monitor]) -> tuple[Rect, bool] | None:
    rect = saved.rect
    best: tuple[int, Monitor] | None = None
    for monitor in screens:
        title_bar = Rect(rect.left, rect.top, rect.right, rect.top + _scaled(TITLE_BAR, monitor.dpi))
        overlap = title_bar.intersection(monitor.work)
        if overlap and (best is None or overlap.width > best[0]):
            best = (overlap.width, monitor)
    if best is None or best[0] < _scaled(REACHABLE_WIDTH, best[1].dpi):
        return None
    monitor = best[1]
    work = monitor.work
    # Windows draws an invisible resize border around the window (left, right, bottom): a window that was snapped
    # to the screen edge reaches that far beyond the work area and is put back exactly there.
    border = _scaled(INVISIBLE_BORDER, monitor.dpi)
    # The same size in logical pixels when the display scale changed in between.
    width = round(rect.width * monitor.dpi / saved.dpi)
    height = round(rect.height * monitor.dpi / saved.dpi)
    width = min(max(width, _scaled(MIN_SIZE[0], monitor.dpi)), work.width + 2 * border)
    height = min(max(height, _scaled(MIN_SIZE[1], monitor.dpi)), work.height + border)
    left = min(max(rect.left, work.left - border), work.right + border - width)
    top = min(max(rect.top, work.top), work.bottom + border - height)
    return Rect(left, top, left + width, top + height), saved.maximized
