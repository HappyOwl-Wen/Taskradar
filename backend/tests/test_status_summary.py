"""The status summary turns runtime problems into a few plain items (no logs needed)."""

from __future__ import annotations

import sys
from typing import Any

from taskradar.db.models import CalendarLink, SyncJob
from taskradar.db.session import transaction
from taskradar.security import secrets as sk


def _codes(summary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["code"]: item for item in summary["items"]}


def _link(api: Any, title: str, status: str) -> str:
    task = api.post("/api/tasks", json={"title": title, "due_date": "2026-11-02"}).json()
    with transaction(api.container.factory) as session:
        session.add(
            CalendarLink(task_id=task["id"], calendar_id="cal", event_id=title, event_kind="all_day", status=status)
        )
    return str(task["id"])


def test_nothing_to_report_without_problems(api: Any) -> None:
    if sys.platform == "win32":  # banners need TaskRadar in the Start menu (the test app's own one)
        api.post("/api/system/start-menu", json={"enabled": True, "confirm": True})
    summary = api.get("/api/system/summary").json()
    # The test app runs without the background scheduler, which the summary does report.
    assert set(_codes(summary)) == {"scheduler_off"}
    assert summary["overall"] == "attention"


def test_calendar_problems_are_named_with_a_way_to_fix_them(api: Any) -> None:
    api.container.secrets.set(sk.GOOGLE_TOKEN_CALENDAR, '{"token": "fake"}')
    _link(api, "Visa appointment", "failed")
    _link(api, "Rent", "out_of_sync")
    done = _link(api, "Old", "failed")
    api.post(f"/api/tasks/{done}/status", json={"status": "completed"})  # finished tasks do not count
    items = _codes(api.get("/api/system/summary").json())
    assert (items["calendar_failed"]["params"], items["calendar_failed"]["action"]) == ({"count": 1}, "tasks")
    assert items["calendar_out_of_sync"]["level"] == "info"
    assert "calendar_disconnected" not in items

    # Signed out of Google while tasks are in the calendar: their changes can no longer reach it.
    api.container.secrets.delete(sk.GOOGLE_TOKEN_CALENDAR)
    item = _codes(api.get("/api/system/summary").json())["calendar_disconnected"]
    assert (item["level"], item["params"], item["action"]) == ("warning", {"count": 2}, "calendar")


def test_failing_reminders_are_reported(api: Any) -> None:
    with transaction(api.container.factory) as session:
        session.add(
            SyncJob(
                kind="reminder_scan",
                trigger="scheduled",
                lock_key="reminders",
                status="failed",
                error_code="database_locked",
            )
        )
    item = _codes(api.get("/api/system/summary").json())["reminders_failing"]
    assert item["params"] == {"error": "database_locked"} and item["level"] == "warning"
