"""The tray restarts the service without overlapping workers or losing saved plans/timers."""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from taskradar.config import AppConfig
from taskradar.db.session import transaction
from taskradar.desktop import win32
from taskradar.desktop.bridge import DesktopBridge
from taskradar.desktop.prefs import DesktopPrefs
from taskradar.desktop.server import BackgroundServer, choose_port
from taskradar.desktop.shell import Shell
from taskradar.domain.schemas import DueInfo
from taskradar.security.secrets import MemorySecretStore


def _wait(predicate: Any) -> None:
    deadline = time.monotonic() + 5
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert predicate()


@pytest.fixture
def running_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    import taskradar.container as composition

    original = composition.build_container
    monkeypatch.setattr(
        composition,
        "build_container",
        lambda config: original(
            config,
            secrets=MemorySecretStore(),
            toast=lambda *_args: True,
        ),
    )
    config = AppConfig(data_dir=tmp_path / "data", port=choose_port("127.0.0.1", 0), open_browser=False)
    server = BackgroundServer(config, DesktopBridge())
    server.start()
    assert server.wait_ready(timeout=60), server.error
    try:
        yield server
    finally:
        assert server.stop()


def _token(server: BackgroundServer) -> str:
    with urllib.request.urlopen(f"{server.url}/api/session", timeout=5) as response:
        return str(json.loads(response.read())["csrf_token"])


def test_restart_keeps_saved_tasks_running_timers_and_address(running_server: BackgroundServer) -> None:
    server = running_server
    original = server.container
    assert original is not None
    with transaction(original.factory) as session:
        task = original.tasks.create(session, title="Synthetic saved plan", due=DueInfo(), timezone="Europe/Berlin")
        task_id = task.id
    countdown = original.timers.start_countdown(seconds=3600)["countdowns"][0]
    old_thread, old_url, old_token = server._thread, server.url, _token(server)
    assert server.restart(), server.error
    assert not old_thread.is_alive() and server.ready
    assert server.url == old_url and _token(server) != old_token
    current = server.container
    assert current is not None and current is not original
    with urllib.request.urlopen(f"{server.url}/api/tasks/{task_id}", timeout=5) as response:
        assert json.loads(response.read())["title"] == "Synthetic saved plan"
    with urllib.request.urlopen(f"{server.url}/api/timers", timeout=5) as response:
        restored = json.loads(response.read())["countdowns"][0]
    assert restored["id"] == countdown["id"] and restored["ends_at"] == countdown["ends_at"]
    assert restored["status"] == "running"


def test_shutdown_cancellation_does_not_start_a_replacement(running_server: BackgroundServer) -> None:
    cancel = threading.Event()
    cancel.set()
    old_thread = running_server._thread
    assert not running_server.restart(cancel=cancel)
    assert running_server._thread is old_thread and not old_thread.is_alive()
    assert running_server.container is None


def test_restart_waits_for_active_background_work(running_server: BackgroundServer) -> None:
    server = running_server
    assert server._server is not None
    started, finish = threading.Event(), threading.Event()

    def work() -> None:
        started.set()
        assert finish.wait(5)

    server._server.config.app.state.executor.submit(work)
    assert started.wait(5)
    previous = server._thread
    result: list[bool] = []
    restart = threading.Thread(target=lambda: result.append(server.restart()))
    restart.start()
    try:
        _wait(server._stopping.is_set)
        time.sleep(0.3)
        assert server._thread is previous and restart.is_alive()
    finally:
        finish.set()
        restart.join(10)
    assert result == [True] and not previous.is_alive() and server.ready


def test_a_worker_that_has_not_stopped_is_not_replaced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    server = BackgroundServer(AppConfig(data_dir=tmp_path))
    original_thread = server._thread
    monkeypatch.setattr(server, "stop", lambda: False)
    assert not server.restart()
    assert server.error == "shutdown_timeout" and server._thread is original_thread


class Window:
    def __init__(self) -> None:
        self.url = "http://127.0.0.1:8123/calendar?date=2026-10-23"
        self.urls: list[str] = []
        self.html: list[str] = []
        self.shown = 0

    def get_current_url(self) -> str:
        return self.url

    def load_url(self, url: str) -> None:
        self.urls.append(url)

    def load_html(self, html: str) -> None:
        self.html.append(html)

    def show(self) -> None:
        self.shown += 1


@pytest.fixture
def shell(tmp_path: Path) -> Any:
    window = Window()
    states: list[str] = []
    server = SimpleNamespace(
        config=AppConfig(data_dir=tmp_path),
        url="http://127.0.0.1:8123",
        error=None,
        container=None,
        restart=lambda **_kwargs: True,
    )
    instance = Shell(
        window, server, DesktopBridge(), DesktopPrefs(tmp_path / "desktop.json"), theme="light", language="zh-CN"
    )
    instance.tray = SimpleNamespace(set_service_state=states.append)
    return SimpleNamespace(shell=instance, window=window, server=server, states=states)


def test_unsaved_changes_can_cancel_restart(shell: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    shell.shell.bridge.unsaved = True
    monkeypatch.setattr(win32, "message_box", lambda *_args, **_kwargs: 7)
    shell.server.restart = lambda **_kwargs: pytest.fail("cancelled restart reached the server")
    shell.shell.restart_service()
    assert shell.shell.bridge.unsaved and not shell.shell._restart_lock.locked()
    assert not shell.window.html and not shell.states and shell.window.shown == 1


def test_restart_is_single_flight_and_returns_to_the_current_page(shell: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    started, finish = threading.Event(), threading.Event()
    calls: list[bool] = []

    def restart(**_kwargs: Any) -> bool:
        calls.append(True)
        started.set()
        assert finish.wait(5)
        return True

    shell.server.restart = restart
    shell.shell.bridge.unsaved = True
    monkeypatch.setattr(win32, "message_box", lambda *_args, **_kwargs: win32.IDYES)
    shell.shell.restart_service()
    assert started.wait(5)
    try:
        shell.shell.restart_service()
        assert calls == [True] and shell.states == ["restarting"]
    finally:
        finish.set()
    _wait(lambda: not shell.shell._restart_lock.locked())
    assert shell.window.urls == [shell.window.url] and shell.states[-1] == "running"
    assert not shell.shell.bridge.unsaved and not shell.shell._quitting


def test_a_failed_restart_can_be_retried_from_the_same_tray(shell: Any) -> None:
    shell.server.restart = lambda **_kwargs: False
    shell.server.error = "fixture_start_failure"
    shell.shell.restart_service()
    _wait(lambda: not shell.shell._restart_lock.locked())
    assert shell.states[-1] == "failed" and "fixture_start_failure" in shell.window.html[-1]
    assert shell.window.shown == 1
    shell.server.restart = lambda **_kwargs: True
    shell.server.error = None
    shell.shell.restart_service()
    _wait(lambda: not shell.shell._restart_lock.locked())
    assert shell.states[-1] == "running" and shell.window.urls == [shell.window.url]


def test_quitting_during_restart_never_reloads_a_closed_window(shell: Any) -> None:
    started, finish = threading.Event(), threading.Event()

    def restart(**_kwargs: Any) -> bool:
        started.set()
        assert finish.wait(5)
        return False

    shell.server.restart = restart
    shell.shell.restart_service()
    assert started.wait(5)
    shell.shell.closed.set()
    finish.set()
    _wait(lambda: not shell.shell._restart_lock.locked())
    assert shell.window.urls == [] and shell.states == ["restarting"]
