"""Workspace contracts with isolated SQLite + Fake Calendar, never real accounts."""

from __future__ import annotations

import copy
import datetime as dt
import json
import uuid
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from taskradar.connectors.errors import AuthRequiredError, RateLimitedError, TransientError
from taskradar.connectors.google_oauth import ACCESS_SCOPES, OAuthError, _Pending
from taskradar.db.calendar_models import CalendarDraft, CalendarSource, CalendarWindow, GoogleEvent, WorkBlock
from taskradar.db.models import CalendarLink, Setting, Task
from taskradar.db.session import transaction
from taskradar.domain.calendar import EventForm
from taskradar.security import secrets as sk
from taskradar.security.permissions import PermissionDenied
from taskradar.services.calendar_editor import CalendarEditor
from taskradar.services.calendar_sync import CalendarSyncError
from tests.conftest import add_task

START, END = dt.date(2026, 10, 1), dt.date(2026, 11, 1)
PRIMARY, OWN, READONLY = "user@example.test", "taskradar@example.test", "shared@example.test"


def form(**updates):
    return {
        "title": "Write report",
        "start": "2026-10-22T10:00",
        "end": "2026-10-22T11:00",
        "timezone": "Europe/Berlin",
        **updates,
    }


def event(client, calendar=PRIMARY, id="normal", **updates):
    return client.insert_event(calendar, {"id": id, **EventForm(**form()).google_body(), **updates})


def setup(c, client, tier="edit"):
    c.secrets.set(sk.GOOGLE_TOKEN_CALENDAR, json.dumps({"token": "fake", "scopes": ACCESS_SCOPES[tier]}))
    client.calendars.update(
        {
            PRIMARY: {"summary": "Personal", "primary": True, "timeZone": "Europe/Berlin", "accessRole": "owner"},
            OWN: {"summary": "TaskRadar", "timeZone": "Europe/Berlin", "accessRole": "owner"},
            READONLY: {"summary": "Team", "timeZone": "America/New_York", "accessRole": "reader"},
        }
    )
    with transaction(c.factory) as session:
        session.add(Setting(key="calendar_state", value={"calendar_id": OWN}))
    c.workspace.refresh(START, END)
    ids = [OWN] if tier == "app" else [PRIMARY, OWN, READONLY]
    c.workspace.select_sources(ids, OWN if tier == "app" else PRIMARY, tier == "edit")
    return CalendarEditor(c.workspace)


def draft(editor, calendar=PRIMARY, operation="create", original=None, **updates):
    id = str(uuid.uuid4())
    editor.save_draft(
        id,
        {
            "operation": operation,
            "calendar_id": calendar,
            "event_id": original["id"] if original else None,
            "base_event": original or {},
            "payload": form(),
            **updates,
        },
    )
    return id


def test_disconnected_local_calendar_and_work_block_do_not_change_deadline(api):
    task = api.post("/api/tasks", json={"title": "Local deadline", "due_date": "2026-10-22"}).json()
    no_date = api.post("/api/tasks", json={"title": "Unscheduled"}).json()
    view = api.get("/api/calendar/view?start=2026-10-01&end=2026-11-01").json()
    assert view["items"][0]["all_day"] and view["items"][0]["kind"] == "deadline"
    assert view["unscheduled"] == [{"id": no_date["id"], "title": "Unscheduled"}]
    block = api.post("/api/calendar/work-blocks", json={**form(), "task_id": task["id"]})
    assert block.status_code == 201, block.text
    assert api.get(f"/api/tasks/{task['id']}").json()["due_date"] == "2026-10-22"
    stale = api.put(f"/api/calendar/work-blocks/{block.json()['work_block_id']}", json={**form(), "revision": 0})
    assert stale.status_code == 409
    api.delete(f"/api/tasks/{task['id']}")
    assert api.get("/api/calendar/view?start=2026-10-01&end=2026-11-01").json()["items"][0]["task_id"] is None


@pytest.mark.parametrize(
    "tier,calendar,allowed",
    [
        ("app", OWN, True),
        ("app", PRIMARY, False),
        ("read", PRIMARY, False),
        ("read", OWN, True),
        ("edit", PRIMARY, True),
        ("edit", READONLY, False),
    ],
)
def test_permissions_are_tiered(container, calendar_client, tier, calendar, allowed):
    editor = setup(container, calendar_client, tier)
    id = draft(editor, calendar)
    if allowed:
        assert editor.commit(id, confirm=True)["status"] == "saved"
    else:
        with pytest.raises((PermissionDenied, CalendarSyncError)):
            editor.commit(id, confirm=True)
    assert len(calendar_client.events) == int(allowed)


