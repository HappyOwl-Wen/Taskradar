"""Gmail sync against the in-memory Gmail double (no real account needed)."""

from __future__ import annotations

import datetime as dt

from sqlalchemy import func, select

from taskradar.container import Container
from taskradar.db.models import Document, Message, Source, SyncCheckpoint, SyncJob, Task
from taskradar.db.session import transaction
from taskradar.demo.mailbox import demo_completion_message
from taskradar.domain.enums import SourceKind, TaskStatus
from taskradar.security import secrets as sk

from .conftest import FakeGmailRegistry


def gmail_source(c: Container) -> int:
    c.secrets.set(sk.GOOGLE_TOKEN_GMAIL, '{"token": "fake"}')  # "connected"
    with transaction(c.factory) as session:
        source = Source(kind=SourceKind.GMAIL.value, name="Gmail", account="student@gmail.example", status="ok")
        session.add(source)
        session.flush()
        return source.id


def count(c: Container, model: type) -> int:
    with transaction(c.factory) as session:
        return int(session.scalar(select(func.count()).select_from(model)) or 0)


def titles(c: Container) -> dict[str, Task]:
    with transaction(c.factory) as session:
        return {t.title: t for t in session.scalars(select(Task))}


def test_full_sync_extracts_tasks_and_skips_noise(container: Container) -> None:
    source_id = gmail_source(container)
    job = container.gmail.sync(source_id)
    assert job["status"] == "succeeded", job
    assert job["items_seen"] == 11
    tasks = titles(container)
    # Payment request + its reminder -> one task; marketing, newsletter and injection -> no task.
    assert sum("Semesterbeitrag" in t for t in tasks) == 1
    assert not any("rm -rf" in t.lower() or "powershell" in t.lower() for t in tasks)
    assert not any("headphones" in t.lower() or "newsletter" in t.lower() for t in tasks)
    # Course registration deadline was extended in a later mail of the same thread.
    course = next(t for name, t in tasks.items() if "选课" in name)
    assert course.due_date is not None
    # The exam registration came from a PDF attachment.
    assert count(container, Document) == 1
    assert any("Pruefung" in name or "Prüfung" in name for name in tasks)
    # The bank asks to confirm a new address; landlord's relative deadline needs confirmation.
    lease = next(t for t in tasks.values() if "Mietvertrag" in (t.title + t.action_required))
    assert lease.due_needs_confirmation
    with transaction(container.factory) as session:
        source = session.get(Source, source_id)
        assert source is not None and source.status == "ok" and source.last_success_at is not None
        checkpoint = session.scalar(select(SyncCheckpoint.value).where(SyncCheckpoint.key == "history_id"))
        assert checkpoint


def test_resync_is_idempotent(container: Container) -> None:
    source_id = gmail_source(container)
    container.gmail.sync(source_id)
    before = (count(container, Task), count(container, Message))
    job = container.gmail.sync(source_id)
    assert job["status"] == "succeeded"
    assert (count(container, Task), count(container, Message)) == before


def test_incremental_sync_uses_history(container: Container, gmail: FakeGmailRegistry) -> None:
    source_id = gmail_source(container)
    container.gmail.sync(source_id)
    with transaction(container.factory) as session:
        fee = next(t for t in session.scalars(select(Task)) if "Semesterbeitrag" in t.title)
        container.tasks.change_status(session, fee, TaskStatus.CONFIRMED, actor=__import__("taskradar.domain.enums",
                                                                                            fromlist=["Actor"]).Actor.USER)
        fee_id = fee.id
    gmail.client.add_message(demo_completion_message(container.clock()))
    job = container.gmail.sync(source_id)
    assert job["details"]["mode"] == "incremental"
    assert job["items_seen"] == 1
    with transaction(container.factory) as session:
        fee = session.get(Task, fee_id)
        assert fee is not None and fee.status == "completed"  # explicit payment confirmation


