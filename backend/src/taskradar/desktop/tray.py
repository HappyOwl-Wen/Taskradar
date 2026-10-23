"""TaskRadar's notification icon and its themed open/restart/quit menu.

A WinForms ``NotifyIcon`` (pywebview has already loaded WinForms through pythonnet), created and used on the window's
UI thread like the window itself. A left click opens the window; right-click offers open, restart service and quit.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from taskradar.desktop.tray_menu import TEXTS, TrayMenu

log = logging.getLogger(__name__)
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
        theme: str,
        on_open: Callable[[], None],
        on_restart: Callable[[], None],
        on_quit: Callable[[], None],
    ) -> None:
        self._form = form
        self._icon_path = icon
        self._language = language
        self._theme = theme
        self._on_open = on_open
        self._on_restart = on_restart
        self._on_quit = on_quit
        self._icon: Any = None
        self._menu: TrayMenu | None = None
        self._image: Any = None
        self._status: str | None = None
        self._service_state = "starting"

    @property
    def installed(self) -> bool:
        return self._icon is not None

    def install(self) -> None:
        self._invoke(self._create)
        if not self.installed:
            self.remove()
            raise RuntimeError("The notification icon could not be created")

    def _create(self) -> None:
        from System.Drawing import Icon
        from System.Windows.Forms import MouseButtons, NotifyIcon

        icon = NotifyIcon()
        self._image = icon.Icon = Icon(str(self._icon_path))
        icon.Text = tooltip(None)
        try:
            self._menu = TrayMenu(
                self._form,
                self._icon_path,
                language=self._language,
                theme=self._theme,
                on_open=self._on_open,
                on_restart=self._on_restart,
                on_quit=self._on_quit,
            )
        except Exception:
            icon.Dispose()
            raise
        self._menu.set_state(self._service_state)
        icon.ContextMenuStrip = self._menu.control

        def on_click(_sender: Any, args: Any) -> None:
            if args.Button == MouseButtons.Left:
                self._on_open()

        icon.MouseClick += on_click
        icon.Visible = True
        self._icon = icon

    def set_appearance(self, theme: str, language: str) -> None:
        self._theme, self._language = theme, language

        def apply() -> None:
            if self._menu is not None:
                self._menu.update(language, theme)
            self._update_tooltip()

        self._invoke(apply)

    def set_status(self, status: str | None) -> None:
        def apply() -> None:
            self._status = status
            if self._menu is not None:
                self._menu.set_status(status)
            self._update_tooltip()

        self._invoke(apply)

    def set_service_state(self, state: str) -> None:
        def apply() -> None:
            self._service_state = state
            if self._menu is not None:
                self._menu.set_state(state)
            self._update_tooltip()

        self._invoke(apply)

    def _update_tooltip(self) -> None:
        if self._icon is not None:
            texts = TEXTS["en" if self._language == "en" else "zh-CN"]
            status = self._status if self._service_state == "running" else texts[self._service_state]
            self._icon.Text = tooltip(status)

    def remove(self) -> None:
        """Take the icon away at once (before the process ends), so no dead icon stays in the tray."""

        def dispose() -> None:
            if self._icon is not None:
                self._icon.Visible = False
                self._icon.Dispose()
                self._icon = None
            if self._menu is not None:
                self._menu.dispose()
                self._menu = None
            if self._image is not None:
                self._image.Dispose()
                self._image = None

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
