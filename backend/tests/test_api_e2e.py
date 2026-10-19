"""End-to-end flows through the HTTP API (no Google account needed)."""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest
from sqlalchemy import func, select

from taskradar.db.models import CalendarLink, Document, Message, Source, Task, TaskSource
from taskradar.db.session import transaction

pytestmark = pytest.mark.e2e


def add(api: Any, title: str, **fields: Any) -> dict[str, Any]:
    response = api.post("/api/tasks", json={"title": title, **fields})
    assert response.status_code == 201, response.text
    return dict(response.json())


def lane_titles(dashboard: dict[str, Any], lane: str) -> list[str]:
    return [t["title"] for t in dashboard["lanes"][lane]]


def test_web_ui_or_fallback_is_served(api: Any) -> None:
    response = api.get("/tasks/whatever")
    assert response.status_code == 200
    assert "TaskRadar" in response.text
    assert api.get("/api/unknown").status_code == 404


def test_removed_features_have_no_endpoints(api: Any) -> None:
    task = add(api, "Rent")
    for method, path in [
        ("get", "/api/sources"),
        ("post", "/api/documents/upload"),
        ("get", "/api/messages"),
        ("post", "/api/demo/mailbox"),
        ("get", "/api/suggestions"),
        ("get", "/api/review/recheck"),
        ("get", "/api/metrics"),
        ("put", "/api/settings/llm-key"),
        ("post", "/api/settings/llm/test"),
        ("post", f"/api/tasks/{task['id']}/merge"),
        ("post", "/api/integrations/google/gmail/connect"),
    ]:
        assert getattr(api, method)(path).status_code == 404, path


def test_a_todo_from_one_sentence_to_done(api: Any) -> None:
    parsed = api.post("/api/tasks/quick-parse", json={"text": "周五前交房租"}).json()
    assert (parsed["title"], parsed["due_date"]) == ("交房租", "2026-10-16")
    task = add(api, parsed["title"], due_date=parsed["due_date"], due_text=parsed["due_text"])
    assert (task["status"], task["manual"], task["source_kinds"]) == ("confirmed", True, ["manual"])

    dashboard = api.get("/api/dashboard").json()
    assert lane_titles(dashboard, "todo") == ["交房租"]
    assert [(t["title"], t["attention"]) for t in dashboard["attention"]] == [("交房租", "due_soon")]

    # Every status shows on the home page: the task moves from lane to lane.
    for status, lane in (("in_progress", "in_progress"), ("waiting_for_reply", "waiting_for_reply")):
        changed = api.post(f"/api/tasks/{task['id']}/status", json={"status": status}).json()
        assert changed["status"] == status and changed["undo_event_id"]
        dashboard = api.get("/api/dashboard").json()
        assert lane_titles(dashboard, lane) == ["交房租"] and dashboard["counts"][lane] == 1
        assert dashboard["attention"][0]["status"] == status  # still due soon, now with its status

    done = api.post(f"/api/tasks/{task['id']}/status", json={"status": "completed"}).json()
    dashboard = api.get("/api/dashboard").json()
    assert dashboard["counts"]["active"] == 0 and [t["title"] for t in dashboard["completed_recent"]] == ["交房租"]
    back = api.post(f"/api/events/{done['undo_event_id']}/undo").json()
    assert back["status"] == "waiting_for_reply"


def test_the_home_page_orders_by_time_and_groups_by_status(api: Any) -> None:
    today = dt.date(2026, 10, 14)
    late = add(api, "Late", due_date=(today - dt.timedelta(days=2)).isoformat())
    add(api, "Today", due_date=today.isoformat(), due_time="18:00")
    add(api, "Tomorrow", due_date=(today + dt.timedelta(days=1)).isoformat())
    add(api, "Next month", due_date="2026-11-20")
    add(api, "Some day")
    add(api, "Test only", due_date=today.isoformat(), sample=True)
    working = add(api, "Working on it")
    api.post(f"/api/tasks/{working['id']}/status", json={"status": "in_progress"})
    api.post(f"/api/tasks/{late['id']}/status", json={"status": "waiting_for_reply"})

    dashboard = api.get("/api/dashboard").json()
    assert [(t["title"], t["attention"]) for t in dashboard["attention"]] == [
        ("Late", "overdue"),
        ("Today", "due_today"),
        ("Tomorrow", "due_tomorrow"),
    ]
    assert lane_titles(dashboard, "todo") == ["Today", "Tomorrow", "Next month", "Some day"]
    assert lane_titles(dashboard, "in_progress") == ["Working on it"]
    assert lane_titles(dashboard, "waiting_for_reply") == ["Late"]
    counts = dashboard["counts"]
    assert (counts["overdue"], counts["due_today"], counts["due_tomorrow"], counts["active"]) == (1, 1, 1, 6)
    assert counts["sample_open"] == 1  # test data is never counted or shown here


