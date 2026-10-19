"""Google Calendar integration (fake client): preview, permission gate, idempotency, safety."""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

from taskradar.connectors.calendar import FakeCalendarClient
from taskradar.connectors.errors import TransientError
from taskradar.container import Container
from taskradar.db.session import transaction
from taskradar.domain.enums import Actor, TaskStatus
from taskradar.domain.schemas import DueInfo
from taskradar.security import secrets as sk
from taskradar.services.calendar_sync import CalendarSyncError, event_id_for


def make_task(
    c: Container,
    *,
    due: dt.date | None = dt.date(2026, 11, 20),
    time: dt.time | None = None,
    semantics: str = "deadline",
    status: TaskStatus = TaskStatus.CONFIRMED,
) -> str:
    with transaction(c.factory) as session:
        task = c.tasks.create(
            session,
            title="提交在读证明",
            action_required="通过TUMonline上传在读证明",
            due=DueInfo(date=due, time=time, semantics=semantics),  # type: ignore[arg-type]
            timezone="Europe/Berlin",
        )
        c.tasks.change_status(session, task, status, actor=Actor.USER)  # e.g. back to "unconfirmed" (old data)
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


# ---------------------------------------------------------------------------------------------
# Removing events
# ---------------------------------------------------------------------------------------------


def live_events(client: FakeCalendarClient) -> list[dict[str, object]]:
    return [e for e in client.events.values() if e.get("status") != "cancelled"]


def test_remove_deletes_the_event_and_it_can_be_added_again(
    container: Container, calendar_client: FakeCalendarClient
) -> None:
    connect(container)
    task_id = make_task(container)
    container.calendar.sync(task_id, user_confirmed=True)

    removed = container.calendar.remove(task_id, user_confirmed=True)
    assert removed["status"] == "removed" and removed["html_link"] is None
    assert live_events(calendar_client) == []
    with transaction(container.factory) as session:
        events = [e.event_type for e in container.tasks.get(session, task_id).events]
    assert "calendar_removed" in events
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.remove(task_id, user_confirmed=True)
    assert info.value.code == "not_in_calendar"

    # Google keeps a deleted event's id reserved, so adding it again uses a new id.
    again = container.calendar.sync(task_id, user_confirmed=True)
    assert again["status"] == "synced" and again["event_id"] == event_id_for(task_id) + "1"
    assert len(live_events(calendar_client)) == 1


def test_remove_needs_confirmation_or_the_opt_in_rule(
    container: Container, calendar_client: FakeCalendarClient
) -> None:
    connect(container)
    task_id = make_task(container)
    container.calendar.sync(task_id, user_confirmed=True)
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.remove(task_id, user_confirmed=False)
    assert info.value.code == "confirmation_required"
    container.settings.update({"calendar": {"remove_on_dismiss": False}})
    with pytest.raises(CalendarSyncError):
        container.calendar.remove(task_id, user_confirmed=False, auto_rule=True)
    assert len(live_events(calendar_client)) == 1
    container.settings.update({"calendar": {"remove_on_dismiss": True}})
    assert container.calendar.remove(task_id, user_confirmed=False, auto_rule=True)["status"] == "removed"


def test_remove_never_deletes_a_foreign_event(container: Container, calendar_client: FakeCalendarClient) -> None:
    connect(container)
    task_id = make_task(container)
    container.calendar.sync(task_id, user_confirmed=True)
    key = next(iter(calendar_client.events))
    calendar_client.events[key]["extendedProperties"] = {"private": {"taskradar_task_id": "someone-else"}}
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.remove(task_id, user_confirmed=True)
    assert info.value.code == "event_not_owned"
    assert "delete_event" not in calendar_client.calls and len(live_events(calendar_client)) == 1


def test_event_deleted_in_google_calendar_counts_as_removed(
    container: Container, calendar_client: FakeCalendarClient
) -> None:
    connect(container)
    task_id = make_task(container)
    container.calendar.sync(task_id, user_confirmed=True)
    calendar_client.events.clear()  # the user deleted it in Google Calendar
    assert container.calendar.remove(task_id, user_confirmed=True)["status"] == "removed"


def test_failed_removal_keeps_the_link_for_a_retry(container: Container, calendar_client: FakeCalendarClient) -> None:
    connect(container)
    task_id = make_task(container)
    container.calendar.sync(task_id, user_confirmed=True)
    calendar_client.fail_with = TransientError("offline")
    with pytest.raises(CalendarSyncError) as info:
        container.calendar.remove(task_id, user_confirmed=True)
    assert info.value.status_code == 502 and info.value.recoverable
    with transaction(container.factory) as session:
        link = container.tasks.get(session, task_id).calendar_links[0]
        assert link.status == "synced" and link.last_error
    calendar_client.fail_with = None
    assert container.calendar.remove(task_id, user_confirmed=True)["status"] == "removed"


