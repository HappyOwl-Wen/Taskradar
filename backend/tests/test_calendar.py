"""Google Calendar integration (fake client): preview, permission gate, idempotency, safety."""

from __future__ import annotations

import datetime as dt

import pytest

from taskradar.connectors.calendar import FakeCalendarClient
from taskradar.connectors.errors import TransientError
from taskradar.container import Container
from taskradar.db.session import transaction
from taskradar.domain.enums import Actor, TaskStatus
from taskradar.domain.schemas import CandidateTask, DueInfo
from taskradar.security import secrets as sk
from taskradar.services.calendar_sync import CalendarSyncError, event_id_for
from taskradar.services.tasks import Origin


def make_task(
    c: Container,
    *,
    due: dt.date | None = dt.date(2026, 11, 20),
    time: dt.time | None = None,
    semantics: str = "deadline",
    status: TaskStatus = TaskStatus.CONFIRMED,
) -> str:
    cand = CandidateTask(
        title="提交在读证明",
        action_required="通过TUMonline上传在读证明",
        confidence=0.9,
        due=DueInfo(date=due, time=time, semantics=semantics),
    )  # type: ignore[arg-type]
    with transaction(c.factory) as session:
        task = c.tasks.create_from_candidate(
            session,
            cand,
            origin=Origin(key="manual", label="test"),
            candidate_row=None,
            timezone="Europe/Berlin",
            review_reasons=[],
        )
        c.tasks.change_status(session, task, status, actor=Actor.USER)
        return task.id


def connect(c: Container) -> None:
    c.secrets.set(sk.GOOGLE_TOKEN_CALENDAR, '{"token": "fake"}')


def test_not_connected_gives_clear_error(container: Container) -> None:
    task_id = make_task(container)
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.sync(task_id, user_confirmed=True)
    assert info.value.code == "calendar_not_connected"
    assert info.value.status_code == 409


def test_confirmation_and_confirmed_task_required(container: Container) -> None:
    connect(container)
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.sync(make_task(container), user_confirmed=False)
    assert info.value.code == "confirmation_required"
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.sync(make_task(container, status=TaskStatus.CANDIDATE), user_confirmed=True)
    assert info.value.code == "task_not_confirmed"
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.sync(make_task(container, due=None), user_confirmed=True)
    assert info.value.code == "task_without_date"


def test_all_day_deadline_preview(container: Container) -> None:
    preview = container.calendar.preview(make_task(container))
    event = preview["event"]
    assert event["start"] == {"date": "2026-11-20"} and event["end"] == {"date": "2026-11-21"}
    assert event["summary"].startswith("截止：")
    assert event["transparency"] == "transparent"
    assert "attendees" not in event
    assert "不是会议时间" in event["description"]
    assert event["extendedProperties"]["private"]["taskradar_task_id"]
    assert preview["event_kind"] == "all_day_deadline"
    assert preview["connected"] is False


def test_timed_deadline_and_appointment_are_distinguished(container: Container) -> None:
    deadline = container.calendar.preview(make_task(container, time=dt.time(12, 0)))["event"]
    assert deadline["start"]["dateTime"] == "2026-11-20T11:45:00+01:00"
    assert deadline["end"]["dateTime"] == "2026-11-20T12:00:00+01:00"
    appointment = container.calendar.preview(make_task(container, time=dt.time(10, 30), semantics="appointment"))[
        "event"
    ]
    assert appointment["start"]["dateTime"] == "2026-11-20T10:30:00+01:00"
    assert appointment["end"]["dateTime"] == "2026-11-20T11:30:00+01:00"
    assert not appointment["summary"].startswith("截止")
    assert appointment["transparency"] == "opaque"


def test_sync_is_idempotent(container: Container, calendar_client: FakeCalendarClient) -> None:
    connect(container)
    task_id = make_task(container)
    first = container.calendar.sync(task_id, user_confirmed=True)
    assert first["status"] == "synced" and first["event_id"] == event_id_for(task_id)
    second = container.calendar.sync(task_id, user_confirmed=True)
    assert second.get("unchanged") is True
    assert calendar_client.calls.count("insert_event") == 1
    assert len(calendar_client.events) == 1
    assert len(calendar_client.calendars) == 1  # dedicated TaskRadar calendar created once


def test_changed_deadline_updates_the_same_event(container: Container, calendar_client: FakeCalendarClient) -> None:
    connect(container)
    task_id = make_task(container)
    container.calendar.sync(task_id, user_confirmed=True)
    with transaction(container.factory) as session:
        task = container.tasks.get(session, task_id)
        container.tasks.update_fields(session, task, {"due_date": "2026-11-27"}, actor=Actor.USER, lock=True)
        container.calendar.mark_out_of_sync(session, task)
        assert task.calendar_links[0].status == "out_of_sync"
    container.calendar.sync(task_id, user_confirmed=True)
    assert calendar_client.calls.count("insert_event") == 1
    assert calendar_client.calls.count("update_event") == 1
    [event] = calendar_client.events.values()
    assert event["start"] == {"date": "2026-11-27"}


def test_lost_link_reuses_existing_event_instead_of_duplicating(
    container: Container, calendar_client: FakeCalendarClient
) -> None:
    connect(container)
    task_id = make_task(container)
    container.calendar.sync(task_id, user_confirmed=True)
    with transaction(container.factory) as session:
        task = container.tasks.get(session, task_id)
        for link in list(task.calendar_links):
            session.delete(link)
    container.calendar.sync(task_id, user_confirmed=True)
    assert len(calendar_client.events) == 1


def test_never_modifies_foreign_events(container: Container, calendar_client: FakeCalendarClient) -> None:
    connect(container)
    task_id = make_task(container)
    container.calendar.sync(task_id, user_confirmed=True)
    key = next(iter(calendar_client.events))
    calendar_client.events[key]["extendedProperties"] = {"private": {"taskradar_task_id": "someone-else"}}
    with transaction(container.factory) as session:
        task = container.tasks.get(session, task_id)
        container.tasks.update_fields(session, task, {"title": "新的标题"}, actor=Actor.USER)
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.sync(task_id, user_confirmed=True)
    assert info.value.code == "event_not_owned"


def test_failure_is_recorded_and_retry_succeeds(container: Container, calendar_client: FakeCalendarClient) -> None:
    connect(container)
    task_id = make_task(container)
    calendar_client.fail_with = TransientError("503")
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.sync(task_id, user_confirmed=True)
    assert info.value.status_code == 502
    with transaction(container.factory) as session:
        link = container.tasks.get(session, task_id).calendar_links[0]
        assert link.status == "failed" and link.last_error
    calendar_client.fail_with = None
    assert container.calendar.sync(task_id, user_confirmed=True)["status"] == "synced"
    assert len(calendar_client.events) == 1