def test_selected_app_toggle_confirmation_and_fresh_acl_are_required(container, calendar_client):
    editor = setup(container, calendar_client)
    id = draft(editor)
    with pytest.raises(PermissionDenied):
        editor.commit(id, confirm=False)
    container.workspace.select_sources([PRIMARY], PRIMARY, False)
    with pytest.raises(PermissionDenied, match="editing"):
        editor.commit(id, confirm=True)
    container.workspace.select_sources([OWN], OWN, True)
    with pytest.raises(PermissionDenied, match="not selected"):
        editor.commit(id, confirm=True)
    container.workspace.select_sources([PRIMARY], PRIMARY, True)
    calendar_client.calendars[PRIMARY]["accessRole"] = "reader"
    with pytest.raises(PermissionDenied, match="read-only"):
        editor.commit(id, confirm=True)
    assert not calendar_client.events


def test_multi_calendar_pagination_dedup_and_read_only_instances(container, calendar_client):
    setup(container, calendar_client)
    calendar_client.page_size = 1
    task_id = add_task(container, due=dt.date(2026, 10, 22))
    container.calendar.sync(task_id, user_confirmed=True)
    event(calendar_client)
    event(calendar_client, READONLY, "meeting", attendees=[{"email": "someone@example.test"}])
    event(
        calendar_client,
        PRIMARY,
        "instance",
        recurringEventId="series",
        originalStartTime={"dateTime": "2026-10-22T10:00:00+02:00"},
    )
    event(
        calendar_client,
        PRIMARY,
        "birthday",
        eventType="birthday",
        start={"date": "2026-10-25"},
        end={"date": "2026-10-26"},
    )
    assert container.workspace.refresh(START, END)["status"] == "succeeded"
    view = container.workspace.view(START, END)
    assert len(view["items"]) == 5
    assert len([i for i in view["items"] if i.get("task_id") == task_id]) == 1
    assert all(not i["editable"] for i in view["items"] if i.get("event_id") in ("meeting", "instance", "birthday"))
    assert any("pageToken" in r for r in calendar_client.requests)
    assert all(not ("syncToken" in r and ("timeMin" in r or "timeMax" in r)) for r in calendar_client.requests)


def test_remote_updates_deletions_and_etag_patch_preserve_other_fields(container, calendar_client):
    editor = setup(container, calendar_client)
    remote = event(
        calendar_client,
        reminders={"useDefault": True},
        conferenceData={"conferenceId": "keep"},
        attachments=[{"fileId": "keep"}],
    )
    container.workspace.refresh(START, END)
    id = draft(editor, operation="update", original=remote, payload=form(title="Changed in TaskRadar"))
    editor.commit(id, confirm=True)
    changed = calendar_client.get_event(PRIMARY, remote["id"])
    assert changed["summary"] == "Changed in TaskRadar"
    for key in ("reminders", "conferenceData", "attachments"):
        assert changed[key] == remote[key]
    calendar_client.update_event(PRIMARY, remote["id"], {**changed, "summary": "Changed in Google"})
    container.workspace.refresh(START, END)
    assert container.workspace.view(START, END)["items"][0]["title"] == "Changed in Google"
    calendar_client.delete_event(PRIMARY, remote["id"])
    container.workspace.refresh(START, END)
    assert not container.workspace.view(START, END)["items"]


def test_conflict_keeps_both_versions_rebase_is_conditional(container, calendar_client):
    editor = setup(container, calendar_client)
    remote = event(calendar_client)
    id = draft(editor, operation="update", original=remote, payload=form(title="My edits"))
    calendar_client.update_event(PRIMARY, remote["id"], {**remote, "summary": "Someone else's edits"})
    with pytest.raises(CalendarSyncError) as error:
        editor.commit(id, confirm=True)
    assert error.value.code == "event_conflict"
    with transaction(container.factory) as session:
        saved = session.get(CalendarDraft, id)
        assert saved.payload["title"] == "My edits"
        assert saved.remote_event["summary"] == "Someone else's edits"
    editor.resolve(id, "rebase")
    editor.commit(id, confirm=True)
    assert calendar_client.get_event(PRIMARY, remote["id"])["summary"] == "My edits"