def test_views_created_by_me_and_in_google_calendar(api: Any) -> None:
    mine = add(api, "Mine", due_date="2026-11-01")
    in_calendar = add(api, "In calendar", due_date="2026-11-02")
    with transaction(api.container.factory) as session:
        # A task an earlier version found in an imported mail.
        session.add(Task(id="imported-1", title="From a mail", status="confirmed", timezone="Europe/Berlin"))
        session.add(
            CalendarLink(
                task_id=in_calendar["id"], calendar_id="c", event_id="e", event_kind="all_day", status="synced"
            )
        )
        session.add(
            CalendarLink(task_id=mine["id"], calendar_id="c", event_id="r", event_kind="all_day", status="removed")
        )

    def titles(**params: Any) -> list[str]:
        return sorted(t["title"] for t in api.get("/api/tasks", params=params).json()["items"])

    assert titles() == ["From a mail", "In calendar", "Mine"]
    assert titles(manual=True) == ["In calendar", "Mine"]
    assert titles(manual=False) == ["From a mail"]
    assert titles(in_calendar=True) == ["In calendar"]  # an event the user removed does not count
    assert titles(in_calendar=True, status="completed") == []


def test_batch_changes_and_deleting_tasks(api: Any) -> None:
    a, b, c = (add(api, name)["id"] for name in ("A", "B", "C"))
    moved = api.post("/api/tasks/batch", json={"ids": [a, b], "action": "in_progress"}).json()
    assert moved["count"] == 2 and len(moved["undo_event_ids"]) == 2
    done = api.post("/api/tasks/batch", json={"ids": [a, b, b], "action": "complete"}).json()
    assert done["changed"] == [a, b]
    reopened = api.post("/api/tasks/batch", json={"ids": [a], "action": "todo"}).json()
    assert reopened["count"] == 1 and api.get(f"/api/tasks/{a}").json()["status"] == "confirmed"
    assert api.post("/api/tasks/batch", json={"ids": [a], "action": "restore"}).status_code == 422

    deleted = api.post("/api/tasks/batch", json={"ids": [a, c], "action": "delete"}).json()
    assert deleted == {"deleted": [a, c], "count": 2, "calendar_not_removed": []}
    assert [t["title"] for t in api.get("/api/tasks").json()["items"]] == ["B"]
    assert api.post("/api/tasks/batch", json={"ids": ["missing"], "action": "delete"}).status_code == 404
    assert api.delete(f"/api/tasks/{b}").json() == {"deleted": b}
    assert api.get("/api/tasks").json()["total"] == 0


