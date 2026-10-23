"""Overlap warnings and reserved buffers, against isolated SQLite + Fake Calendar only."""

from __future__ import annotations

import datetime as dt
import json
import uuid
from typing import Any

from sqlalchemy import select

from taskradar.connectors.google_oauth import ACCESS_SCOPES
from taskradar.db.calendar_models import CalendarBuffer
from taskradar.db.models import Setting
from taskradar.db.session import transaction
from taskradar.domain.calendar import EventForm
from taskradar.security import secrets as sk
from taskradar.services.calendar_editor import CalendarEditor

START, END = dt.date(2026, 10, 1), dt.date(2026, 11, 1)
PRIMARY, OWN, TEAM = "user@example.test", "taskradar@example.test", "team@example.test"
VIEW = "/api/calendar/view?start=2026-10-01&end=2026-11-01"


def times(start: str, end: str, day: str = "2026-10-22", **extra: Any) -> dict[str, Any]:
    return {"start": f"{day}T{start}", "end": f"{day}T{end}", "timezone": "Europe/Berlin", **extra}


def block(api, start, end, title="Write report", day="2026-10-22", **extra):
    response = api.post("/api/calendar/work-blocks", json={"title": title, **times(start, end, day), **extra})
    assert response.status_code == 201, response.text
    return response.json()


def check(api, start, end, day="2026-10-22", **extra):
    response = api.post("/api/calendar/conflicts", json=times(start, end, day, **extra))
    assert response.status_code == 200, response.text
    return response.json()


def items(api):
    return {item["id"]: item for item in api.get(VIEW).json()["items"]}


def connect(c, client):
    c.secrets.set(sk.GOOGLE_TOKEN_CALENDAR, json.dumps({"token": "fake", "scopes": ACCESS_SCOPES["edit"]}))
    client.calendars.update(
        {
            PRIMARY: {"summary": "Personal", "primary": True, "timeZone": "Europe/Berlin", "accessRole": "owner"},
            OWN: {"summary": "TaskRadar", "timeZone": "Europe/Berlin", "accessRole": "owner"},
            TEAM: {"summary": "Team", "timeZone": "Europe/Berlin", "accessRole": "reader"},
        }
    )
    with transaction(c.factory) as session:
        session.add(Setting(key="calendar_state", value={"calendar_id": OWN}))
    c.workspace.refresh()
    c.workspace.select_sources([PRIMARY, OWN, TEAM], PRIMARY, True)
    c.workspace.refresh(START, END)


def google(client, id, start, end, calendar=PRIMARY, day="2026-10-22", **extra):
    body = EventForm(title=extra.pop("summary", id), **times(start, end, day)).google_body()
    return client.insert_event(calendar, {**body, **extra, "id": id})


def test_local_overlap_back_to_back_and_the_edited_item_itself(api):
    work = block(api, "10:00", "11:00")
    found = check(api, "10:30", "11:30")
    assert [(x["id"], x["kind"], x["type"], x["minutes"]) for x in found["conflicts"]] == [
        (work["id"], "work", "overlap", 30)
    ]
    assert found["unchecked"] == []
    # The next free hour starts when the block ends (11:00 in Berlin).
    assert found["suggestion"] == {"start": "2026-10-22T09:00:00+00:00", "end": "2026-10-22T10:00:00+00:00"}
    assert check(api, "11:00", "12:00")["conflicts"] == []
    assert check(api, "10:15", "10:45", exclude=[work["id"]])["conflicts"] == []
    # A warning never blocks saving.
    block(api, "10:30", "11:30", title="Overlapping on purpose")


