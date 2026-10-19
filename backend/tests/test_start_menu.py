"""TaskRadar in the Start menu: Windows shows an app's notifications as banners only when a Start menu entry carries
the app's ID (without one they go to the notification centre silently)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from taskradar.desktop import install
from taskradar.notify import windows as notifications
from taskradar.services.system import StartMenuEntry

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="Windows shell")


def _codes(api: Any) -> set[str]:
    return {item["code"] for item in api.get("/api/system/summary").json()["items"]}


@windows_only
def test_the_entry_starts_this_taskradar_with_its_app_id_and_can_go_again(tmp_path: Path) -> None:
    programs = tmp_path / "Programs"
    entry = StartMenuEntry(programs_dir=programs, python_exe=sys.executable)
    assert entry.status() == {"supported": True, "present": False, "banners": False, "ours": False}

    entry.add()
    link = programs / "TaskRadar.lnk"
    assert install.shortcut_app_id(link) == notifications.APP_ID
    assert Path(install.shortcut_target(link) or "").name.lower() in {"pythonw.exe", "python.exe"}
    assert entry.status() == {"supported": True, "present": True, "banners": True, "ours": True}
    entry.add()  # again: nothing changes
    assert entry.status()["banners"] is True

    entry.remove()
    assert not link.exists()
    entry.remove()  # nothing left to remove


@windows_only
def test_the_installed_taskradars_entry_only_gets_the_app_id(tmp_path: Path) -> None:
    programs = tmp_path / "Programs"
    installed = tmp_path / "Installed" / "TaskRadar.exe"
    install.create_shortcut(programs / "TaskRadar.lnk", installed)  # as an earlier installer made it
    entry = StartMenuEntry(programs_dir=programs, python_exe=sys.executable)
    assert entry.status() == {"supported": True, "present": True, "banners": False, "ours": False}

    entry.add()
    assert install.shortcut_target(programs / "TaskRadar.lnk") == str(installed)
    assert entry.status()["banners"] is True
    with pytest.raises(RuntimeError):
        entry.remove()
    assert (programs / "TaskRadar.lnk").exists()


@windows_only
def test_adding_the_entry_needs_a_confirmation_and_ends_the_banner_warning(api: Any) -> None:
    assert api.get("/api/system/status").json()["start_menu"]["banners"] is False
    assert "notification_banners_off" in _codes(api)

    refused = api.post("/api/system/start-menu", json={"enabled": True})
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "confirmation_required"

    added = api.post("/api/system/start-menu", json={"enabled": True, "confirm": True}).json()
    assert added["banners"] is True and added["ours"] is True
    assert "notification_banners_off" not in _codes(api)

    removed = api.post("/api/system/start-menu", json={"enabled": False, "confirm": True}).json()
    assert removed["present"] is False


@windows_only
def test_no_banner_warning_when_no_windows_notifications_are_wanted(api: Any) -> None:
    api.put("/api/settings", json={"notifications": {"desktop_enabled": False}, "timers": {"notify": False}})
    assert "notification_banners_off" not in _codes(api)


def test_other_systems_have_no_start_menu(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    entry = StartMenuEntry(programs_dir=tmp_path)
    assert entry.supported is False
    with pytest.raises(RuntimeError):
        entry.add()
