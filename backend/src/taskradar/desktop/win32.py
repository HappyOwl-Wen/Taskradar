"""The few Win32 calls the desktop app needs (ctypes only, so that the installer can use them too).

Every function is safe to call on other systems: it does nothing there or returns an empty answer.
"""

from __future__ import annotations

import contextlib
import ctypes
import os
import sys
from ctypes import wintypes
from dataclasses import dataclass
from typing import Any

IS_WINDOWS = sys.platform == "win32"  # for callers; the checks below spell it out so that mypy sees them

# MessageBox flags and answers.
MB_OK = 0x0
MB_OKCANCEL = 0x1
MB_YESNO = 0x4
MB_ICONERROR = 0x10
MB_ICONWARNING = 0x30
MB_ICONINFORMATION = 0x40
MB_DEFBUTTON2 = 0x100
MB_SETFOREGROUND = 0x10000
MB_TOPMOST = 0x40000
IDOK = 1
IDYES = 6

SW_RESTORE = 9
WPF_RESTORETOMAXIMIZED = 0x2
MONITORINFOF_PRIMARY = 0x1

# DwmSetWindowAttribute: dark title bar (Windows 10 2004+ / 11) and caption colours (Windows 11).
DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36

WEBVIEW2_CLIENTS = (
    "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",  # Evergreen runtime
    "{2CD8A007-E189-409D-A2C8-9AF4EF3C72AA}",  # Beta
    "{0D50BFEC-CD6A-4F9A-964C-C7416E3ACB10}",  # Dev
    "{65C35B14-6C1D-4122-AC46-7148CC9D6497}",  # Canary
)


@dataclass(frozen=True)
class Rect:
    """A rectangle in physical screen pixels."""

    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top

    def intersection(self, other: Rect) -> Rect | None:
        left, top = max(self.left, other.left), max(self.top, other.top)
        right, bottom = min(self.right, other.right), min(self.bottom, other.bottom)
        return Rect(left, top, right, bottom) if right > left and bottom > top else None


@dataclass(frozen=True)
class Monitor:
    area: Rect
    work: Rect  # without the taskbar
    dpi: int
    primary: bool


if sys.platform == "win32":
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _RECT(ctypes.Structure):
        _fields_ = [
            ("left", wintypes.LONG),
            ("top", wintypes.LONG),
            ("right", wintypes.LONG),
            ("bottom", wintypes.LONG),
        ]

    class _MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", _RECT),
            ("rcWork", _RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    class _WINDOWPLACEMENT(ctypes.Structure):
        _fields_ = [
            ("length", wintypes.UINT),
            ("flags", wintypes.UINT),
            ("showCmd", wintypes.UINT),
            ("ptMinPosition", wintypes.POINT),
            ("ptMaxPosition", wintypes.POINT),
            ("rcNormalPosition", _RECT),
        ]

    class _FLASHWINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.UINT),
            ("hwnd", wintypes.HWND),
            ("dwFlags", wintypes.DWORD),
            ("uCount", wintypes.UINT),
            ("dwTimeout", wintypes.DWORD),
        ]

    _MONITORENUMPROC = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(_RECT), wintypes.LPARAM
    )
    _WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    _user32.EnumDisplayMonitors.argtypes = [wintypes.HDC, ctypes.c_void_p, _MONITORENUMPROC, wintypes.LPARAM]
    _user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(_MONITORINFO)]
    _user32.EnumWindows.argtypes = [_WNDENUMPROC, wintypes.LPARAM]
    _user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    _user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _user32.IsWindowVisible.argtypes = [wintypes.HWND]
    _user32.IsIconic.argtypes = [wintypes.HWND]
    _user32.IsZoomed.argtypes = [wintypes.HWND]
    _user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    _user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    _user32.GetForegroundWindow.restype = wintypes.HWND
    _user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(_RECT)]
    _user32.GetWindowPlacement.argtypes = [wintypes.HWND, ctypes.POINTER(_WINDOWPLACEMENT)]
    _user32.FlashWindowEx.argtypes = [ctypes.POINTER(_FLASHWINFO)]
    _user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
    _user32.GetDpiForWindow.argtypes = [wintypes.HWND]
    _user32.GetDpiForWindow.restype = wintypes.UINT
    _user32.GetDpiForSystem.restype = wintypes.UINT
    _user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