def test_buffers_widen_items_and_name_the_reserved_time(api):
    block(api, "10:00", "11:00", buffer={"after_minutes": 15, "after_kind": "rest"})
    [found] = check(api, "11:00", "12:00")["conflicts"]
    assert (found["type"], found["minutes"], found["buffer"]) == (
        "buffer",
        15,
        {"owner": "other", "side": "after", "kind": "rest"},
    )
    [found] = check(api, "11:30", "12:00", buffer={"before_minutes": 45, "before_kind": "commute"})["conflicts"]
    assert (found["minutes"], found["buffer"]) == (15, {"owner": "self", "side": "before", "kind": "commute"})
    # Only the two reserved times meet: rest after the block, preparation before the new item.
    [found] = check(api, "11:25", "12:00", buffer={"before_minutes": 15})["conflicts"]
    assert (found["minutes"], found["buffer"]) == (5, {"owner": "both", "side": "before", "kind": "prep"})
    assert check(api, "11:15", "12:00")["conflicts"] == []


def test_next_free_slot_respects_buffers_and_stays_on_the_same_day(api):
    block(api, "10:00", "11:00", buffer={"after_minutes": 10})
    block(api, "11:30", "12:00", title="Seminar")
    # 11:10 would run into the seminar, so the next free half hour is 12:00-12:30 in Berlin.
    assert check(api, "10:30", "11:00")["suggestion"] == {
        "start": "2026-10-22T10:00:00+00:00",
        "end": "2026-10-22T10:30:00+00:00",
    }
    # Its own preparation has to fit as well: 12:00 + 13 minutes, rounded up to whole five minutes.
    later = check(api, "10:30", "11:00", buffer={"before_minutes": 13})["suggestion"]
    assert later["start"] == "2026-10-22T10:15:00+00:00"
    block(api, "23:00", "23:45", title="Late call")
    found = check(api, "23:15", "23:45")
    assert found["conflicts"] and found["suggestion"] is None


def test_google_events_count_unless_free_declined_all_day_or_not_loaded(api, calendar_client):
    c = api.container
    connect(c, calendar_client)
    google(calendar_client, "review", "10:00", "11:00", summary="Design review")
    google(calendar_client, "free", "10:00", "11:00", transparency="transparent")
    declined = [{"email": "me@example.test", "self": True, "responseStatus": "declined"}]
    google(calendar_client, "declined", "10:00", "11:00", attendees=declined)
    google(calendar_client, "weekly", "10:30", "11:30", calendar=TEAM, recurringEventId="series")
    trip = {"id": "trip", "summary": "Trip", "start": {"date": "2026-10-22"}, "end": {"date": "2026-10-23"}}
    calendar_client.insert_event(PRIMARY, trip)
    c.workspace.refresh(START, END)
    found = check(api, "10:45", "11:15")
    assert [(x["id"], x["type"], x["minutes"], x["source_name"]) for x in found["conflicts"]] == [
        (f"google:{PRIMARY}:review", "overlap", 15, "Personal"),
        (f"google:{TEAM}:weekly", "overlap", 30, "Team"),
    ]
    assert found["unchecked"] == []
    # December was never opened: nothing is cached, so the answer is "not checked" rather than "free".
    far = check(api, "10:00", "11:00", day="2026-12-10")
    assert far["conflicts"] == [] and far["unchecked"] == ["Personal", "TaskRadar", "Team"]
    # A hidden calendar is neither checked nor reported.
    c.workspace.select_sources([PRIMARY], PRIMARY, True)
    assert [x["id"] for x in check(api, "10:45", "11:15")["conflicts"]] == [f"google:{PRIMARY}:review"]


