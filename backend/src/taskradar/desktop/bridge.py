"""What the web UI tells the desktop window, and what the server asks of it.

The page reports through the local API (``PUT /api/desktop/state``, CSRF-protected like every other change)
whether it holds unsaved changes and which theme and language it shows; the window uses that when it is closed
and to colour its title bar. The server asks the window to come to the front when a Google authorization that
was finished in the system browser returns. No GUI code here: the API and the tests use this class directly.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable

log = logging.getLogger(__name__)

THEMES = ("light", "dark")
LANGUAGES = ("zh-CN", "en")


class DesktopBridge:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.unsaved = False
        self.theme: str | None = None
        self.language: str | None = None
        self.on_appearance: Callable[[str | None, str | None], None] | None = None
        self.on_activate: Callable[[], None] | None = None

    def update(self, *, unsaved: bool | None = None, theme: str | None = None, language: str | None = None) -> None:
        with self._lock:
            if unsaved is not None:
                self.unsaved = unsaved
            changed = False
            if theme in THEMES and theme != self.theme:
                self.theme, changed = theme, True
            if language in LANGUAGES and language != self.language:
                self.language, changed = language, True
            theme_now, language_now = self.theme, self.language
        if changed and self.on_appearance is not None:
            self._call(self.on_appearance, theme_now, language_now)

    def activate(self) -> None:
        if self.on_activate is not None:
            self._call(self.on_activate)

    @staticmethod
    def _call(callback: Callable[..., None], *args: object) -> None:
        try:
            callback(*args)
        except Exception:  # the window is a convenience here; the request itself must not fail
            log.exception("Desktop window callback failed")