def test_timeout_after_create_is_idempotent_across_retry(container, calendar_client, monkeypatch):
    editor = setup(container, calendar_client)
    id = draft(editor)
    original = calendar_client.insert_event

    def timeout(calendar_id, body):
        original(calendar_id, body)
        raise TransientError("Response lost")

    monkeypatch.setattr(calendar_client, "insert_event", timeout)
    with pytest.raises(TransientError):
        editor.commit(id, confirm=True)
    monkeypatch.setattr(calendar_client, "insert_event", original)
    assert editor.commit(id, confirm=True)["status"] == "saved"
    assert len(calendar_client.events) == 1
    assert editor.commit(id, confirm=True)["status"] == "saved"
    assert len(calendar_client.events) == 1


def test_full_resync_failure_preserves_cache_tasks_drafts_and_other_calendars(container, calendar_client):
    editor = setup(container, calendar_client)
    event(calendar_client)
    event(calendar_client, READONLY, "other")
    task_id = add_task(container, due=dt.date(2026, 10, 22))
    id = draft(editor)
    container.workspace.refresh(START, END)
    with transaction(container.factory) as session:
        token = session.get(CalendarSource, PRIMARY).sync_token
    calendar_client.expired_tokens.add(token)
    calendar_client.fail_calendars[PRIMARY] = TransientError("Offline")
    assert container.workspace.refresh(START, END)["status"] == "partial"
    view = container.workspace.view(START, END)
    assert len(view["items"]) == 3 and view["drafts"][0]["id"] == id
    calendar_client.fail_calendars.clear()
    assert container.workspace.refresh(START, END)["status"] == "succeeded"
    with transaction(container.factory) as session:
        assert session.get(Task, task_id)
        assert session.get(CalendarDraft, id)
        assert session.get(GoogleEvent, (READONLY, "other"))


def test_pagination_failure_retains_complete_previous_snapshot(container, calendar_client, monkeypatch):
    setup(container, calendar_client)
    event(calendar_client)
    container.workspace.refresh(START, END)
    event(calendar_client, id="second")
    calendar_client.page_size = 1
    original = calendar_client.list_events

    def fail_page(calendar_id, **params):
        if calendar_id == PRIMARY and "pageToken" in params:
            raise TransientError("Page failed")
        return original(calendar_id, **params)

    monkeypatch.setattr(calendar_client, "list_events", fail_page)
    assert container.workspace.refresh(START, END)["status"] == "partial"
    assert len(container.workspace.view(START, END)["items"]) == 1


@pytest.mark.parametrize("failure", [RateLimitedError("Too many", retry_after=900), AuthRequiredError("Expired")])
def test_background_backoff_and_auth_wait_preserve_cache(container, calendar_client, failure):
    setup(container, calendar_client)
    event(calendar_client)
    container.workspace.refresh(START, END)
    calendar_client.fail_calendars[PRIMARY] = failure
    container.workspace.refresh(START, END)
    before = len([r for r in calendar_client.requests if r["calendarId"] == PRIMARY])
    container.workspace.refresh(background=True)
    assert len([r for r in calendar_client.requests if r["calendarId"] == PRIMARY]) == before
    assert len(container.workspace.view(START, END)["items"]) == 1


def test_linked_work_remote_changes_deletes_and_local_delete_are_independent(container, calendar_client):
    editor = setup(container, calendar_client)
    task_id = add_task(container, due=dt.date(2026, 10, 30))
    block = container.workspace.save_block(task_id, EventForm(**form()))
    id = draft(editor, work_block_id=block["work_block_id"])
    result = editor.commit(id, confirm=True)["result"]
    container.workspace.refresh(START, END)
    assert len(container.workspace.view(START, END)["items"]) == 2  # deadline + work, not a duplicate event
    changed = {
        **result,
        "start": {"dateTime": "2026-10-23T15:00:00+02:00"},
        "end": {"dateTime": "2026-10-23T17:00:00+02:00"},
    }
    calendar_client.update_event(PRIMARY, result["id"], changed)
    container.workspace.refresh(START, END)
    with transaction(container.factory) as session:
        assert session.get(Task, task_id).due_date == dt.date(2026, 10, 30)
        assert session.get(WorkBlock, block["work_block_id"]).start_at.hour == 13
    delete = draft(editor, operation="delete", original=calendar_client.get_event(PRIMARY, result["id"]))
    editor.commit(delete, confirm=True)
    with transaction(container.factory) as session:
        assert session.get(Task, task_id)
        assert session.get(WorkBlock, block["work_block_id"]).sync_status == "remote_deleted"
    container.workspace.delete_block(block["work_block_id"])
    with transaction(container.factory) as session:
        assert session.get(Task, task_id)