def _synced_task(api: Any, title: str) -> str:
    task = api.post("/api/tasks", json={"title": title, "due_date": "2026-11-20"}).json()
    assert api.post(f"/api/tasks/{task['id']}/calendar", json={"confirm": True}).json()["status"] == "synced"
    return str(task["id"])


def test_dismissing_or_deleting_a_task_removes_its_event(api: Any, calendar_client: FakeCalendarClient) -> None:
    api.container.secrets.set(sk.GOOGLE_TOKEN_CALENDAR, '{"token": "fake"}')
    dismissed, batch_deleted, kept, deleted, batch_a, batch_b = (
        _synced_task(api, name) for name in ("Dismiss", "Batch delete", "Keep", "Delete", "Batch A", "Batch B")
    )
    assert len(live_events(calendar_client)) == 6

    assert (
        api.post(f"/api/tasks/{dismissed}/status", json={"status": "dismissed"}).json()["calendar"]["status"]
        == "removed"
    )
    gone = api.post("/api/tasks/batch", json={"ids": [batch_deleted], "action": "delete"}).json()
    assert gone == {"deleted": [batch_deleted], "count": 1, "calendar_not_removed": []}
    assert api.delete(f"/api/tasks/{deleted}").json() == {"deleted": deleted}
    assert api.get(f"/api/tasks/{deleted}").status_code == 404
    batch = api.post("/api/tasks/batch", json={"ids": [batch_a, batch_b], "action": "dismiss"}).json()
    assert batch["count"] == 2 and batch["calendar_not_removed"] == []
    remaining = live_events(calendar_client)
    assert [e["extendedProperties"]["private"]["taskradar_task_id"] for e in remaining] == [kept]  # type: ignore[index]

    # Removing by hand needs an explicit confirmation.
    assert api.post(f"/api/tasks/{kept}/calendar/remove", json={}).json()["error"]["code"] == "confirmation_required"
    assert api.post(f"/api/tasks/{kept}/calendar/remove", json={"confirm": True}).json()["status"] == "removed"
    assert live_events(calendar_client) == []


def test_removal_rule_can_be_switched_off_and_failures_are_reported(
    api: Any, calendar_client: FakeCalendarClient
) -> None:
    api.container.secrets.set(sk.GOOGLE_TOKEN_CALENDAR, '{"token": "fake"}')
    kept, offline = _synced_task(api, "Kept"), _synced_task(api, "Offline")
    api.put("/api/settings", json={"calendar": {"remove_on_dismiss": False}})
    assert api.post(f"/api/tasks/{kept}/status", json={"status": "dismissed"}).json()["calendar"]["status"] == "synced"
    assert len(live_events(calendar_client)) == 2

    api.put("/api/settings", json={"calendar": {"remove_on_dismiss": True}})
    calendar_client.fail_with = TransientError("offline")
    deleted = api.delete(f"/api/tasks/{offline}").json()
    assert deleted == {"deleted": offline, "calendar_warning": "event_not_removed"}  # the task is gone anyway


def test_the_automatic_rule_adds_new_tasks_once_and_respects_a_removal(
    api: Any, calendar_client: FakeCalendarClient
) -> None:
    api.container.secrets.set(sk.GOOGLE_TOKEN_CALENDAR, '{"token": "fake"}')
    # Off by default: a new task stays out of the calendar.
    quiet = api.post("/api/tasks", json={"title": "Quiet", "due_date": "2026-11-20"}).json()
    assert quiet["calendar"] is None and calendar_client.events == {}

    api.put("/api/settings", json={"calendar": {"auto_sync_enabled": True}})
    auto = api.post("/api/tasks", json={"title": "Auto", "due_date": "2026-11-21"}).json()
    assert auto["calendar"]["status"] == "synced" and len(live_events(calendar_client)) == 1
    no_date = api.post("/api/tasks", json={"title": "Some day"}).json()
    assert no_date["calendar"] is None  # nothing to put in a calendar

    # The user takes it out again: working on it later does not bring it back.
    api.post(f"/api/tasks/{auto['id']}/calendar/remove", json={"confirm": True})
    moved = api.post(f"/api/tasks/{auto['id']}/status", json={"status": "in_progress"}).json()
    assert moved["calendar"]["status"] == "removed" and live_events(calendar_client) == []
    # Test data never reaches the real calendar.
    sample = api.post("/api/tasks", json={"title": "Test", "due_date": "2026-11-22", "sample": True}).json()
    assert sample["calendar"] is None
