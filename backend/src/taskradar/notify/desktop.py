"""Optional Windows toast notifications.

The PowerShell script is a constant; notification text (which may originate from untrusted mail)
is passed only through environment variables and XML-escaped inside PowerShell, so it can never
be interpreted as code.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys

log = logging.getLogger(__name__)

_APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"

_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$title = [System.Security.SecurityElement]::Escape($env:TASKRADAR_TOAST_TITLE)
$body = [System.Security.SecurityElement]::Escape($env:TASKRADAR_TOAST_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$binding = "<binding template='ToastGeneric'><text>$title</text><text>$body</text></binding>"
$xml.LoadXml("<toast><visual>$binding</visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:TASKRADAR_TOAST_APPID).Show($toast)
"""


def _powershell() -> str:
    """Absolute path to Windows PowerShell, so a powershell.exe earlier on PATH is never used."""
    root = os.environ.get("SYSTEMROOT", r"C:\Windows")
    return os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")


def desktop_notifications_supported() -> bool:
    return sys.platform == "win32"


def show_toast(title: str, body: str, *, timeout: float = 15.0) -> bool:
    if not desktop_notifications_supported():
        return False
    env = dict(os.environ)
    env["TASKRADAR_TOAST_TITLE"] = title[:200]
    env["TASKRADAR_TOAST_BODY"] = body[:300]
    env["TASKRADAR_TOAST_APPID"] = _APP_ID
    try:
        proc = subprocess.run(  # noqa: S603 - constant script, data via environment only
            [_powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", _SCRIPT],
            env=env,
            capture_output=True,
            timeout=timeout,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc.returncode != 0:
            log.info("Desktop notification failed (exit %s)", proc.returncode)
            return False
        return True
    except (OSError, subprocess.SubprocessError) as exc:
        log.info("Desktop notification unavailable: %s", exc.__class__.__name__)
        return False
