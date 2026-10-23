"""Task recycle bin: preservation, visibility, undo, expiry and deliberate permanent deletion."""

import datetime as dt
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from taskradar.api.app import create_app
from taskradar.db.calendar_models import WorkBlock
from taskradar.db.models import CalendarLink, Notification, Task, TaskEvent, TaskLink, TaskSource, Timer
from taskradar.db.session import transaction
from taskradar.scheduler.service import SchedulerService
from taskradar.services.calendar_sync import CalendarSyncError

from .test_calendar import connect


def create(api, title="Retained task", **fields):
    response = api.post("/api/tasks", json={"title": title, **fields})
    response.raise_for_status()
    return response.json()


def restore(api, *ids):
    return api.post("/api/trash/batch", json={"ids": list(ids), "action": "restore"})


@pytest.mark.parametrize(
    "status", ["candidate", "confirmed", "in_progress", "waiting_for_reply", "completed", "dismissed"]
)
def test_restore_preserves_status_notes_deadline_sources_and_history(api, clock, status):
    task = create(api, description="Keep these notes", due_date="2026-10-22", due_time="09:30", priority="high")
    before = api.post(f"/api/tasks/{task['id']}/status", json={"status": status}).json()
    with transaction(api.container.factory) as session:
        session.add(
            TaskSource(task_id=task["id"], origin_key="manual", relation="origin", evidence=[{"quote": "Evidence"}])
        )
    deleted = api.delete(f"/api/tasks/{task['id']}")
    assert deleted.status_code == 200
    [trashed] = api.get("/api/trash").json()["items"]
    assert trashed["status"] == status and trashed["days_remaining"] == 30
    assert dt.datetime.fromisoformat(trashed["expires_at"]) == clock() + dt.timedelta(days=30)
    clock.advance(days=2)
    assert restore(api, task["id"]).json()["count"] == 1
    after = api.get(f"/api/tasks/{task['id']}").json()
    for field in (
        "status",
        "description",
        "due_date",
        "due_time",
        "due_version",
        "priority",
        "completed_at",
        "confirmed_at",
    ):
        assert after[field] == before[field]
    assert after["sources"][0]["evidence"][0]["quote"] == "Evidence"
    assert {event["id"] for event in before["events"]} <= {event["id"] for event in after["events"]}
    assert after["events"][0]["type"] == "restored"
    assert api.get("/api/trash").json()["total"] == 0


def test_trashed_tasks_leave_all_active_surfaces_and_cannot_be_mutated(api, clock, toasts):
    task = create(api, "Hidden overdue", due_date="2026-10-10")
    other = create(api, "Unscheduled task")
    changed = api.post(f"/api/tasks/{task['id']}/status", json={"status": "in_progress"}).json()
    old_undo = changed["undo_event_id"]
    with transaction(api.container.factory) as session:
        session.add(TaskLink(task_id=other["id"], other_task_id=task["id"], kind="related"))
    api.post("/api/notifications/scan").raise_for_status()
    assert api.get("/api/notifications").json()["unread"] == 1
    api.delete(f"/api/tasks/{task['id']}").raise_for_status()
    api.delete(f"/api/tasks/{other['id']}").raise_for_status()
    for query in ({}, {"q": "Hidden"}, {"status": "in_progress"}, {"manual": True}):
        assert api.get("/api/tasks", params=query).json()["total"] == 0
    dashboard = api.get("/api/dashboard").json()
    assert dashboard["counts"]["active"] == dashboard["counts"]["overdue"] == 0
    assert not dashboard["attention"] and not dashboard["lanes"]["in_progress"]
    assert api.get("/api/notifications").json() == {"items": [], "unread": 0}
    assert api.get(f"/api/tasks/{task['id']}").status_code == 404
    assert api.patch(f"/api/tasks/{task['id']}", json={"title": "Changed"}).status_code == 404
    assert api.post(f"/api/tasks/{task['id']}/status", json={"status": "completed"}).status_code == 404
    assert api.post(f"/api/tasks/{task['id']}/sample", json={"sample": True}).status_code == 404
    assert api.post(f"/api/events/{old_undo}/undo").status_code == 404
    assert api.post("/api/timers/pomodoro", json={"task_id": task["id"]}).status_code == 404
    assert api.get(f"/api/tasks/{task['id']}/calendar/preview").status_code == 404
    assert api.get(f"/api/calendar/tasks/{task['id']}/work-blocks").status_code == 404
    view = api.get("/api/calendar/view?start=2026-10-01&end=2026-11-01").json()
    assert not view["items"] and not view["unscheduled"]
    sent = len(toasts)
    clock.advance(hours=48)
    api.post("/api/notifications/scan").raise_for_status()
    assert len(toasts) == sent
    restore(api, task["id"], other["id"]).raise_for_status()
    assert api.get(f"/api/tasks/{other['id']}").json()["links"][0]["task_id"] == task["id"]
    assert api.get("/api/dashboard").json()["counts"]["active"] == 2