else:  # other systems: every function below returns before it would use these
    _user32: Any = None
    _kernel32: Any = None
    _RECT: Any = None
    _MONITORINFO: Any = None
    _WINDOWPLACEMENT: Any = None
    _FLASHWINFO: Any = None
    _MONITORENUMPROC: Any = None
    _WNDENUMPROC: Any = None


def enable_dpi_awareness() -> str:
    """Render sharply at every display scale, also after the scale changes or on a second monitor.

    Must run before the first window is created. Returns the mode that was set.
    """
    if sys.platform != "win32":
        return "none"
    with contextlib.suppress(AttributeError, OSError):
        if _user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):  # per monitor v2 (Windows 10 1703+)
            return "per-monitor-v2"
    with contextlib.suppress(AttributeError, OSError):
        if ctypes.windll.shcore.SetProcessDpiAwareness(2) == 0:  # per monitor (Windows 8.1)
            return "per-monitor"
    with contextlib.suppress(AttributeError, OSError):
        if _user32.SetProcessDPIAware():
            return "system"
    return "unchanged"


def set_app_user_model_id(app_id: str) -> None:
    """Group the window under its own taskbar button with its own icon (needed when running from python.exe)."""
    if sys.platform == "win32":
        with contextlib.suppress(AttributeError, OSError):
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(ctypes.c_wchar_p(app_id))


def message_box(text: str, title: str, flags: int = MB_OK, owner: int = 0) -> int:
    if sys.platform != "win32":
        return IDOK
    return int(_user32.MessageBoxW(owner or None, text, title, flags | MB_SETFOREGROUND))


def monitors() -> list[Monitor]:
    if sys.platform != "win32":
        return []
    found: list[Monitor] = []

    def callback(handle: int, _hdc: int, _rect: object, _data: int) -> bool:
        info = _MONITORINFO()
        info.cbSize = ctypes.sizeof(_MONITORINFO)
        if _user32.GetMonitorInfoW(handle, ctypes.byref(info)):
            dpi_x, dpi_y = wintypes.UINT(96), wintypes.UINT(96)
            with contextlib.suppress(AttributeError, OSError):
                ctypes.windll.shcore.GetDpiForMonitor(handle, 0, ctypes.byref(dpi_x), ctypes.byref(dpi_y))
            area, work = info.rcMonitor, info.rcWork
            found.append(
                Monitor(
                    area=Rect(area.left, area.top, area.right, area.bottom),
                    work=Rect(work.left, work.top, work.right, work.bottom),
                    dpi=int(dpi_x.value) or 96,
                    primary=bool(info.dwFlags & MONITORINFOF_PRIMARY),
                )
            )
        return True

    _user32.EnumDisplayMonitors(None, None, _MONITORENUMPROC(callback), 0)
    return found


def window_rect(hwnd: int) -> Rect | None:
    if sys.platform != "win32" or not hwnd:
        return None
    rect = _RECT()
    if not _user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return Rect(rect.left, rect.top, rect.right, rect.bottom)


def is_minimized(hwnd: int) -> bool:
    if sys.platform != "win32" or not hwnd:
        return False
    return bool(_user32.IsIconic(hwnd))


def is_maximized(hwnd: int) -> bool:
    """Maximised, or minimised from the maximised state (so that it opens maximised again)."""
    if sys.platform != "win32" or not hwnd:
        return False
    if _user32.IsZoomed(hwnd):
        return True
    if _user32.IsIconic(hwnd):
        placement = _WINDOWPLACEMENT()
        placement.length = ctypes.sizeof(_WINDOWPLACEMENT)
        if _user32.GetWindowPlacement(hwnd, ctypes.byref(placement)):
            return bool(placement.flags & WPF_RESTORETOMAXIMIZED)
    return False


def dpi_for_window(hwnd: int) -> int:
    if sys.platform != "win32" or not hwnd:
        return 96
    try:
        return int(_user32.GetDpiForWindow(hwnd)) or 96
    except (AttributeError, OSError):
        return 96


def find_window(pid: int, title: str) -> int | None:
    """The top-level window of process ``pid`` with this title (the TaskRadar window of a running instance)."""
    if sys.platform != "win32":
        return None
    found: list[int] = []

    def callback(hwnd: int, _data: int) -> bool:
        owner = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid:
            buffer = ctypes.create_unicode_buffer(256)
            _user32.GetWindowTextW(hwnd, buffer, 256)
            if buffer.value == title and (_user32.IsWindowVisible(hwnd) or _user32.IsIconic(hwnd)):
                found.append(hwnd)
                return False
        return True

    _user32.EnumWindows(_WNDENUMPROC(callback), 0)
    return found[0] if found else None