def test_ordinary_event_never_creates_task_implicitly(container, calendar_client):
    editor = setup(container, calendar_client)
    remote = event(calendar_client)
    container.workspace.refresh(START, END)
    with transaction(container.factory) as session:
        assert session.scalar(select(Task)) is None
    linked = editor.link_task(PRIMARY, remote["id"], confirm=True)
    assert editor.link_task(PRIMARY, remote["id"], confirm=True) == linked
    with transaction(container.factory) as session:
        assert session.get(Task, linked["task_id"]).due_date is None


@pytest.mark.parametrize(
    "updates",
    [{"recurringEventId": "series"}, {"attendees": [{"email": "test@example.test"}]}, {"eventType": "outOfOffice"}],
)
def test_complex_edit_rejected_server_side(container, calendar_client, updates):
    editor = setup(container, calendar_client)
    remote = event(calendar_client, **updates)
    id = draft(editor, operation="update", original=remote)
    with pytest.raises(CalendarSyncError) as error:
        editor.commit(id, confirm=True)
    assert error.value.code == "complex_event"
    assert calendar_client.get_event(PRIMARY, remote["id"]) == remote


def test_dst_gap_overlap_and_elapsed_time():
    with pytest.raises(ValidationError, match="nonexistent_local_time"):
        EventForm(**form(start="2026-03-29T02:30", end="2026-03-29T04:00"))
    with pytest.raises(ValidationError, match="ambiguous_local_time"):
        EventForm(**form(start="2026-10-25T02:30", end="2026-10-25T03:30"))
    first = EventForm(**form(start="2026-10-25T02:30", end="2026-10-25T03:30", start_fold=0))
    second = EventForm(**form(start="2026-10-25T02:30", end="2026-10-25T03:30", start_fold=1))
    assert (first.end_at - first.start_at).total_seconds() == 7200
    assert (second.end_at - second.start_at).total_seconds() == 3600
    assert first.google_body()["start"]["dateTime"].endswith("+02:00")
    assert second.google_body()["start"]["dateTime"].endswith("+01:00")


def test_all_day_exclusive_boundary_and_cross_day(container, calendar_client):
    setup(container, calendar_client)
    event(calendar_client, id="all-day", start={"date": "2026-10-21"}, end={"date": "2026-10-23"})
    event(
        calendar_client,
        id="night",
        start={"dateTime": "2026-10-24T23:30:00+02:00"},
        end={"dateTime": "2026-10-25T03:30:00+01:00"},
    )
    container.workspace.refresh(dt.date(2026, 10, 23), END)
    view = container.workspace.view(dt.date(2026, 10, 23), END)
    assert [i["event_id"] for i in view["items"]] == ["night"]


def test_oauth_cancel_and_missing_scope_keep_existing_token(container, clock):
    old = json.dumps({"token": "fake", "scopes": ACCESS_SCOPES["app"]})
    container.secrets.set(sk.GOOGLE_TOKEN_CALENDAR, old)
    flow = SimpleNamespace(
        fetch_token=lambda **kw: None,
        credentials=SimpleNamespace(granted_scopes=ACCESS_SCOPES["app"], scopes=ACCESS_SCOPES["edit"]),
    )
    container.oauth._pending["cancel"] = _Pending("calendar", flow, clock(), ACCESS_SCOPES["edit"])
    with pytest.raises(OAuthError, match="cancelled"):
        container.oauth.complete(state="cancel", code=None, error="access_denied")
    container.oauth._pending["missing"] = _Pending("calendar", flow, clock(), ACCESS_SCOPES["edit"])
    with pytest.raises(OAuthError, match="not granted"):
        container.oauth.complete(state="missing", code="code", error=None)
    assert container.secrets.get(sk.GOOGLE_TOKEN_CALENDAR) == old


def test_account_change_cannot_mix_remote_caches(container, calendar_client):
    setup(container, calendar_client)
    event(calendar_client)
    container.workspace.refresh(START, END)
    old = copy.deepcopy(container.workspace.view(START, END)["items"])
    calendar_client.calendars[PRIMARY]["primary"] = False
    calendar_client.calendars["other@example.test"] = {"primary": True, "summary": "Other account"}
    assert container.workspace.refresh(START, END)["status"] == "failed"
    assert container.workspace.view(START, END)["items"] == old