def test_delete_toast_undo_restores_but_cannot_restore_a_later_deletion(api):
    task = create(api)
    first = api.delete(f"/api/tasks/{task['id']}").json()["undo_event_id"]
    assert api.post(f"/api/events/{first}/undo").json()["id"] == task["id"]
    second = api.delete(f"/api/tasks/{task['id']}").json()["undo_event_id"]
    assert api.post(f"/api/events/{first}/undo").status_code == 409
    assert api.get("/api/trash").json()["total"] == 1
    restore(api, task["id"]).raise_for_status()
    assert api.post(f"/api/events/{second}/undo").status_code == 409


def test_batch_operations_validate_every_id_before_changing_anything(api):
    a, b = (create(api, title)["id"] for title in ("A", "B"))
    bad = api.post("/api/tasks/batch", json={"ids": [a, "missing"], "action": "delete"})
    assert bad.status_code == 404 and api.get(f"/api/tasks/{a}").status_code == 200
    deleted = api.post("/api/tasks/batch", json={"ids": [a, b, b], "action": "delete"}).json()
    assert deleted["count"] == 2
    assert restore(api, a, "missing").status_code == 404
    assert api.get("/api/trash").json()["total"] == 2
    assert api.post("/api/trash/batch", json={"ids": [a], "action": "delete"}).status_code == 400
    assert (
        api.post("/api/trash/batch", json={"ids": [a, "missing"], "action": "delete", "confirm": True}).status_code
        == 404
    )
    assert api.get("/api/trash").json()["total"] == 2
    assert restore(api, a, b, b).json() == {"changed": [a, b], "count": 2}
    assert restore(api, a).status_code == 409
    assert api.post("/api/trash/batch", json={"ids": [a], "action": "delete", "confirm": True}).status_code == 409


def test_trash_search_pagination_and_expiry_are_based_on_deletion_time(api, clock):
    first = create(api, "First", description="find by notes")["id"]
    second = create(api, "Second")["id"]
    api.delete(f"/api/tasks/{first}").raise_for_status()
    clock.advance(hours=1)
    api.delete(f"/api/tasks/{second}").raise_for_status()
    assert api.get("/api/trash", params={"q": "by notes"}).json()["items"][0]["id"] == first
    page = api.get("/api/trash", params={"limit": 1, "offset": 1}).json()
    assert page["total"] == 2 and [t["id"] for t in page["items"]] == [first]
    clock.advance(days=29, hours=22, minutes=59, seconds=59)
    assert api.get("/api/trash").json()["items"][-1]["days_remaining"] == 1
    clock.advance(seconds=1)
    expired = restore(api, first)
    assert expired.status_code == 404 and expired.json()["error"]["code"] == "task_trash_expired"
    assert [t["id"] for t in api.get("/api/trash").json()["items"]] == [second]
    with transaction(api.container.factory) as session:
        assert session.get(Task, first) is None
        assert session.get(Task, second) is not None


def test_permanent_delete_cascades_history_and_reminders_but_keeps_timer_and_work_block(api, clock):
    task = create(api, due_date="2026-10-10")["id"]
    api.post("/api/notifications/scan").raise_for_status()
    api.post("/api/timers/pomodoro", json={"task_id": task}).raise_for_status()
    with transaction(api.container.factory) as session:
        block = WorkBlock(
            id="independent-plan",
            task_id=task,
            title="Independent plan",
            start_at=clock(),
            end_at=clock() + dt.timedelta(hours=1),
            timezone="Europe/Berlin",
        )
        session.add(block)
        session.flush()
        block_id = block.id
    api.delete(f"/api/tasks/{task}").raise_for_status()
    assert api.get("/api/timers").json()["pomodoro"]["current"]["task_id"] is None
    result = api.post("/api/trash/batch", json={"ids": [task], "action": "delete", "confirm": True})
    assert result.json() == {"changed": [task], "count": 1}
    assert restore(api, task).status_code == 404
    with transaction(api.container.factory) as session:
        assert session.get(Task, task) is None
        assert not session.scalars(select(TaskEvent).where(TaskEvent.task_id == task)).all()
        assert not session.scalars(select(Notification).where(Notification.task_id == task)).all()
        assert session.get(WorkBlock, block_id).task_id is None
        assert session.scalar(select(Timer)).task_id is None


