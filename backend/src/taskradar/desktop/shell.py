"""The desktop window: pywebview on Microsoft Edge WebView2 around the local server of the same process.

* Opening TaskRadar shows the window at once (start screen); the server starts behind it and the web UI replaces
  the start screen as soon as it answers. Closing the window stops the server and the background jobs.
* The window opens where it was left (size, position, maximised), on a screen that still exists.
* A second start brings the open window to the front instead of starting TaskRadar twice.
* Links to other sites, and the Google sign-in, open in the system browser; the window only shows TaskRadar.
* Closing with unsaved changes asks first (the page reports them, see :mod:`taskradar.desktop.bridge`).
"""

from __future__ import annotations

import dataclasses
import logging
import os
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from taskradar.config import AppConfig
from taskradar.desktop import win32
from taskradar.desktop.bridge import DesktopBridge
from taskradar.desktop.instance import clear_instance, read_instance, write_instance
from taskradar.desktop.prefs import MIN_SIZE, Appearance, DesktopPrefs, SavedWindow, initial_placement
from taskradar.desktop.server import BackgroundServer, choose_port
from taskradar.desktop.splash import FRAME, TEXT, error_page, start_page
from taskradar.packaged import is_packaged

log = logging.getLogger(__name__)

TITLE = "TaskRadar"
APP_ID = "TaskRadar.Desktop"
ICON = Path(__file__).with_name("taskradar.ico")
WEBVIEW2_DOWNLOAD = "https://developer.microsoft.com/microsoft-edge/webview2/"
# Context menu entries that make sense in an app (editing text, copying links); browser entries are removed.
CONTEXT_MENU_KEEP = {
    "cut",
    "copy",
    "paste",
    "pasteAndMatchStyle",
    "selectAll",
    "undo",
    "redo",
    "emoji",
    "spellCheck",
    "copyLinkLocation",
    "copyImage",
}

TEXTS = {
    "zh-CN": {
        "unsaved": "有尚未保存的修改。\n\n关闭 TaskRadar 会丢失这些修改。仍要关闭吗？",
        "already_running": "TaskRadar 已经在运行。",
        "browser_running": (
            "TaskRadar 正以浏览器版本运行（{url}）。\n\n要改用桌面窗口，请先关闭浏览器版本的命令行窗口，"
            "再重新打开 TaskRadar。\n\n现在在浏览器中打开它吗？"
        ),
        "no_webview2": (
            "TaskRadar 的窗口需要 Microsoft Edge WebView2 运行时（Windows 11 已自带），"
            "这台电脑上没有找到它。\n\n现在打开微软的下载页面吗？安装后重新打开 TaskRadar 即可。"
        ),
    },
    "en": {
        "unsaved": "There are unsaved changes.\n\nClosing TaskRadar discards them. Close anyway?",
        "already_running": "TaskRadar is already running.",
        "browser_running": (
            "TaskRadar is running as the browser version ({url}).\n\nTo use the desktop window instead, close the "
            "command window of the browser version first, then open TaskRadar again.\n\nOpen it in the browser now?"
        ),
        "no_webview2": (
            "The TaskRadar window needs the Microsoft Edge WebView2 Runtime (part of Windows 11), which was not "
            "found on this computer.\n\nOpen Microsoft's download page now? Open TaskRadar again after installing it."
        ),
    },
}


def _texts(language: str | None) -> dict[str, str]:
    return TEXTS["en" if language == "en" else "zh-CN"]


def run(config: AppConfig, *, minimized: bool = False, debug: bool = False) -> int:
    from taskradar.__main__ import InstanceLock

    win32.enable_dpi_awareness()
    if not is_packaged():
        win32.set_app_user_model_id(APP_ID)  # python.exe would otherwise lend the window its own taskbar icon
    prefs = DesktopPrefs.load(config.data_dir / "desktop.json")
    language = prefs.appearance.language

    lock = InstanceLock(config.data_dir / "taskradar.lock")
    if not lock.acquire() and not _hand_over(config.data_dir, language, lock):
        return 0
    if win32.IS_WINDOWS and win32.webview2_version() is None:
        answer = win32.message_box(_texts(language)["no_webview2"], TITLE, win32.MB_YESNO | win32.MB_ICONWARNING)
        if answer == win32.IDYES:
            webbrowser.open(WEBVIEW2_DOWNLOAD)
        return 3

    config = dataclasses.replace(config, port=choose_port(config.host, config.port), open_browser=False)
    write_instance(config.data_dir, mode="desktop", url=config.base_url)
    try:
        return _run_window(config, prefs, minimized=minimized, debug=debug)
    finally:
        clear_instance(config.data_dir)