def test_task_editing_and_validation(api: Any) -> None:
    created = add(api, "Arzttermin vereinbaren", category="personal")
    assert created["status"] == "confirmed" and created["manual"] is True and created["due_at"] is None
    updated = api.patch(f"/api/tasks/{created['id']}", json={"due_date": "2026-10-20", "due_time": "09:30"}).json()
    assert updated["due_at"] == "2026-10-20T09:30:00+02:00" and updated["due_precision"] == "datetime"
    assert "due" in updated["user_locked_fields"]
    bad = api.patch(f"/api/tasks/{created['id']}", json={"due_time": "25:99"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_time"
    cleared = api.patch(f"/api/tasks/{created['id']}", json={"clear_due": True}).json()
    assert cleared["due_at"] is None and cleared["due_precision"] == "none"
    assert api.get("/api/tasks/does-not-exist").status_code == 404
    assert api.post(f"/api/tasks/{created['id']}/status", json={"status": "nonsense"}).status_code == 422
    assert api.post("/api/tasks", json={"title": ""}).status_code == 422


def test_settings_roundtrip(api: Any) -> None:
    settings = api.get("/api/settings").json()
    assert settings["general"]["timezone"] == "Europe/Berlin" and settings["general"]["close_to_tray"] is True
    updated = api.put("/api/settings", json={"reminders": {"upcoming_days": 10}}).json()
    assert updated["reminders"]["upcoming_days"] == 10
    assert api.put("/api/settings", json={"general": {"timezone": "Mars/Base"}}).status_code == 422
    assert api.put("/api/settings", json={"nonsense": {}}).status_code == 422


def test_test_data_never_counts_reminds_or_reaches_the_calendar(api: Any) -> None:
    late = add(api, "测试：逾期", due_date="2026-10-10", sample=True)
    add(api, "Real", due_date="2026-10-20")
    assert [t["title"] for t in api.get("/api/tasks", params={"sample": True}).json()["items"]] == ["测试：逾期"]
    assert api.get("/api/dashboard").json()["counts"]["overdue"] == 0
    api.post("/api/notifications/scan")
    assert all(n["task_id"] != late["id"] for n in api.get("/api/notifications").json()["items"])
    refused = api.post(f"/api/tasks/{late['id']}/calendar", json={"confirm": True})
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "sample_task"


def test_marking_a_task_as_test_data_hides_its_reminders_and_can_be_undone(api: Any) -> None:
    task = add(api, "测试：整理报销单", due_date="2026-10-14")
    api.post("/api/notifications/scan")
    assert any(n["task_id"] == task["id"] for n in api.get("/api/notifications").json()["items"])

    marked = api.post(f"/api/tasks/{task['id']}/sample", json={"sample": True}).json()
    assert marked["sample"] is True and marked["undo_event_id"]
    assert all(n["task_id"] != task["id"] for n in api.get("/api/notifications").json()["items"])
    assert api.get("/api/dashboard").json()["counts"]["active"] == 0

    api.post(f"/api/events/{marked['undo_event_id']}/undo").raise_for_status()
    assert api.get(f"/api/tasks/{task['id']}").json()["sample"] is False
    assert api.get("/api/dashboard").json()["counts"]["active"] == 1


def test_imported_mails_and_files_can_be_deleted_while_their_tasks_stay(api: Any) -> None:
    c = api.container
    copies = c.config.files_dir / "uploads"
    copies.mkdir(parents=True)
    (copies / "notice.pdf").write_bytes(b"%PDF-1.7 synthetic")
    with transaction(c.factory) as session:
        source = Source(kind="gmail", name="Gmail", status="ok")
        session.add(source)
        session.flush()
        mail = Message(source_id=source.id, external_id="m1", subject="Semesterbeitrag", content_hash="h")
        session.add(mail)
        session.flush()
        doc = Document(
            source_id=source.id,
            message_id=mail.id,
            dedupe_key="d1",
            kind="pdf",
            original_name="notice.pdf",
            stored_path=str(copies / "notice.pdf"),
            sha256="0" * 64,
            mime_type="application/pdf",
        )
        session.add(doc)
        session.add(Task(id="from-mail", title="Semesterbeitrag zahlen", status="completed", timezone="Europe/Berlin"))
        session.flush()
        session.add(
            TaskSource(
                task_id="from-mail",
                message_id=mail.id,
                origin_key=f"message:{mail.id}",
                relation="origin",
                evidence=[{"quote": "Bitte zahlen Sie bis 30.10.", "kind": "deadline"}],
                source_label="Semesterbeitrag",
            )
        )
    assert api.get("/api/data/legacy").json() == {"messages": 1, "documents": 1, "credentials": []}
    detail = api.get("/api/tasks/from-mail").json()
    assert detail["source_kinds"] == ["gmail"] and detail["sources"][0]["message"]["subject"] == "Semesterbeitrag"

    deleted = api.post("/api/data/delete-imported", json={"confirm": True}).json()["deleted"]
    assert (deleted["messages"], deleted["documents"], deleted["sources"]) == (1, 1, 1)
    assert api.get("/api/data/legacy").json() == {"messages": 0, "documents": 0, "credentials": []}
    assert not c.config.files_dir.exists()  # TaskRadar's own copies
    detail = api.get("/api/tasks/from-mail").json()
    [source] = detail["sources"]
    assert source["message"] is None and source["label"] == "Semesterbeitrag"
    assert source["evidence"][0]["quote"] == "Bitte zahlen Sie bis 30.10."
    with transaction(c.factory) as session:
        assert session.scalar(select(func.count()).select_from(Message)) == 0