def test_linked_blocks_task_mirrors_and_appointments_are_counted_once(api, calendar_client):
    c = api.container
    connect(c, calendar_client)
    work = block(api, "10:00", "11:00")
    editor = CalendarEditor(c.workspace)
    publish = str(uuid.uuid4())
    payload = {"title": "Write report", **times("10:00", "11:00")}
    editor.save_draft(
        publish,
        {"operation": "create", "calendar_id": PRIMARY, "work_block_id": work["work_block_id"], "payload": payload},
    )
    editor.commit(publish, confirm=True)
    c.workspace.refresh(START, END)
    assert [x["id"] for x in check(api, "10:30", "11:30")["conflicts"]] == [work["id"]]
    # Editing the published block leaves out its Google copy as well.
    assert check(api, "10:30", "11:30", exclude=[work["id"]])["conflicts"] == []

    appointment = {"due_date": "2026-10-22", "due_time": "14:00", "time_semantics": "appointment"}
    dentist = api.post("/api/tasks", json={"title": "Dentist", **appointment}).json()
    c.calendar.sync(dentist["id"], user_confirmed=True)
    api.post("/api/tasks", json={"title": "Submit form", "due_date": "2026-10-22", "due_time": "16:00"})
    done = api.post("/api/tasks", json={"title": "Old appointment", **appointment, "due_time": "15:00"}).json()
    assert api.post(f"/api/tasks/{done['id']}/status", json={"status": "completed"}).status_code == 200
    c.workspace.refresh(START, END)
    # The appointment lasts an assumed hour; its Google copy is the same commitment, not a second one.
    found = check(api, "14:30", "16:30")["conflicts"]
    assert [(x["id"], x["kind"], x["minutes"]) for x in found] == [(f"task:{dentist['id']}", "appointment", 30)]


def test_series_and_occurrence_buffers_on_a_read_only_meeting(api, calendar_client):
    c = api.container
    connect(c, calendar_client)
    for day in ("2026-10-22", "2026-10-29"):
        weekly = {"calendar": TEAM, "day": day, "summary": "Team meeting", "recurringEventId": "weekly"}
        google(calendar_client, f"weekly_{day[-2:]}", "14:00", "15:00", **weekly)
    google(calendar_client, "review", "10:00", "11:00")
    c.workspace.refresh(START, END)
    series = {"calendar_id": TEAM, "event_id": "weekly_22", "series": True}
    reserved = {"before_minutes": 10, "before_kind": "prep", "after_minutes": 30, "after_kind": "commute"}
    response = api.put("/api/calendar/buffers", json={**series, **reserved})
    assert response.status_code == 200, response.text
    assert response.json()["buffer"] == {**reserved, "series": True}
    assert items(api)[f"google:{TEAM}:weekly_29"]["buffer"] == {**reserved, "series": True}
    [found] = check(api, "15:10", "16:00")["conflicts"]
    assert (found["minutes"], found["buffer"]) == (20, {"owner": "other", "side": "after", "kind": "commute"})
    # One occurrence drops the series buffer; the other keeps it.
    api.put("/api/calendar/buffers", json={"calendar_id": TEAM, "event_id": "weekly_22"})
    view = items(api)
    assert view[f"google:{TEAM}:weekly_22"]["buffer"] is None
    assert view[f"google:{TEAM}:weekly_29"]["buffer"]["after_minutes"] == 30
    assert check(api, "15:10", "16:00")["conflicts"] == []
    # Choosing the series again from that occurrence makes it follow the series.
    api.put("/api/calendar/buffers", json={**series, "before_minutes": 5})
    view = items(api)
    assert view[f"google:{TEAM}:weekly_22"]["buffer"]["before_minutes"] == 5
    assert view[f"google:{TEAM}:weekly_29"]["buffer"]["before_minutes"] == 5

    def refused(**body):
        response = api.put("/api/calendar/buffers", json={"before_minutes": 5, **body})
        return response.status_code, response.json()["error"]["code"]

    assert refused(calendar_id=PRIMARY, event_id="review", series=True) == (422, "not_recurring")
    assert refused(calendar_id=PRIMARY, event_id="missing") == (404, "not_found")
    assert refused(calendar_id="unknown@example.test", event_id="review") == (409, "calendar_not_selected")
    assert refused() == (422, "validation_error")
    assert refused(calendar_id=PRIMARY, event_id="review", before_minutes=241) == (422, "validation_error")


