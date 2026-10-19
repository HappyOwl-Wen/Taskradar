"""Windows notifications sent by TaskRadar itself, through the Windows notification API (WinRT toasts).

TaskRadar is a desktop program without an app package, so Windows learns its name and icon from a registration under
``HKCU\\Software\\Classes\\AppUserModelId\\<APP_ID>`` (the same registration the Windows App SDK writes for such
programs). Notifications then appear as "TaskRadar" with its icon, in the corner of the screen and in the
notification center, and a click on one brings the TaskRadar window forward while TaskRadar runs.

Without the WinRT bindings (``winrt-Windows.UI.Notifications``) the same notification is sent through Windows
PowerShell, still under TaskRadar's own identity. Notification text may contain task titles (also from mails
imported earlier); it is XML-escaped and only ever passed as data.
"""

from __future__ import annotations

import contextlib
import logging
import os
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

log = logging.getLogger(__name__)

APP_ID = "TaskRadar.Desktop"
DISPLAY_NAME = "TaskRadar"
REGISTRY_KEY = rf"Software\Classes\AppUserModelId\{APP_ID}"
ICON = Path(__file__).resolve().parents[1] / "desktop" / "taskradar.png"

_lock = threading.Lock()
_shown: list[Any] = []  # recent toasts: their click handlers live as long as they do
_on_click: Callable[[], None] | None = None

_POWERSHELL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($env:TASKRADAR_TOAST_XML)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:TASKRADAR_TOAST_APPID).Show($toast)
"""


def supported() -> bool:
    return sys.platform == "win32"


def register(icon: Path | None = ICON, *, key: str = REGISTRY_KEY) -> bool:
    """Tell Windows the name and icon of TaskRadar's notifications (current user only; idempotent)."""
    if sys.platform != "win32":
        return False
    import winreg

    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_WRITE) as handle:
            winreg.SetValueEx(handle, "DisplayName", 0, winreg.REG_SZ, DISPLAY_NAME)
            if icon is not None and icon.is_file():
                winreg.SetValueEx(handle, "IconUri", 0, winreg.REG_SZ, str(icon))
        return True
    except OSError as exc:
        log.info("Could not register TaskRadar's notifications: %s", exc.__class__.__name__)
        return False


def unregister(*, key: str = REGISTRY_KEY) -> bool:
    """Remove the registration again (uninstall), but only TaskRadar's own."""
    if sys.platform != "win32":
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
            name = winreg.QueryValueEx(handle, "DisplayName")[0]
        if name != DISPLAY_NAME:
            return False
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
        return True
    except OSError:
        return False


def set_click_handler(handler: Callable[[], None] | None) -> None:
    """What a click on a notification does while TaskRadar runs (the desktop window: come forward)."""
    global _on_click
    _on_click = handler


def toast_xml(title: str, body: str) -> str:
    return (
        '<toast launch="taskradar"><visual><binding template="ToastGeneric">'
        f"<text>{escape(title[:200])}</text><text>{escape(body[:300])}</text>"
        "</binding></visual></toast>"
    )


def show(title: str, body: str, *, app_id: str = APP_ID) -> bool:
    """Show one notification. False when Windows did not accept it (other systems, notifications off, errors)."""
    if not supported():
        return False
    xml = toast_xml(title, body)
    try:
        return _show_winrt(xml, app_id)
    except ImportError:
        return _show_powershell(xml, app_id)
    except OSError as exc:
        log.info("Windows notification failed: %s", exc)
        return False


def _show_winrt(xml: str, app_id: str) -> bool:
    from winrt import runtime
    from winrt.windows.data.xml.dom import XmlDocument
    from winrt.windows.ui.notifications import ToastNotification, ToastNotificationManager

    # Scheduler threads have no COM apartment of their own; the window's thread already has one.
    with contextlib.suppress(OSError):
        runtime.init_apartment(runtime.ApartmentType.MULTI_THREADED)
    document = XmlDocument()
    document.load_xml(xml)
    toast = ToastNotification(document)
    if _on_click is not None:
        handler = _on_click
        toast.add_activated(lambda _sender, _args: handler())
    ToastNotificationManager.create_toast_notifier_with_id(app_id).show(toast)
    with _lock:
        _shown.append(toast)
        del _shown[:-20]
    return True


def _powershell() -> str:
    """Absolute path to Windows PowerShell, so a powershell.exe earlier on PATH is never used."""
    root = os.environ.get("SYSTEMROOT", r"C:\Windows")
    return os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")


def _show_powershell(xml: str, app_id: str, *, timeout: float = 15.0) -> bool:
    env = dict(os.environ, TASKRADAR_TOAST_XML=xml, TASKRADAR_TOAST_APPID=app_id)
    try:
        command = [_powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]
        proc = subprocess.run(  # noqa: S603 - constant script, data via environment only
            [*command, _POWERSHELL_SCRIPT],
            env=env,
            capture_output=True,
            timeout=timeout,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.info("Windows notification unavailable: %s", exc.__class__.__name__)
        return False
    if proc.returncode != 0:
        log.info("Windows notification failed (exit %s)", proc.returncode)
        return False
    return True
