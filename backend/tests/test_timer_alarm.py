"""Completion alarms are independent of Windows banners, and stop only on the intended acknowledgement."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from taskradar.container import Container
from taskradar.db.models import Notification
from taskradar.db.session import transaction
from taskradar.desktop.bridge import DesktopBridge
from taskradar.desktop.prefs import DesktopPrefs
from taskradar.desktop.shell import Shell
from taskradar.notify.alarm import AlarmSound
from taskradar.security.permissions import SideEffect

from .conftest import Clock


def test_alarm_survives_reads_without_a_banner_and_stops_explicitly(
    api: Any, clock: Clock, toasts: list[tuple[str, str]]
) -> None:
    c = api.container
    c.settings.update({"timers": {"notify": False}})
    timer = c.timers.start_pomodoro()["pomodoro"]["current"]
    clock.advance(minutes=25)
    state = api.get("/api/timers/alarm").json()
    alarm = state["alarm"]
    assert alarm["timer_id"] == timer["id"] and alarm["title"] == "专注结束"
    assert alarm["audible"] and state["sound_enabled"]
    assert toasts == []
    assert api.get("/api/timers/alarm").json() == state
    assert c.guard.is_allowed(SideEffect.TIMER_ALARM)
    assert not c.guard.is_allowed(SideEffect.TIMER_NOTIFY)
    assert api.post(f"/api/timers/alarm/{alarm['id'] + 1}/dismiss").json() == state
    assert api.post(f"/api/timers/alarm/{alarm['id']}/dismiss").json()["alarm"] is None
    assert api.get("/api/timers/alarm").json()["alarm"] is None
    with transaction(c.factory) as session:
        note = session.get(Notification, alarm["id"])
        assert note is not None and note.read_at is not None


def test_automatic_next_phase_does_not_remove_alarm_or_accept_a_stale_dismissal(
    container: Container, clock: Clock
) -> None:
    container.settings.update({"timers": {"auto_start_breaks": True}})
    container.timers.start_pomodoro()
    clock.advance(minutes=25)
    container.timers.finish_due()
    focus_alarm = container.timers.alarm_state()["alarm"]
    assert container.timers.overview()["pomodoro"]["current"]["phase"] == "short_break"
    assert container.timers.alarm_state()["alarm"] == focus_alarm
    clock.advance(minutes=5)
    container.timers.finish_due()
    break_alarm = container.timers.alarm_state()["alarm"]
    assert break_alarm["title"] == "休息结束" and break_alarm["id"] != focus_alarm["id"]
    assert container.timers.dismiss_alarm(focus_alarm["id"])["alarm"] == break_alarm
    assert container.timers.dismiss_alarm(break_alarm["id"])["alarm"] is None


def test_old_missed_phases_are_visible_without_ringing(container: Container, clock: Clock) -> None:
    container.timers.start_pomodoro()
    clock.advance(hours=2)
    container.timers.resume_schedule()
    alarm = container.timers.alarm_state()["alarm"]
    assert not alarm["audible"] and "已于" in alarm["body"]


def test_sound_can_be_off_without_disabling_completion_reminders(container: Container, clock: Clock) -> None:
    container.settings.update({"timers": {"alarm_sound": False}})
    container.timers.start_pomodoro()
    clock.advance(minutes=25)
    container.timers.finish_due()
    state = container.timers.alarm_state()
    assert state["alarm"] is not None and not state["sound_enabled"]
    assert not container.guard.is_allowed(SideEffect.TIMER_ALARM)


def test_alarms_reach_listeners_before_the_toast_service(container: Container, clock: Clock) -> None:
    events: list[str] = []
    container.timers.start_pomodoro()
    container.timers.subscribe(lambda: events.append("alarm"))

    def toast(_title: str, _body: str) -> bool:
        assert container.timers.alarm_state()["alarm"] is not None
        events.append("toast")
        return True

    container.timers.toast = toast
    clock.advance(minutes=25)
    container.timers.finish_due()
    assert events == ["alarm", "toast"]


def test_skipping_cancelling_and_countdowns_do_not_create_a_pomodoro_alarm(container: Container, clock: Clock) -> None:
    timer = container.timers.start_pomodoro()["pomodoro"]["current"]
    timer = container.timers.skip(timer["id"])["pomodoro"]["current"]
    container.timers.cancel(timer["id"])
    container.timers.start_countdown(seconds=1)
    clock.advance(seconds=1)
    container.timers.finish_due()
    assert container.timers.alarm_state()["alarm"] is None


@pytest.mark.parametrize("file_exists", [True, False])
def test_windows_audio_loops_once_and_stops_without_blocking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, file_exists: bool
) -> None:
    calls: list[tuple[Any, int]] = []
    media = tmp_path / "Media"
    media.mkdir()
    if file_exists:
        (media / "Alarm01.wav").write_bytes(b"fixture, never played")
    monkeypatch.setenv("SYSTEMROOT", str(tmp_path))
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setitem(
        sys.modules,
        "winsound",
        SimpleNamespace(
            PlaySound=lambda sound, flags: calls.append((sound, flags)),
            SND_FILENAME=1,
            SND_ALIAS=2,
            SND_ASYNC=4,
            SND_LOOP=8,
        ),
    )
    sound = AlarmSound()
    sound.start()
    sound.start()
    assert sound.playing and len(calls) == 1 and calls[0][1] & 12 == 12
    assert calls[0][0] == (str(media / "Alarm01.wav") if file_exists else "SystemExclamation")
    sound.stop()
    sound.stop()
    assert not sound.playing and calls[-1] == (None, 0) and len(calls) == 2


def test_desktop_alarm_restores_the_window_once_and_stops_on_acknowledgement(
    container: Container, clock: Clock, tmp_path: Path
) -> None:
    shown: list[bool] = []
    starts: list[bool] = []
    window: Any = SimpleNamespace(show=lambda: shown.append(True))
    server: Any = SimpleNamespace(container=container)
    shell = Shell(
        window, server, DesktopBridge(), DesktopPrefs(tmp_path / "desktop.json"), theme="light", language="zh-CN"
    )

    class Sound:
        playing = False

        def start(self) -> None:
            self.playing = True
            starts.append(True)

        def stop(self) -> None:
            self.playing = False

    player: Any = Sound()
    shell._alarm_sound = player
    container.timers.subscribe(shell._sync_alarm)
    container.settings.subscribe(lambda _settings, _sections: shell._sync_alarm())
    container.timers.start_pomodoro()
    clock.advance(minutes=25)
    container.timers.finish_due()
    assert player.playing and len(shown) == len(starts) == 1
    shell._sync_alarm()
    assert len(shown) == len(starts) == 1
    container.settings.update({"timers": {"alarm_sound": False}})
    assert not player.playing
    container.settings.update({"timers": {"alarm_sound": True}})
    assert player.playing and len(shown) == 1
    alarm = container.timers.alarm_state()["alarm"]
    container.timers.dismiss_alarm(alarm["id"])
    assert not player.playing
    container.timers.start_pomodoro()
    clock.advance(minutes=5)
    container.timers.finish_due()
    assert player.playing and len(shown) == 2
    shell.remove_tray()
    shell._sync_alarm()
    assert not player.playing