def _hand_over(data_dir: Path, language: str | None, lock: Any) -> bool:
    """Another TaskRadar uses this data folder: show its window, or say where it runs.

    Returns True when this start may go on after all: the other one was just closing (its window is gone and it
    ends within moments), so opening TaskRadar right after closing it works.
    """
    texts = _texts(language)
    info = read_instance(data_dir)
    if info is None or info.get("mode") == "desktop":
        for _ in range(50):  # it may still be creating its window, or be about to end
            if lock.acquire():
                return True
            hwnd = win32.find_window(int(info["pid"]), TITLE) if info else None
            if hwnd:
                win32.bring_to_front(hwnd)
                return False
            time.sleep(0.2)
            info = info or read_instance(data_dir)
    if info and info.get("mode") == "serve" and info.get("url"):
        url = str(info["url"])
        flags = win32.MB_YESNO | win32.MB_ICONINFORMATION
        if win32.message_box(texts["browser_running"].format(url=url), TITLE, flags) == win32.IDYES:
            webbrowser.open(url)
        return False
    win32.message_box(texts["already_running"], TITLE, win32.MB_OK | win32.MB_ICONINFORMATION)
    return False


def _run_window(config: AppConfig, prefs: DesktopPrefs, *, minimized: bool, debug: bool) -> int:
    import webview

    bridge = DesktopBridge()
    server = BackgroundServer(config, bridge)
    server.start()

    theme = prefs.appearance.theme or ("dark" if win32.apps_use_dark_theme() else "light")
    language = prefs.appearance.language or "zh-CN"
    placement = initial_placement(prefs.window, win32.monitors())

    webview.settings["ALLOW_DOWNLOADS"] = True  # the data export is a download (Save As dialog)
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    debug_port = os.environ.get("TASKRADAR_WEBVIEW_DEBUG_PORT")  # automated UI tests only
    if debug_port and debug_port.isdigit():
        webview.settings["REMOTE_DEBUGGING_PORT"] = int(debug_port)

    window = webview.create_window(
        TITLE,
        html=start_page(theme, language),
        x=placement.x,
        y=placement.y,
        width=placement.width,
        height=placement.height,
        min_size=MIN_SIZE,
        maximized=placement.maximized and not minimized,
        minimized=minimized,
        background_color=FRAME[theme],
        text_select=True,
        zoomable=True,
    )
    shell = Shell(window, server, bridge, prefs, theme=theme, language=language, debug=debug)
    shell.connect()
    webview.start(
        shell.after_start,
        private_mode=False,  # keep the page's own small preferences between starts
        storage_path=str(config.data_dir / "webview"),
        debug=debug,
        icon=str(ICON) if ICON.is_file() else None,
        gui="edgechromium",
    )
    shell.closed.set()
    log.info("Window closed; stopping the server")
    server.stop()
    log.info("TaskRadar desktop window closed; server stopped")
    return 0