def test_rate_limit_is_retried_transparently(container: Container, gmail: FakeGmailRegistry) -> None:
    source_id = gmail_source(container)
    gmail.client.failure_mode = "rate_limit"
    gmail.client.failures_remaining = 2  # two 429s, then success
    job = container.gmail.sync(source_id)
    assert job["status"] == "succeeded"
    assert count(container, Task) > 0


def test_persistent_server_errors_fail_recoverably_and_keep_data(container: Container, gmail: FakeGmailRegistry) -> None:
    source_id = gmail_source(container)
    container.gmail.sync(source_id)
    tasks_before = count(container, Task)
    gmail.client.failure_mode = "server_error"
    gmail.client.failures_remaining = None
    job = container.gmail.sync(source_id)
    assert job["status"] == "failed"
    assert job["error_code"] == "transient_error"
    assert job["recoverable"] is True and job["next_retry_at"] is not None
    assert count(container, Task) == tasks_before  # nothing lost
    with transaction(container.factory) as session:
        source = session.get(Source, source_id)
        assert source is not None and source.status == "error"
    # Once the API is healthy again the retry succeeds.
    gmail.client.failure_mode = "none"
    container.clock.advance(minutes=5)  # type: ignore[attr-defined]
    assert container.jobs.due_retries()
    assert container.gmail.sync(source_id, attempt=2)["status"] == "succeeded"


def test_invalid_token_requires_reauthorization(container: Container, gmail: FakeGmailRegistry) -> None:
    source_id = gmail_source(container)
    gmail.client.failure_mode = "auth"
    job = container.gmail.sync(source_id)
    assert job["status"] == "failed" and job["error_code"] == "auth_required"
    assert job["next_retry_at"] is None  # needs the user, not a blind retry
    with transaction(container.factory) as session:
        assert session.get(Source, source_id).status == "auth_required"  # type: ignore[union-attr]


def test_not_connected_gmail_is_rejected(container: Container) -> None:
    with transaction(container.factory) as session:
        source = Source(kind=SourceKind.GMAIL.value, name="Gmail", status="ok")
        session.add(source)
        session.flush()
        source_id = source.id
    job = container.gmail.sync(source_id)
    assert job["status"] == "failed" and job["error_code"] == "auth_required"


def test_network_failure_mid_sync_keeps_checkpoint(container: Container, gmail: FakeGmailRegistry) -> None:
    source_id = gmail_source(container)
    gmail.client.failure_mode = "network"
    gmail.client.failures_remaining = None
    job = container.gmail.sync(source_id)
    assert job["status"] == "failed"
    with transaction(container.factory) as session:
        assert session.scalar(select(SyncCheckpoint).where(SyncCheckpoint.key == "history_id")) is None
        assert session.scalar(select(func.count()).select_from(SyncJob)) == 1


def test_demo_mailbox_source_works_without_google(make_container) -> None:  # type: ignore[no-untyped-def]
    from taskradar.container import build_container  # noqa: F401 - default factory path

    container = make_container(gmail_client_factory=None)
    with transaction(container.factory) as session:
        source = Source(kind=SourceKind.DEMO_MAIL.value, name="Demo", account="demo@taskradar.example", status="ok")
        session.add(source)
        session.flush()
        source_id = source.id
    job = container.gmail.sync(source_id)
    assert job["status"] == "succeeded"
    assert count(container, Task) >= 6
    # Simulated failure mode from the settings (acceptance scenario 8).
    container.settings.update({"demo": {"gmail_failure_mode": "server_error"}})
    with transaction(container.factory) as session:
        session.query(SyncCheckpoint).delete()
    failed = container.gmail.sync(source_id)
    assert failed["status"] == "failed" and failed["recoverable"]
    assert count(container, Task) >= 6
    assert container.clock() == dt.datetime(2026, 10, 14, 8, 0, tzinfo=dt.UTC)
