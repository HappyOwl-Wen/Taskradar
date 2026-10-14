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
from taskradar.connectors.fake_gmail import FakeGmailClient
from taskradar.container import Container, build_container
from taskradar.db.models import Source
from taskradar.demo.mailbox import build_demo_mailbox
from taskradar.domain.schemas import ExtractionInput, TextSegment
from taskradar.llm.base import LLMProvider
from taskradar.parsing.ocr import TesseractEngine
from taskradar.security import secrets as sk
from taskradar.security.secrets import MemorySecretStore

FIXED_NOW = dt.datetime(2026, 10, 14, 8, 0, tzinfo=dt.UTC)  # 10:00 in Berlin (CEST)
SAMPLES = Path(__file__).resolve().parent.parent / "src" / "taskradar" / "demo" / "samples"

_OCR = TesseractEngine()
OCR_AVAILABLE = _OCR.available() and {"chi_sim", "deu", "eng"} <= set(_OCR.languages())
requires_ocr = pytest.mark.skipif(not OCR_AVAILABLE, reason="Tesseract with chi_sim+deu+eng is not installed")


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


class FakeGmailRegistry:
    """Lets tests control the mailbox the Gmail sync service sees."""

    def __init__(self, clock: Clock) -> None:
        messages, attachments = build_demo_mailbox(clock())
        self.client = FakeGmailClient(messages, attachments=attachments, clock=clock, email="student@gmail.example")

    def factory(self, _source: Source) -> FakeGmailClient:
        return self.client


@pytest.fixture
def gmail(clock: Clock) -> FakeGmailRegistry:
    return FakeGmailRegistry(clock)


@pytest.fixture
def calendar_client() -> FakeCalendarClient:
    return FakeCalendarClient()


@pytest.fixture
def make_container(
    config: AppConfig, clock: Clock, gmail: FakeGmailRegistry, calendar_client: FakeCalendarClient
) -> Iterator[Callable[..., Container]]:
    created: list[Container] = []

    def _make(
        *, llm: LLMProvider | None = None, secrets: MemorySecretStore | None = None, ocr: Any = None, **overrides: Any
    ) -> Container:
        container = build_container(
            config,
            secrets=secrets or MemorySecretStore(),
            clock=clock,
            llm_provider=llm,
            # An explicit None selects the application's default factory (synthetic demo mailbox).
            gmail_client_factory=overrides.pop("gmail_client_factory", gmail.factory),
            calendar_client_factory=overrides.pop("calendar_client_factory", lambda: calendar_client),
            ocr=ocr or _OCR,
            toast=overrides.pop("toast", lambda title, body: True),
            sleep=lambda _seconds: None,
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


def enable_llm(container: Container) -> None:
    """Configure settings so the (mock) LLM is permitted: provider + consent + key."""
    container.secrets.set(sk.OPENAI_API_KEY, "sk-test-0000000000000000")
    container.settings.update({"llm": {"provider": "openai", "cloud_consent": True}})


def make_input(
    text: str,
    *,
    title: str | None = None,
    sent_at: dt.datetime | None = FIXED_NOW,
    doc_date: dt.date | None = None,
    origin_kind: str = "message",
    labels: list[str] | None = None,
    is_bulk: bool = False,
) -> ExtractionInput:
    full = f"{title}\n\n{text}" if title else text
    return ExtractionInput(
        origin_kind=origin_kind,  # type: ignore[arg-type]
        origin_id=1,
        title=title,
        text=full,
        segments=[TextSegment(text=full, page=1 if origin_kind == "document" else None, offset=0)],
        sent_at=sent_at,
        doc_date=doc_date,
        received_at=FIXED_NOW,
        labels=labels or [],
        is_bulk=is_bulk,
    )


@pytest.fixture
def api(make_container: Callable[..., Container]) -> Iterator[Any]:
    from fastapi.testclient import TestClient

    from taskradar.api.app import create_app
    from taskradar.services.system import AutostartManager

    container = make_container(gmail_client_factory=None)  # real demo-mailbox factory (honours demo settings)
    app = create_app(container, extra_hosts={"testserver"}, autostart=AutostartManager(startup_dir=None))
    with TestClient(app) as client:
        token = client.get("/api/session").json()["csrf_token"]
        client.headers.update({"X-TaskRadar-CSRF": token})
        client.container = container  # type: ignore[attr-defined]
        yield client