class Shell:
    """Keeps the window and the server in step. Window events arrive on pywebview threads."""

    def __init__(
        self,
        window: Any,
        server: BackgroundServer,
        bridge: DesktopBridge,
        prefs: DesktopPrefs,
        *,
        theme: str,
        language: str,
        debug: bool = False,
    ) -> None:
        self.window = window
        self.server = server
        self.bridge = bridge
        self.prefs = prefs
        self.theme = theme
        self.language = language
        self.debug = debug
        self.hwnd = 0
        self.closed = threading.Event()
        self._normal = prefs.window.rect if prefs.window else None
        self._normal_dpi = prefs.window.dpi if prefs.window else 96
        self._save_timer: threading.Timer | None = None
        self._native_ready = False
        self._lock = threading.Lock()

    def connect(self) -> None:
        events = self.window.events
        events.shown += self._on_shown
        events.moved += self._on_geometry
        events.resized += self._on_geometry
        events.maximized += self._on_geometry
        events.restored += self._on_geometry
        events.loaded += self._on_loaded
        events.closing += self._on_closing
        events.closed += self.closed.set
        self.bridge.on_appearance = self._on_appearance
        self.bridge.on_activate = self._on_activate

    # -- start ----------------------------------------------------------------------------------------------

    def after_start(self) -> None:
        """Runs once the window exists: show the web UI as soon as the server answers."""
        if self.server.wait_ready(cancel=self.closed):
            self.window.load_url(self.server.url)
        elif not self.closed.is_set():
            log_path = str(self.server.config.logs_dir / "taskradar.log")
            code = self.server.error or "unknown"
            self.window.load_html(error_page(self.theme, self.language, code=code, log_path=log_path))

    def _on_shown(self) -> None:
        native = self.window.native
        if native is not None:
            self.hwnd = int(native.Handle.ToInt64())
        self._apply_title_bar()
        self._on_geometry()

    def _on_loaded(self) -> None:
        if self._native_ready or self.debug:
            return
        self._native_ready = True
        try:
            self._install_webview_handlers()
        except Exception:  # the window works without them (no context menu; links still open in the browser)
            log.exception("Could not set up the context menu and link handling")

    def _install_webview_handlers(self) -> None:
        from System import Func, Type  # pythonnet, loaded by pywebview

        form = self.window.native

        def setup() -> None:
            core = form.browser.webview.CoreWebView2
            core.Settings.AreDefaultContextMenusEnabled = True
            core.ContextMenuRequested += self._on_context_menu
            core.NavigationStarting += self._on_navigation_starting

        form.Invoke(Func[Type](setup))

    # -- window position -----------------------------------------------------------------------------------

    def _on_geometry(self, *_args: object) -> None:
        hwnd = self.hwnd
        if hwnd and not win32.is_minimized(hwnd) and not win32.is_maximized(hwnd):
            rect = win32.window_rect(hwnd)
            if rect is not None and rect.width > 0 and rect.height > 0:
                with self._lock:
                    self._normal, self._normal_dpi = rect, win32.dpi_for_window(hwnd)
        self._schedule_save()

    def _schedule_save(self) -> None:
        with self._lock:
            if self._save_timer is not None:
                self._save_timer.cancel()
            self._save_timer = threading.Timer(1.5, self._save)
            self._save_timer.daemon = True
            self._save_timer.start()

    def _save(self) -> None:
        with self._lock:
            if self._normal is not None:
                maximized = win32.is_maximized(self.hwnd) if self.hwnd else False
                self.prefs.window = SavedWindow(self._normal, self._normal_dpi, maximized)
            self.prefs.appearance = Appearance(theme=self.theme, language=self.language)
            self.prefs.save()

    # -- closing ---------------------------------------------------------------------------------------------

    def _on_closing(self) -> bool:
        """On the UI thread; returning False keeps the window open."""
        if self.bridge.unsaved:
            flags = win32.MB_YESNO | win32.MB_ICONWARNING | win32.MB_DEFBUTTON2
            if win32.message_box(_texts(self.language)["unsaved"], TITLE, flags, owner=self.hwnd) != win32.IDYES:
                return False
        with self._lock:
            if self._save_timer is not None:
                self._save_timer.cancel()
        self._save()
        log.info("Window closing")
        return True

    # -- requests from the page and the server ---------------------------------------------------------------

    def _on_appearance(self, theme: str | None, language: str | None) -> None:
        self.theme = theme or self.theme
        self.language = language or self.language
        self._apply_title_bar()
        self._schedule_save()

    def _apply_title_bar(self) -> None:
        if self.hwnd:
            win32.set_title_bar(self.hwnd, dark=self.theme == "dark", caption=FRAME[self.theme], text=TEXT[self.theme])

    def _on_activate(self) -> None:
        if self.hwnd:
            win32.bring_to_front(self.hwnd)

    # -- WebView2 events (UI thread) -------------------------------------------------------------------------

    def _on_context_menu(self, _sender: Any, args: Any) -> None:
        items = args.MenuItems
        for index in range(items.Count - 1, -1, -1):
            item = items[index]
            if str(item.Kind) != "Separator" and str(item.Name) not in CONTEXT_MENU_KEEP:
                items.RemoveAt(index)
        # Separators only between entries: none first, last or twice in a row.
        previous_separator, index = True, 0
        while index < items.Count:
            is_separator = str(items[index].Kind) == "Separator"
            if is_separator and previous_separator:
                items.RemoveAt(index)
                continue
            previous_separator, index = is_separator, index + 1
        if items.Count and str(items[items.Count - 1].Kind) == "Separator":
            items.RemoveAt(items.Count - 1)
        if items.Count == 0:
            args.Handled = True  # nothing useful to offer here: no menu at all

    def _on_navigation_starting(self, _sender: Any, args: Any) -> None:
        uri = str(args.Uri)
        base = self.server.url
        if uri == base or uri.startswith(base + "/") or uri.startswith(("data:", "about:")):
            return
        args.Cancel = True  # the window shows TaskRadar only
        if uri.startswith(("http://", "https://", "mailto:")):
            webbrowser.open(uri)
