"""TaskRadar-Setup.exe: installs TaskRadar for the current user, without administrator rights.

A small window (the same WebView2 runtime the app uses) shows where TaskRadar goes and installs it from the program
archive packed inside this setup program (the folder build of TaskRadar.exe). The work is done by
:mod:`taskradar.desktop.install`, which ``TaskRadar.exe uninstall`` uses to remove it again.

Options for scripted and test installs (the window is not shown with ``--silent``):
  --silent                  install without asking (exit code 0 when done)
  --no-desktop-shortcut     only the Start menu entry
  --program-dir/--start-menu-dir/--desktop-dir/--registry-key   install elsewhere (tests)
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from taskradar import __version__
from taskradar.desktop import install, win32

HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
PAYLOAD = HERE / "payload" / "TaskRadar.zip"
ICON = HERE / "taskradar" / "desktop" / "taskradar.ico"
PAGE = HERE / "installer.html"

TEXTS: dict[str, dict[str, str]] = {
    "zh-CN": {
        "title": "安装 TaskRadar",
        "tagline": "本地待办、日历与专注计时，也可连接 AI 助手安排计划。",
        "location": "安装位置",
        "per_user": "只为当前用户安装，不需要管理员权限。",
        "update": "已安装 {old}，将更新到 {new}。",
        "desktop": "在桌面创建快捷方式",
        "data": "你的任务、导入的文件和设置保存在 {data}。安装、更新和卸载都不会删除它们。",
        "cancel": "取消",
        "install": "安装",
        "update_button": "更新",
        "installing": "正在安装…",
        "files": "{done} / {total} 个文件",
        "done_title": "TaskRadar 已安装",
        "done_body": "可以从开始菜单{desktop}打开它。卸载：Windows 设置 → 应用 → 已安装的应用 → TaskRadar。",
        "done_desktop": "或桌面图标",
        "finish": "完成",
        "open": "打开 TaskRadar",
        "failed_title": "安装没有完成",
        "in_use": "TaskRadar 正在运行。请先关闭 TaskRadar 窗口，然后点“重试”。",
        "not_ours": "安装位置已有一个不是由 TaskRadar 安装程序创建的文件夹。为避免覆盖其中的文件，安装已停止。",
        "bad_payload": "安装程序已损坏，请重新下载。",
        "other": "出现了意外错误：{error}",
        "retry": "重试",
        "close": "关闭",
        "no_webview2": "TaskRadar 需要 Microsoft Edge WebView2 运行时（Windows 11 已自带），这台电脑上没有找到它。\n\n"
        "现在打开微软的下载页面吗？安装后重新运行本安装程序即可。",
    },
    "en": {
        "title": "Install TaskRadar",
        "tagline": "Local tasks, calendar planning and focus timers, with an optional AI assistant.",
        "location": "Install to",
        "per_user": "For the current user only; no administrator rights needed.",
        "update": "Version {old} is installed and will be updated to {new}.",
        "desktop": "Create a desktop shortcut",
        "data": "Your tasks, imported files and settings stay in {data}. Installing, updating and uninstalling "
        "never delete them.",
        "cancel": "Cancel",
        "install": "Install",
        "update_button": "Update",
        "installing": "Installing…",
        "files": "{done} of {total} files",
        "done_title": "TaskRadar is installed",
        "done_body": "Open it from the Start menu{desktop}. To uninstall: Windows Settings → Apps → Installed apps → "
        "TaskRadar.",
        "done_desktop": " or the desktop icon",
        "finish": "Finish",
        "open": "Open TaskRadar",
        "failed_title": "The installation did not finish",
        "in_use": "TaskRadar is running. Close the TaskRadar window first, then choose “Retry”.",
        "not_ours": "The install location holds a folder that the TaskRadar installer did not create. To avoid "
        "overwriting its files, the installation stopped.",
        "bad_payload": "This setup program is damaged; please download it again.",
        "other": "Something unexpected went wrong: {error}",
        "retry": "Retry",
        "close": "Close",
        "no_webview2": "TaskRadar needs the Microsoft Edge WebView2 Runtime (part of Windows 11), which was not found "
        "on this computer.\n\nOpen Microsoft's download page now? Run this setup again after installing it.",
    },
}


def ui_language() -> str:
    """The language the user chose in TaskRadar before, otherwise Windows' display language."""
    try:
        prefs = json.loads((Path(os.environ["LOCALAPPDATA"]) / "TaskRadar" / "desktop.json").read_text("utf-8"))
        language = prefs.get("appearance", {}).get("language")
        if language in TEXTS:
            return str(language)
    except (KeyError, OSError, ValueError, AttributeError):
        pass
    if win32.IS_WINDOWS:
        primary = ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF
        return "zh-CN" if primary == 0x04 else "en"
    return "en"


def paths_from(args: argparse.Namespace) -> install.InstallPaths:
    defaults = install.default_paths()
    return install.InstallPaths(
        program_dir=Path(args.program_dir) if args.program_dir else defaults.program_dir,
        start_menu_dir=Path(args.start_menu_dir) if args.start_menu_dir else defaults.start_menu_dir,
        desktop_dir=Path(args.desktop_dir) if args.desktop_dir else defaults.desktop_dir,
        startup_dir=defaults.startup_dir,
        registry_key=args.registry_key or install.UNINSTALL_KEY,
    )


def error_text(texts: dict[str, str], exc: BaseException) -> str:
    if isinstance(exc, install.InstallError) and exc.code in texts:
        return texts[exc.code]
    return texts["other"].format(error=f"{exc.__class__.__name__}: {exc}")