def test_expiry_runs_on_startup_and_in_the_background(api, clock):
    expired = create(api, "Expired")["id"]
    kept = create(api, "Kept")["id"]
    api.delete(f"/api/tasks/{expired}").raise_for_status()
    clock.advance(days=30)
    with (
        TestClient(create_app(api.container, extra_hosts={"testserver"})),
        transaction(api.container.factory) as session,
    ):
        assert session.get(Task, expired) is None
        assert session.get(Task, kept) is not None
    scheduler = SchedulerService(api.container)
    scheduler._configure(api.container.settings.get())
    assert scheduler.scheduler.get_job("trash-cleanup") is not None
    api.delete(f"/api/tasks/{kept}").raise_for_status()
    clock.advance(days=30)
    scheduler.trash()
    with transaction(api.container.factory) as session:
        assert session.get(Task, kept) is None


@pytest.mark.parametrize("remove_event", [True, False])
def test_delete_honours_calendar_setting_and_restore_keeps_links_for_resync(api, calendar_client, remove_event):
    connect(api.container)
    api.container.settings.update({"calendar": {"remove_on_dismiss": remove_event}})
    task = create(api, due_date="2026-10-22")["id"]
    link = api.post(f"/api/tasks/{task}/calendar", json={"confirm": True}).json()
    api.delete(f"/api/tasks/{task}").raise_for_status()
    assert ("delete_event" in calendar_client.calls) == remove_event
    restore(api, task).raise_for_status()
    restored = api.get(f"/api/tasks/{task}").json()
    assert restored["calendar"]["event_id"] == link["event_id"]
    assert restored["calendar"]["status"] == ("removed" if remove_event else "synced")
    synced = api.post(f"/api/tasks/{task}/calendar", json={"confirm": True})
    assert synced.status_code == 200


def test_failed_calendar_removal_preserves_link_for_recovery(api, monkeypatch):
    task = create(api, due_date="2026-10-22")["id"]
    with transaction(api.container.factory) as session:
        session.add(
            CalendarLink(
                task_id=task, calendar_id="owned", event_id="event", event_kind="all_day_deadline", status="synced"
            )
        )
    remove_event = Mock(side_effect=CalendarSyncError("calendar_not_connected", "Offline", 409))
    monkeypatch.setattr(api.container.calendar, "remove", remove_event)
    deleted = api.delete(f"/api/tasks/{task}").json()
    assert deleted["calendar_warning"] == "event_not_removed"
    restore(api, task).raise_for_status()
    assert api.get(f"/api/tasks/{task}").json()["calendar"]["event_id"] == "event"


def test_independent_work_block_stays_editable_and_recovers_its_task_link(container, calendar_client):
    from taskradar.domain.calendar import EventForm

    from .conftest import add_task
    from .test_calendar_workspace import END, START, draft, form, setup

    editor = setup(container, calendar_client)
    task_id = add_task(container, due=dt.date(2026, 10, 30))
    block = container.workspace.save_block(task_id, EventForm(**form()))
    with transaction(container.factory) as session:
        container.tasks.trash(session, container.tasks.get(session, task_id))
    [work] = container.workspace.view(START, END)["items"]
    assert work["task_id"] is None and work["kind"] == "work"
    draft_id = draft(editor, work_block_id=block["work_block_id"])
    assert editor.commit(draft_id, confirm=True)["status"] == "saved"
    with transaction(container.factory) as session:
        container.tasks.restore(session, container.tasks.get_trashed(session, task_id))
    items = container.workspace.view(START, END)["items"]
    assert all(item["task_id"] == task_id for item in items)


def test_export_includes_recoverable_tasks_and_delete_all_empties_trash(api):
    task = create(api)["id"]
    api.delete(f"/api/tasks/{task}").raise_for_status()
    exported = api.container.data.export()
    assert exported["tasks"][0]["deleted_at"] is not None
    assert any(event["event_type"] == "trashed" for event in exported["task_events"])
    api.post("/api/data/delete-all", json={"confirm": "DELETE"}).raise_for_status()
    assert api.get("/api/trash").json()["total"] == 0