def test_buffers_are_saved_with_blocks_and_drafts_but_never_sent_to_google(api, calendar_client):
    c = api.container
    connect(c, calendar_client)
    commute = {"before_minutes": 15, "before_kind": "commute", "after_minutes": 0, "after_kind": "rest"}
    work = block(api, "10:00", "11:00", buffer=commute)
    assert items(api)[work["id"]]["buffer"] == {**commute, "series": False}
    # Saving without buffers keeps them, zero minutes remove them, deleting the block removes them.
    url = f"/api/calendar/work-blocks/{work['work_block_id']}"
    moved = api.put(url, json={"title": "Write report", **times("10:30", "11:30"), "revision": work["revision"]})
    assert items(api)[work["id"]]["buffer"]["before_minutes"] == 15
    cleared = {"title": "Write report", **times("10:30", "11:30"), "buffer": {}, "revision": moved.json()["revision"]}
    assert api.put(url, json=cleared).status_code == 200
    assert items(api)[work["id"]]["buffer"] is None
    api.put("/api/calendar/buffers", json={"work_block_id": work["work_block_id"], **commute})
    api.delete(url)
    with transaction(c.factory) as session:
        assert session.get(CalendarBuffer, work["id"]) is None

    editor = CalendarEditor(c.workspace)
    create = str(uuid.uuid4())
    travel = {"before_minutes": 30, "before_kind": "commute", "after_minutes": 30, "after_kind": "commute"}
    payload = {"title": "Visit", **times("16:00", "17:00"), "buffer": travel}
    editor.save_draft(create, {"operation": "create", "calendar_id": PRIMARY, "payload": payload})
    event_id = editor.commit(create, confirm=True)["result"]["id"]
    sent = calendar_client.events[(PRIMARY, event_id)]
    assert "buffer" not in json.dumps(sent)
    assert sent["extendedProperties"] == {"private": {"taskradar_operation": create}}
    assert items(api)[f"google:{PRIMARY}:{event_id}"]["buffer"] == {**travel, "series": False}
    remove = str(uuid.uuid4())
    editor.save_draft(remove, {"operation": "delete", "calendar_id": PRIMARY, "event_id": event_id, "base_event": sent})
    editor.commit(remove, confirm=True)
    with transaction(c.factory) as session:
        assert session.scalar(select(CalendarBuffer)) is None


def test_export_and_delete_all_include_buffers(api):
    work = block(api, "10:00", "11:00", buffer={"after_minutes": 10})
    assert [row["item_key"] for row in api.container.data.export()["calendar_buffers"]] == [work["id"]]
    api.container.data.delete_all()
    with transaction(api.container.factory) as session:
        assert session.scalar(select(CalendarBuffer)) is None


def test_invalid_times_daylight_saving_folds_and_all_day(api):
    block(api, "02:00", "02:45", title="Night shift", day="2026-10-25", start_fold=0, end_fold=0)
    # 02:30 happens twice on 25 October in Berlin; only the first time meets the block.
    first = check(api, "02:30", "02:50", day="2026-10-25", start_fold=0, end_fold=0)
    assert [x["minutes"] for x in first["conflicts"]] == [15]
    assert check(api, "02:30", "02:50", day="2026-10-25", start_fold=1, end_fold=1)["conflicts"] == []

    def refused(body):
        response = api.post("/api/calendar/conflicts", json=body)
        return response.status_code, response.json()["error"]["code"]

    assert refused(times("02:30", "02:50", "2026-10-25")) == (422, "invalid_event_time")
    assert refused(times("02:30", "03:30", "2026-03-29")) == (422, "invalid_event_time")
    assert refused(times("11:00", "10:00")) == (422, "invalid_event_time")
    assert refused(times("10:00", "11:00", timezone="Mars/Olympus")) == (422, "invalid_event_time")
    whole_day = {"start": "2026-10-22", "end": "2026-10-23", "all_day": True}
    assert api.post("/api/calendar/conflicts", json=whole_day).json() == {
        "conflicts": [],
        "unchecked": [],
        "suggestion": None,
    }