def launch(exe: Path) -> None:
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: TaskRadar outlives this setup
    subprocess.Popen([str(exe)], cwd=str(exe.parent), creationflags=flags, close_fds=True)  # noqa: S603


class Api:
    """What the setup page can ask for (pywebview's JS bridge on this local page only).

    pywebview offers the page every public attribute and walks into the objects it finds (the window and its
    native form included, which keeps the bridge from ever starting), so all state here is private: the page sees
    only the public methods.
    """

    def __init__(self, paths: install.InstallPaths, language: str, payload: Path) -> None:
        self._paths = paths
        self._language = language
        self._payload = payload
        self._window: Any = None
        self._busy = False
        self._exe: Path | None = None

    def _attach(self, window: Any) -> None:
        self._window = window
        window.events.closing += lambda: not self._busy  # never leave a half-finished installation behind

    def info(self) -> dict[str, Any]:
        texts = TEXTS[self._language]
        entry = install.registered(self._paths.registry_key)
        installed = entry.get("DisplayVersion") if entry else None
        data_dir = Path(os.environ.get("LOCALAPPDATA", "")) / "TaskRadar"
        return {
            "texts": texts,
            "version": __version__,
            "programDir": str(self._paths.program_dir),
            "installed": installed,
            "dataDir": str(data_dir),
        }

    def install(self, desktop_shortcut: bool) -> None:
        if self._busy:
            return
        self._busy = True
        threading.Thread(target=self._install, args=(bool(desktop_shortcut),), daemon=True).start()

    def _install(self, desktop_shortcut: bool) -> None:
        last = -1

        def progress(done: int, total: int) -> None:
            nonlocal last
            percent = done * 100 // max(total, 1)
            if percent != last:
                last = percent
                self._window.evaluate_js(f"window.setupProgress({done}, {total})")

        try:
            self._exe = install.install(
                self._payload,
                self._paths,
                version=__version__,
                desktop_shortcut=desktop_shortcut,
                language=self._language,
                progress=progress,
            )
        except Exception as exc:  # shown in the window; nothing was changed unless the swap succeeded
            message = json.dumps(error_text(TEXTS[self._language], exc))
            self._window.evaluate_js(f"window.setupFailed({message})")
        else:
            self._window.evaluate_js(f"window.setupDone({json.dumps(desktop_shortcut)})")
        finally:
            self._busy = False

    def open_app(self) -> None:
        if self._exe is not None:
            launch(self._exe)
        self.close()

    def close(self) -> None:
        if not self._busy and self._window is not None:
            self._window.destroy()


def centred(width: int, height: int) -> tuple[int | None, int | None]:
    """Top-left corner that centres a window on the primary screen, in the logical pixels pywebview takes.

    Without a position pywebview leaves it to Windows, which puts new windows near the top left corner.
    """
    screens = win32.monitors()
    if not screens:
        return None, None
    primary = next((m for m in screens if m.primary), screens[0])
    scale = primary.dpi / 96
    work = primary.work
    return (
        round(work.left / scale + (work.width / scale - width) / 2),
        round(work.top / scale + (work.height / scale - height) / 2),
    )


def run_gui(paths: install.InstallPaths, language: str, payload: Path) -> int:
    import webview

    debug_port = os.environ.get("TASKRADAR_WEBVIEW_DEBUG_PORT")  # automated UI tests only, as in the app
    if debug_port and debug_port.isdigit():
        webview.settings["REMOTE_DEBUGGING_PORT"] = int(debug_port)
    api = Api(paths, language, payload)
    width, height = 560, 470
    x, y = centred(width, height)
    window = webview.create_window(
        TEXTS[language]["title"],
        html=PAGE.read_text(encoding="utf-8"),
        js_api=api,
        x=x,
        y=y,
        width=width,
        height=height,
        resizable=False,
        background_color="#1d1e22" if win32.apps_use_dark_theme() else "#f2f3f5",
    )
    api._attach(window)
    webview.start(private_mode=True, icon=str(ICON) if ICON.is_file() else None, gui="edgechromium")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="TaskRadar-Setup", description="Install TaskRadar for the current user")
    parser.add_argument("--silent", action="store_true")
    parser.add_argument("--no-desktop-shortcut", action="store_true")
    parser.add_argument("--program-dir")
    parser.add_argument("--start-menu-dir")
    parser.add_argument("--desktop-dir")
    parser.add_argument("--registry-key")
    parser.add_argument("--payload", help=argparse.SUPPRESS)
    parser.add_argument("--language", choices=sorted(TEXTS), help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    language = args.language or ui_language()
    paths = paths_from(args)
    payload = Path(args.payload) if args.payload else PAYLOAD

    if args.silent:
        win32.attach_parent_console()
        try:
            exe = install.install(
                payload, paths, version=__version__, desktop_shortcut=not args.no_desktop_shortcut, language=language
            )
        except Exception as exc:
            print(f"TaskRadar setup failed: {error_text(TEXTS['en'], exc)}")
            return 1
        print(f"TaskRadar {__version__} installed: {exe}")
        return 0

    win32.enable_dpi_awareness()
    if win32.webview2_version() is None:
        flags = win32.MB_YESNO | win32.MB_ICONWARNING
        if win32.message_box(TEXTS[language]["no_webview2"], "TaskRadar", flags) == win32.IDYES:
            import webbrowser

            webbrowser.open("https://developer.microsoft.com/microsoft-edge/webview2/")
        return 3
    return run_gui(paths, language, payload)


if __name__ == "__main__":
    raise SystemExit(main())
