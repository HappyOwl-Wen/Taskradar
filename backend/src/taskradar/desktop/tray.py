"""TaskRadar's icon in the notification area (tray): the window closes into it, and it opens or quits TaskRadar.

A WinForms ``NotifyIcon`` (pywebview has already loaded WinForms through pythonnet), created and used on the window's
UI thread like the window itself. A left click opens the window; the right-click menu opens it or quits TaskRadar.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

TEXTS = {
    "zh-CN": {"open": "打开 TaskRadar", "quit": "退出 TaskRadar"},
    "en": {"open": "Open TaskRadar", "quit": "Quit TaskRadar"},
}
TOOLTIP_LIMIT = 63  # what NotifyIcon.Text accepts


def tooltip(status: str | None) -> str:
    """The text shown when the pointer rests on the icon: "TaskRadar" and, if something runs, what."""
    text = f"TaskRadar · {status}" if status else "TaskRadar"
    return text if len(text) <= TOOLTIP_LIMIT else text[: TOOLTIP_LIMIT - 1] + "…"


class Tray:
    def __init__(
        self,
        form: Any,
        icon: Path,
        *,
        language: str,
        on_open: Callable[[], None],
        on_quit: Callable[[], None],
    ) -> None:
        self._form = form
        self._icon_path = icon
        self._language = language
        self._on_open = on_open
        self._on_quit = on_quit
        self._icon: Any = None
        self._open_item: Any = None
        self._quit_item: Any = None

    @property
    def installed(self) -> bool:
        return self._icon is not None

    def install(self) -> None:
        self._invoke(self._create)

    def _create(self) -> None:
        from System.Drawing import Font, FontStyle, Icon
        from System.Windows.Forms import (
            ContextMenuStrip,
            MouseButtons,
            NotifyIcon,
            ToolStripMenuItem,
            ToolStripSeparator,
        )

        texts = TEXTS["en" if self._language == "en" else "zh-CN"]
        icon = NotifyIcon()
        icon.Icon = Icon(str(self._icon_path))
        icon.Text = tooltip(None)
        menu = ContextMenuStrip()
        self._open_item = ToolStripMenuItem(texts["open"])
        self._open_item.Font = Font(self._open_item.Font, FontStyle.Bold)  # what a click on the icon does
        self._open_item.Click += lambda _sender, _args: self._on_open()
        self._quit_item = ToolStripMenuItem(texts["quit"])
        self._quit_item.Click += lambda _sender, _args: self._on_quit()
        menu.Items.Add(self._open_item)
        menu.Items.Add(ToolStripSeparator())
        menu.Items.Add(self._quit_item)
        icon.ContextMenuStrip = menu

        def on_click(_sender: Any, args: Any) -> None:
            if args.Button == MouseButtons.Left:
                self._on_open()

        icon.MouseClick += on_click
        icon.Visible = True
        self._icon = icon

    def set_language(self, language: str) -> None:
        self._language = language
        texts = TEXTS["en" if language == "en" else "zh-CN"]

        def apply() -> None:
            if self._open_item is not None:
                self._open_item.Text = texts["open"]
                self._quit_item.Text = texts["quit"]

        self._invoke(apply)

    def set_status(self, status: str | None) -> None:
        def apply() -> None:
            if self._icon is not None:
                self._icon.Text = tooltip(status)

        self._invoke(apply)

    def remove(self) -> None:
        """Take the icon away at once (before the process ends), so no dead icon stays in the tray."""

        def dispose() -> None:
            if self._icon is not None:
                self._icon.Visible = False
                self._icon.Dispose()
                self._icon = None

        self._invoke(dispose)

    def _invoke(self, action: Callable[[], None]) -> None:
        from System import Action

        try:
            if self._form.InvokeRequired:
                self._form.Invoke(Action(action))
            else:
                action()
        except Exception:  # the window may be gone already while TaskRadar ends
            log.exception("Tray update failed")
