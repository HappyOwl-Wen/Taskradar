"""Moving several tasks to another day at once, when plans change."""

from __future__ import annotations

from typing import Any

import pytest

from taskradar.db.models import CalendarLink
from taskradar.db.session import transaction

pytestmark = pytest.mark.e2e


def add(api: Any, title: str, **fields: Any) -> dict[str, Any]:
    response = api.post("/api/tasks", json={"title": title, **fields})
    assert response.status_code == 201, response.text
    return dict(response.json())


def reschedule(api: Any, ids: list[str], due_date: str) -> dict[str, Any]:
    response = api.post("/api/tasks/batch/reschedule", json={"ids": ids, "due_date": due_date})
    assert response.status_code == 200, response.text
    return dict(response.json())


def task(api: Any, task_id: str) -> dict[str, Any]:
    return dict(api.get(f"/api/tasks/{task_id}").json())


def test_open_tasks_move_to_one_day_and_keep_their_time(api: Any) -> None:
    undated = add(api, "Bücher zurückgeben")
    dentist = add(api, "Zahnarzt", due_date="2026-10-14", due_time="14:30")
    rent = add(api, "Miete überweisen", due_date="2026-10-15")
    done = add(api, "Formular abgeben", due_date="2026-10-13")
    api.post(f"/api/tasks/{done['id']}/status", json={"status": "completed"})

    ids = [undated["id"], dentist["id"], rent["id"], done["id"], dentist["id"]]
    moved = reschedule(api, ids, "2026-10-15")
    assert moved["changed"] == [undated["id"], dentist["id"]]  # the rent was already due that day
    assert (moved["count"], moved["due_date"], len(moved["undo_event_ids"])) == (2, "2026-10-15", 2)
    assert moved["skipped"] == [{"id": done["id"], "title": "Formular abgeben", "reason": "closed"}]
    assert moved["calendar_outdated"] == []

    detail = task(api, dentist["id"])
    assert (detail["due_date"], detail["due_at"]) == ("2026-10-15", "2026-10-15T14:30:00+02:00")
    assert "due" in detail["user_locked_fields"]  # the user's own date, like an edit
    assert detail["events"][0]["summary"] == "批量改期：2026-10-14 14:30 → 2026-10-15 14:30"
    assert detail["events"][0]["revertible"] is True
    assert task(api, undated["id"])["due_precision"] == "date"
    assert task(api, undated["id"])["events"][0]["summary"] == "批量改期：无截止日期 → 2026-10-15"
    assert task(api, done["id"])["due_date"] == "2026-10-13"

    dashboard = api.get("/api/dashboard").json()
    tomorrow = sorted(t["title"] for t in dashboard["attention"] if t["attention"] == "due_tomorrow")
    assert tomorrow == ["Bücher zurückgeben", "Miete überweisen", "Zahnarzt"]

    # "Undo" in the toast reverts newest first: every task gets its own date back.
    for event_id in reversed(moved["undo_event_ids"]):
        api.post(f"/api/events/{event_id}/undo").raise_for_status()
    assert task(api, dentist["id"])["due_at"] == "2026-10-14T14:30:00+02:00"
    assert task(api, undated["id"])["due_date"] is None


def test_next_week_works_for_every_open_status(api: Any) -> None:
    ids = [add(api, title, due_date="2026-10-14")["id"] for title in ("A", "B", "C", "D")]
    api.post("/api/tasks/batch", json={"ids": ids[1:2], "action": "in_progress"}).raise_for_status()
    api.post("/api/tasks/batch", json={"ids": ids[2:3], "action": "waiting_for_reply"}).raise_for_status()
    api.post("/api/tasks/batch", json={"ids": ids[3:], "action": "dismiss"}).raise_for_status()

    moved = reschedule(api, ids, "2026-10-19")
    assert moved["changed"] == ids[:3]
    assert [s["reason"] for s in moved["skipped"]] == ["closed"]
    assert [task(api, i)["status"] for i in ids[:3]] == ["confirmed", "in_progress", "waiting_for_reply"]


def test_a_time_the_clocks_skip_or_repeat_is_left_to_the_user(api: Any) -> None:
    night = add(api, "Nachtzug", due_date="2026-10-20", due_time="02:30")
    plain = add(api, "Einkaufen", due_date="2026-10-20")
    # In Berlin, 02:30 happens twice on 2026-10-25 (clocks go back) and never on 2027-03-28 (clocks go forward).
    twice = reschedule(api, [night["id"], plain["id"]], "2026-10-25")
    assert twice["changed"] == [plain["id"]]
    assert twice["skipped"] == [{"id": night["id"], "title": "Nachtzug", "reason": "ambiguous_time"}]
    gap = reschedule(api, [night["id"]], "2027-03-28")
    assert gap["count"] == 0 and gap["skipped"][0]["reason"] == "nonexistent_time"
    assert task(api, night["id"])["due_at"] == "2026-10-20T02:30:00+02:00"


def test_a_task_in_google_calendar_is_marked_for_an_update(api: Any) -> None:
    exam = add(api, "Klausuranmeldung", due_date="2026-10-16")
    with transaction(api.container.factory) as session:
        session.add(
            CalendarLink(task_id=exam["id"], calendar_id="c", event_id="e", event_kind="all_day", status="synced")
        )
    moved = reschedule(api, [exam["id"]], "2026-10-19")
    assert moved["calendar_outdated"] == [exam["id"]]
    assert task(api, exam["id"])["calendar_status"] == "out_of_sync"


def test_nothing_changes_when_the_request_is_wrong(api: Any) -> None:
    rent = add(api, "Miete", due_date="2026-10-16")
    url = "/api/tasks/batch/reschedule"
    missing = api.post(url, json={"ids": [rent["id"], "does-not-exist"], "due_date": "2026-10-20"})
    assert missing.status_code == 404
    assert task(api, rent["id"])["due_date"] == "2026-10-16"  # validated before anything was saved
    assert api.post(url, json={"ids": [], "due_date": "2026-10-20"}).status_code == 422
    assert api.post(url, json={"ids": [rent["id"]], "due_date": "2026-02-30"}).status_code == 422
    assert api.post(url, json={"ids": [rent["id"]]}).status_code == 422