def bring_to_front(hwnd: int) -> bool:
    """Restore a minimised window and activate it; if Windows does not allow that, flash its taskbar button."""
    if sys.platform != "win32" or not hwnd:
        return False
    if _user32.IsIconic(hwnd):
        _user32.ShowWindow(hwnd, SW_RESTORE)
    if _user32.SetForegroundWindow(hwnd) and _user32.GetForegroundWindow() == hwnd:
        return True
    info = _FLASHWINFO(ctypes.sizeof(_FLASHWINFO), hwnd, 0x3 | 0xC, 0, 0)  # caption + tray, until activated
    _user32.FlashWindowEx(ctypes.byref(info))
    return False


def set_title_bar(hwnd: int, *, dark: bool, caption: str | None = None, text: str | None = None) -> None:
    """Match the native title bar to the app's theme: dark mode, and on Windows 11 the caption colours."""
    if sys.platform != "win32" or not hwnd:
        return
    dwmapi = ctypes.windll.dwmapi

    def set_int(attribute: int, value: int) -> None:
        data = ctypes.c_int(value)
        with contextlib.suppress(OSError):
            dwmapi.DwmSetWindowAttribute(wintypes.HWND(hwnd), attribute, ctypes.byref(data), ctypes.sizeof(data))

    set_int(DWMWA_USE_IMMERSIVE_DARK_MODE, 1 if dark else 0)
    for attribute, colour in ((DWMWA_CAPTION_COLOR, caption), (DWMWA_TEXT_COLOR, text)):
        if colour:
            set_int(attribute, colorref(colour))


def colorref(hex_colour: str) -> int:
    """'#rrggbb' -> COLORREF (0x00bbggrr)."""
    value = hex_colour.lstrip("#")
    red, green, blue = int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    return red | (green << 8) | (blue << 16)


def apps_use_dark_theme() -> bool:
    if sys.platform != "win32":
        return False
    import winreg

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
        ) as key:
            return winreg.QueryValueEx(key, "AppsUseLightTheme")[0] == 0
    except OSError:
        return False


def webview2_version() -> str | None:
    """The installed Microsoft Edge WebView2 runtime (part of Windows 11), or None."""
    if sys.platform != "win32":
        return None
    import winreg

    for client in WEBVIEW2_CLIENTS:
        for root, path in (
            (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{client}"),
            (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{client}"),
            (winreg.HKEY_CURRENT_USER, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{client}"),
        ):
            try:
                with winreg.OpenKey(root, path) as key:
                    version = str(winreg.QueryValueEx(key, "pv")[0])
            except OSError:
                continue
            if version and version != "0.0.0.0":  # noqa: S104 - a version number, not an address
                return version
    return None


def processes_running_from(folder: str) -> list[int]:
    """Processes (other than this one) whose program file lies in ``folder``: a running TaskRadar.exe there."""
    if sys.platform != "win32":
        return []
    psapi = ctypes.WinDLL("psapi")
    pids = (wintypes.DWORD * 4096)()
    needed = wintypes.DWORD()
    if not psapi.EnumProcesses(ctypes.byref(pids), ctypes.sizeof(pids), ctypes.byref(needed)):
        return []
    prefix = os.path.normcase(os.path.abspath(folder)).rstrip("\\") + "\\"
    found = []
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    for pid in pids[: needed.value // ctypes.sizeof(wintypes.DWORD)]:
        if pid in (0, os.getpid()):
            continue
        handle = _kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            continue
        try:
            buffer = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(len(buffer))
            named = _kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size))
            if named and os.path.normcase(buffer.value).startswith(prefix):
                found.append(int(pid))
        finally:
            _kernel32.CloseHandle(handle)
    return found


def attach_parent_console() -> bool:
    """Let a windowed TaskRadar.exe print to the terminal it was started from (``TaskRadar.exe --version``)."""
    if sys.platform != "win32" or (sys.stdout is not None and sys.stderr is not None):
        return False
    if not _kernel32.AttachConsole(wintypes.DWORD(-1 & 0xFFFFFFFF)):  # ATTACH_PARENT_PROCESS
        return False
    with contextlib.suppress(OSError):
        stream = open("CONOUT$", "w", encoding="utf-8", errors="replace", buffering=1)  # noqa: SIM115
        sys.stdout = stream
        sys.stderr = stream
        os.environ.setdefault("PYTHONIOENCODING", "utf-8")
        return True
    return False