def test_export_and_delete_all_include_local_work_and_drafts(container, calendar_client):
    editor = setup(container, calendar_client)
    draft(editor)
    container.workspace.save_block(None, EventForm(**form()))
    exported = container.data.export()
    assert exported["calendar_drafts"] and exported["work_blocks"]
    assert all("sync_token" not in s for s in exported["calendar_sources"])
    container.data.delete_all()
    with transaction(container.factory) as session:
        for model in (WorkBlock, CalendarDraft, GoogleEvent, CalendarWindow, CalendarSource):
            assert session.scalar(select(model)) is None


@pytest.mark.parametrize("choice", ["remote", "local"])
def test_legacy_link_conflict_requires_explicit_version_choice(container, calendar_client, choice):
    setup(container, calendar_client)
    task_id = add_task(container, due=dt.date(2026, 10, 22))
    link = container.calendar.sync(task_id, user_confirmed=True)
    original = calendar_client.get_event(OWN, link["event_id"])
    remote = calendar_client.update_event(
        OWN,
        link["event_id"],
        {**original, "summary": "截止：Google version", "start": {"date": "2026-10-24"}, "end": {"date": "2026-10-25"}},
    )
    container.workspace.refresh(START, END)
    with transaction(container.factory) as session:
        assert (
            session.scalar(select(CalendarLink).where(CalendarLink.task_id == task_id)).last_error == "remote_changed"
        )
    container.workspace.resolve_task_link(task_id, choice, remote["etag"])
    with transaction(container.factory) as session:
        task = session.get(Task, task_id)
        assert task.due_date == dt.date(2026, 10, 24 if choice == "remote" else 22)
        if choice == "remote":
            assert task.title == "Google version"
    assert (
        calendar_client.get_event(OWN, link["event_id"])["start"]["date"]
        == f"2026-10-{24 if choice == 'remote' else 22}"
    )


def test_create_retry_after_remote_edit_becomes_resolvable_conflict(container, calendar_client, monkeypatch):
    editor = setup(container, calendar_client)
    id = draft(editor)
    original = calendar_client.insert_event

    def timeout(calendar_id, body):
        result = original(calendar_id, body)
        calendar_client.update_event(calendar_id, result["id"], {**result, "summary": "Edited elsewhere"})
        raise TransientError("Lost response")

    monkeypatch.setattr(calendar_client, "insert_event", timeout)
    with pytest.raises(TransientError):
        editor.commit(id, confirm=True)
    monkeypatch.setattr(calendar_client, "insert_event", original)
    with pytest.raises(CalendarSyncError, match="Both versions"):
        editor.commit(id, confirm=True)
    resolved = editor.resolve(id, "rebase")
    assert resolved["operation"] == "update"
    editor.commit(id, confirm=True)
    assert len(calendar_client.events) == 1


def test_full_resync_reconciles_deletion_without_tombstone(container, calendar_client):
    setup(container, calendar_client)
    task_id = add_task(container, due=dt.date(2026, 10, 22))
    link = container.calendar.sync(task_id, user_confirmed=True)
    container.workspace.refresh(START, END)
    with transaction(container.factory) as session:
        token = session.get(CalendarSource, OWN).sync_token
    calendar_client.expired_tokens.add(token)
    del calendar_client.events[(OWN, link["event_id"])]
    assert container.workspace.refresh(START, END)["status"] == "succeeded"
    with transaction(container.factory) as session:
        assert session.get(Task, task_id)
        assert session.scalar(select(CalendarLink).where(CalendarLink.task_id == task_id)).status == "removed"


def test_shared_calendar_writer_can_edit_plain_events(container, calendar_client):
    editor = setup(container, calendar_client)
    calendar_client.calendars[PRIMARY]["accessRole"] = "writer"
    remote = event(calendar_client, organizer={"self": False, "email": "calendar-owner@example.test"})
    id = draft(editor, operation="update", original=remote, payload=form(title="Writer edit"))
    assert editor.commit(id, confirm=True)["status"] == "saved"
    updated = calendar_client.get_event(PRIMARY, remote["id"])
    assert updated["summary"] == "Writer edit" and updated["organizer"] == remote["organizer"]
