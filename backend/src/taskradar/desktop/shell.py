"""The desktop window: pywebview on Microsoft Edge WebView2 around the local server of the same process.

* Opening TaskRadar shows the window at once (start screen); the server starts behind it and the web UI replaces
  the start screen as soon as it answers.
* Closing the window leaves TaskRadar running in the notification area (tray), so reminders and timers go on;
  "Quit" in the tray menu ends it, together with the server and the background jobs. (Settings can make the close
  button quit instead.) Started by autostart, TaskRadar begins in the tray.
* The window opens where it was left (size, position, maximised), on a screen that still exists.
* A second start brings the open window to the front, also out of the tray, instead of starting TaskRadar twice.
* Links to other sites, and the Google sign-in, open in the system browser; the window only shows TaskRadar, and
  going back never leaves it for the start screen.
* Quitting with unsaved changes asks first (the page reports them, see :mod:`taskradar.desktop.bridge`).
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
from taskradar.desktop.tray import Tray
from taskradar.notify import windows as notifications
from taskradar.notify.alarm import AlarmSound
from taskradar.packaged import is_packaged
from taskradar.security.permissions import SideEffect

log = logging.getLogger(__name__)

TITLE = "TaskRadar"
APP_ID = notifications.APP_ID  # one identity for the taskbar and the notifications
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
        "unsaved_quit": "有尚未保存的修改。\n\n退出 TaskRadar 会丢失这些修改。仍要退出吗？",
        "unsaved_restart": "有尚未保存的修改。\n\n重启服务会重新加载页面，丢失这些修改。仍要重启吗？",
        "tray_title": "TaskRadar 仍在运行",
        "tray_body": "提醒和计时会继续。TaskRadar 的图标在任务栏右下角（可能收在“^”里）：点它重新打开，右键可以退出。",
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
        "unsaved_quit": "There are unsaved changes.\n\nQuitting TaskRadar discards them. Quit anyway?",
        "unsaved_restart": (
            "There are unsaved changes.\n\nRestarting the service reloads the page and discards them. Restart anyway?"
        ),
        "tray_title": "TaskRadar is still running",
        "tray_body": "Reminders and timers go on. TaskRadar's icon sits at the right of the taskbar (perhaps under ^): "
        "click it to open the window again, right-click it to quit.",
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
    notifications.register()  # name and icon of TaskRadar's Windows notifications
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
    if info and info.get("mode") == "desktop" and info.get("url") and _activate_running(str(info["url"])):
        return False  # its window came forward (also out of the tray)
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


def _activate_running(url: str) -> bool:
    """Ask the TaskRadar that runs on this data folder to show its window (it may be hidden in the tray)."""
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(f"{url}/api/session", timeout=3) as response:  # noqa: S310 - local, our URL
            token = json.loads(response.read())["csrf_token"]
        request = urllib.request.Request(  # noqa: S310 - local, our URL
            f"{url}/api/desktop/activate", method="POST", headers={"X-TaskRadar-CSRF": token}
        )
        with urllib.request.urlopen(request, timeout=3) as response:  # noqa: S310
            return bool(json.loads(response.read()).get("ok"))
    except (OSError, ValueError, KeyError):
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
        hidden=minimized,  # autostart: TaskRadar starts in the tray
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
    shell.remove_tray()
    notifications.set_click_handler(None)
    log.info("Window closed; stopping the server")
    server.stop()
    log.info("TaskRadar desktop window closed; server stopped")
    return 0


def leaves_the_app(uri: str, *, app_shown: bool) -> bool:
    """Whether a navigation to ``uri`` would take the window away from TaskRadar's own pages.

    The start and error screens are inline pages (data: / about:). Once the web UI is shown, going back to them
    (the Back key or mouse button on the first page) would show "Starting..." for ever, so they stay closed.
    """
    if uri.startswith(("data:", "about:")):
        return app_shown
    return True


class Shell:
    """Keeps the window, the tray icon and the server in step. Window events arrive on pywebview threads."""

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
        self.tray: Tray | None = None
        self._normal = prefs.window.rect if prefs.window else None
        self._normal_dpi = prefs.window.dpi if prefs.window else 96
        self._save_timer: threading.Timer | None = None
        self._native_ready = False
        self._app_shown = False  # the web UI has been loaded (from then on the start screen stays behind)
        self._quitting = False  # "Quit" was chosen (and confirmed): the next close really ends TaskRadar
        self._restarting = False
        self._restart_lock = threading.Lock()
        self._timers_changed = threading.Event()  # wakes the tray tooltip up when a timer starts, stops or ends
        self._alarm_lock = threading.Lock()
        self._alarm_sound = AlarmSound()
        self._shown_alarm: int | None = None
        self._alarm_stopped = False
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
        self.bridge.on_activate = self.show_window
        notifications.set_click_handler(self.show_window)

    # -- start ----------------------------------------------------------------------------------------------

    def after_start(self) -> None:
        """Runs once the window exists: show the web UI as soon as the server answers."""
        threading.Thread(target=self._follow_timers, name="taskradar-tray-status", daemon=True).start()
        if self.server.wait_ready(cancel=self.closed):
            self.window.load_url(self.server.url)
            if self.tray is not None:
                self.tray.set_service_state("running")
        elif not self.closed.is_set():
            log_path = str(self.server.config.logs_dir / "taskradar.log")
            code = self.server.error or "unknown"
            self.window.load_html(error_page(self.theme, self.language, code=code, log_path=log_path))
            if self.tray is not None:
                self.tray.set_service_state("failed")

    def _on_shown(self) -> None:
        native = self.window.native
        if native is not None:
            self.hwnd = int(native.Handle.ToInt64())
            self._install_tray(native)
        self._apply_title_bar()
        self._on_geometry()

    def _install_tray(self, form: Any) -> None:
        if self.tray is not None:
            return
        tray = Tray(
            form,
            ICON,
            language=self.language,
            theme=self.theme,
            on_open=self.show_window,
            on_restart=self.restart_service,
            on_quit=self.quit,
        )
        try:
            tray.install()
        except Exception:  # without a tray icon the close button simply quits
            log.exception("Could not add the TaskRadar icon to the notification area")
            return
        self.tray = tray
        tray.set_service_state("running" if self.server.ready else "failed" if self.server.error else "starting")

    def remove_tray(self) -> None:
        self._timers_changed.set()  # lets the tooltip thread see that TaskRadar ends
        with self._alarm_lock:
            self._alarm_stopped = True
            self._alarm_sound.stop()
        if self.tray is not None:
            self.tray.remove()
            self.tray = None

    def _follow_timers(self) -> None:
        """Keep the tray icon's tooltip on the running timers ("TaskRadar · 专注中 · 剩 18 分钟")."""
        container = None
        shown: str | None = None
        while not self.closed.is_set():
            current = self.server.container
            if current is not container:
                container = current
                if container is not None:
                    container.timers.subscribe(self._timers_changed.set)
                    container.timers.subscribe(self._sync_alarm)
                    container.settings.subscribe(lambda _settings, _sections: self._sync_alarm())
                    self._sync_alarm()
            try:
                status = container.timers.tray_status() if container is not None and not self._restarting else None
            except Exception:  # the database may be closing while TaskRadar ends
                log.debug("Could not read the timers for the tray", exc_info=True)
                status = None
            tray = self.tray
            if status != shown and tray is not None:
                tray.set_status(status)
                shown = status
            # The minutes left change while a timer runs; otherwise only a change wakes the thread up.
            self._timers_changed.wait(0.25 if self._restarting else 1 if container is None else 10 if status else 300)
            self._timers_changed.clear()

    def _sync_alarm(self) -> None:
        """Sound and restore the window even from the tray; acknowledgement stops the sound immediately."""
        container = self.server.container
        if container is None:
            return
        with self._alarm_lock:
            if self.closed.is_set() or self._quitting or self._restarting or self._alarm_stopped:
                self._alarm_sound.stop()
                return
            state = container.timers.alarm_state()
            alarm = state["alarm"]
            audible = bool(alarm and alarm["audible"] and state["sound_enabled"])
            if audible and not self._alarm_sound.playing:
                if container.guard.is_allowed(SideEffect.TIMER_ALARM):
                    container.guard.check(SideEffect.TIMER_ALARM, target=f"timer:{alarm['timer_id']}")
                    self._alarm_sound.start()
            elif not audible:
                self._alarm_sound.stop()
            alarm_id = alarm["id"] if alarm else None
            show = alarm_id is not None and alarm_id != self._shown_alarm
            self._shown_alarm = alarm_id
        if show:
            self.show_window()

    def _on_loaded(self) -> None:
        if self._native_ready:
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
            core.NavigationStarting += self._on_navigation_starting
            if not self.debug:  # in debug mode the full browser menu (with "Inspect") stays
                core.Settings.AreDefaultContextMenusEnabled = True
                core.ContextMenuRequested += self._on_context_menu

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

    def _save_now(self) -> None:
        with self._lock:
            if self._save_timer is not None:
                self._save_timer.cancel()
        self._save()

    # -- showing, hiding, closing and quitting ---------------------------------------------------------------

    def show_window(self) -> None:
        """Bring the window forward: out of the tray, out of the taskbar, or just to the front."""
        try:
            self.window.show()
        except Exception:  # not shown yet (still starting): it will appear by itself
            log.debug("show() before the window existed", exc_info=True)
        if self.hwnd:
            win32.bring_to_front(self.hwnd)

    def _close_to_tray(self) -> bool:
        if self.tray is None or not self.tray.installed:
            return False  # nothing to come back from: closing must quit
        container = self.server.container
        if container is None:
            return True
        try:
            return bool(container.settings.get().general.close_to_tray)
        except Exception:  # the database is unavailable: keep the safe default
            return True

    def _on_closing(self) -> bool:
        """On the UI thread; returning False keeps TaskRadar running (in the tray, or with the window open)."""
        if not self._quitting and self._close_to_tray():
            self._hide_to_tray()
            return False
        if not self._quitting and self.bridge.unsaved:  # a quit from the tray asked already
            flags = win32.MB_YESNO | win32.MB_ICONWARNING | win32.MB_DEFBUTTON2
            if win32.message_box(_texts(self.language)["unsaved"], TITLE, flags, owner=self.hwnd) != win32.IDYES:
                return False
        self._save_now()
        self.remove_tray()
        log.info("Window closing")
        return True

    def _hide_to_tray(self) -> None:
        self._save_now()
        self.window.hide()  # unsaved input stays in the page: nothing is lost
        log.info("Window hidden in the notification area")
        if not self.prefs.tray_hint_shown:
            texts = _texts(self.language)
            if notifications.show(texts["tray_title"], texts["tray_body"]):
                self.prefs.tray_hint_shown = True
                self._schedule_save()

    def quit(self) -> None:
        """ "Quit" in the tray menu (UI thread): end TaskRadar, after asking about unsaved changes."""
        if self.bridge.unsaved:
            self.show_window()  # let the user see what would be lost
            flags = win32.MB_YESNO | win32.MB_ICONWARNING | win32.MB_DEFBUTTON2
            if win32.message_box(_texts(self.language)["unsaved_quit"], TITLE, flags, owner=self.hwnd) != win32.IDYES:
                return
        self._quitting = True
        log.info("Quit from the notification area")
        self.window.destroy()

    def restart_service(self) -> None:
        """Restart only the local service, keeping this window and its tray icon alive."""
        if self.closed.is_set() or self._quitting or not self._restart_lock.acquire(blocking=False):
            return
        try:
            if self.bridge.unsaved:
                self.show_window()
                flags = win32.MB_YESNO | win32.MB_ICONWARNING | win32.MB_DEFBUTTON2
                if (
                    win32.message_box(_texts(self.language)["unsaved_restart"], TITLE, flags, owner=self.hwnd)
                    != win32.IDYES
                ):
                    self._restart_lock.release()
                    return
            self._restarting = True
            if self.tray is not None:
                self.tray.set_service_state("restarting")
            threading.Thread(target=self._restart_service, name="taskradar-restart", daemon=True).start()
        except Exception:
            self._restarting = False
            self._restart_lock.release()
            log.exception("Could not start the service restart")

    def _restart_service(self) -> None:
        ready = False
        try:
            if self.closed.is_set() or self._quitting:
                return
            current_url = self.window.get_current_url() or self.server.url
            target = (
                current_url
                if current_url == self.server.url or current_url.startswith(self.server.url + "/")
                else self.server.url
            )
            with self._alarm_lock:
                self._alarm_sound.stop()
            self._timers_changed.set()
            self.bridge.update(unsaved=False)
            self._app_shown = False  # allow the inline start/error page while the service is unavailable
            self.window.load_html(start_page(self.theme, self.language))
            log.info("Restarting the local TaskRadar service")
            ready = self.server.restart(cancel=self.closed)
            if self.closed.is_set() or self._quitting:
                return
            if ready:
                self.window.load_url(target)
                log.info("TaskRadar service restarted")
            else:
                self._show_restart_error()
        except Exception:
            log.exception("The TaskRadar service could not restart")
            if not self.closed.is_set() and not self._quitting:
                self._show_restart_error()
        finally:
            self._restarting = False
            self._timers_changed.set()
            if self.tray is not None and not self.closed.is_set() and not self._quitting:
                self.tray.set_service_state("running" if ready else "failed")
            self._restart_lock.release()

    def _show_restart_error(self) -> None:
        log_path = str(self.server.config.logs_dir / "taskradar.log")
        self.window.load_html(
            error_page(self.theme, self.language, code=self.server.error or "restart_failed", log_path=log_path)
        )
        self.show_window()

    # -- requests from the page and the server ---------------------------------------------------------------

    def _on_appearance(self, theme: str | None, language: str | None) -> None:
        self.theme = theme or self.theme
        self.language = language or self.language
        self._apply_title_bar()
        if self.tray is not None:
            self.tray.set_appearance(self.theme, self.language)
        self._schedule_save()

    def _apply_title_bar(self) -> None:
        if self.hwnd:
            win32.set_title_bar(self.hwnd, dark=self.theme == "dark", caption=FRAME[self.theme], text=TEXT[self.theme])

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
        if uri == base or uri.startswith(base + "/"):
            self._app_shown = True
            return
        if not leaves_the_app(uri, app_shown=self._app_shown):
            return  # the start or error screen while TaskRadar starts
        args.Cancel = True  # the window shows TaskRadar only
        if uri.startswith(("http://", "https://", "mailto:")):
            webbrowser.open(uri)
