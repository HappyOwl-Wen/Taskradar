"""Shared test fixtures. Every test runs against an isolated temporary data folder."""

from __future__ import annotations

import datetime as dt
import os
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

# Never touch the real user profile / credential store from tests.
os.environ.setdefault("TASKRADAR_DISABLE_SCHEDULER", "1")

from taskradar.config import AppConfig
from taskradar.connectors.calendar import FakeCalendarClient
from taskradar.container import Container, build_container
from taskradar.db.session import transaction
from taskradar.domain.schemas import DueInfo
from taskradar.security.secrets import MemorySecretStore

FIXED_NOW = dt.datetime(2026, 10, 14, 8, 0, tzinfo=dt.UTC)  # 10:00 in Berlin (CEST)


class Clock:
    def __init__(self, now: dt.datetime = FIXED_NOW) -> None:
        self.now = now

    def __call__(self) -> dt.datetime:
        return self.now

    def advance(self, **kwargs: float) -> None:
        self.now = self.now + dt.timedelta(**kwargs)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return AppConfig(data_dir=tmp_path / "data", open_browser=False, scheduler_enabled=False)


@pytest.fixture
def calendar_client() -> FakeCalendarClient:
    return FakeCalendarClient()


@pytest.fixture
def toasts() -> list[tuple[str, str]]:
    """Windows notifications the services sent (title, body), instead of real ones."""
    return []


@pytest.fixture
def make_container(
    config: AppConfig, clock: Clock, calendar_client: FakeCalendarClient, toasts: list[tuple[str, str]]
) -> Iterator[Callable[..., Container]]:
    created: list[Container] = []

    def toast(title: str, body: str) -> bool:
        toasts.append((title, body))
        return True

    def _make(*, secrets: MemorySecretStore | None = None, **overrides: Any) -> Container:
        container = build_container(
            config,
            secrets=secrets or MemorySecretStore(),
            clock=clock,
            calendar_client_factory=overrides.pop("calendar_client_factory", lambda: calendar_client),
            toast=overrides.pop("toast", toast),
            **overrides,
        )
        created.append(container)
        return container

    yield _make
    for container in created:
        container.dispose()


@pytest.fixture
def container(make_container: Callable[..., Container]) -> Container:
    return make_container()


def add_task(
    c: Container,
    title: str = "交房租",
    *,
    due: dt.date | None = None,
    time: dt.time | None = None,
    sample: bool = False,
) -> str:
    """A to-do as the user creates it (counts and reminds at once)."""
    with transaction(c.factory) as session:
        task = c.tasks.create(
            session, title=title, due=DueInfo(date=due, time=time), timezone="Europe/Berlin", sample=sample
        )
        return task.id


@pytest.fixture
def api(make_container: Callable[..., Container], tmp_path: Path) -> Iterator[Any]:
    from fastapi.testclient import TestClient

    from taskradar.api.app import create_app
    from taskradar.services.system import AutostartManager, StartMenuEntry

    container = make_container()
    app = create_app(
        container,
        extra_hosts={"testserver"},
        autostart=AutostartManager(startup_dir=None),
        # A Start menu of its own, never the user's.
        start_menu=StartMenuEntry(programs_dir=tmp_path / "Start Menu"),
    )
    with TestClient(app) as client:
        token = client.get("/api/session").json()["csrf_token"]
        client.headers.update({"X-TaskRadar-CSRF": token})
        client.container = container  # type: ignore[attr-defined]
        yield client
