"""End-to-end acceptance flow through the HTTP API (no real Google account needed)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from taskradar.container import Container

from .conftest import SAMPLES, requires_ocr

pytestmark = pytest.mark.e2e


def upload(api: Any, name: str) -> dict[str, Any]:
    data = (SAMPLES / name).read_bytes()
    mime = "application/pdf" if name.endswith(".pdf") else "image/png"
    response = api.post("/api/documents/upload", files=[("files", (name, data, mime))])
    assert response.status_code == 200, response.text
    return response.json()["results"][0]


def find(api: Any, needle: str) -> dict[str, Any]:
    items = api.get("/api/tasks").json()["items"]
    matches = [t for t in items if needle in t["title"]]
    assert matches, f"no task containing {needle!r}: {[t['title'] for t in items]}"
    return matches[0]


def test_web_ui_or_fallback_is_served(api: Any) -> None:
    response = api.get("/tasks/whatever")
    assert response.status_code == 200
    assert "TaskRadar" in response.text
    assert api.get("/api/unknown").status_code == 404


@requires_ocr
def test_acceptance_flow(api: Any, make_container: Callable[..., Container]) -> None:
    # 2-3. Chinese PDF with a deadline -> task with source evidence.
    first = upload(api, "01_zh_enrollment_certificate_notice.pdf")
    assert first["status"] == "processed" and first["tasks_created"] == 1
    zh_task = find(api, "在读证明")
    assert zh_task["due_at"] == "2026-11-20" and zh_task["due_precision"] == "date"
    assert zh_task["status"] == "candidate"
    detail = api.get(f"/api/tasks/{zh_task['id']}").json()
    source = detail["sources"][0]
    assert source["document"]["name"] == "01_zh_enrollment_certificate_notice.pdf"
    assert "2026年11月20日" in source["evidence"][0]["quote"] and source["evidence"][0]["page"] == 1
    assert api.get(f"/api/documents/{source['document']['id']}/file").headers["content-type"] == "application/pdf"

    # 4. German screenshot -> OCR -> deadline recognised.
    de = upload(api, "02_de_residence_permit_documents.png")
    assert de["tasks_created"] == 1
    de_task = find(api, "Aufenthaltstitel")
    assert de_task["due_at"] == "2026-11-27"
    assert api.get(f"/api/tasks/{de_task['id']}").json()["sources"][0]["document"]["extraction_method"] == "ocr"

    # 5. Reminders for the same tasks do not create duplicates (German and Chinese).
    reminder = upload(api, "03_de_residence_permit_reminder.png")
    assert reminder["tasks_created"] == 0 and reminder["duplicates_merged"] == 1
    zh_reminder = upload(api, "04_zh_enrollment_certificate_reminder.png")
    assert zh_reminder["tasks_created"] == 0 and zh_reminder["duplicates_merged"] == 1
    # Uploading the very same file again is recognised by its hash.
    assert upload(api, "01_zh_enrollment_certificate_notice.pdf")["status"] == "duplicate_file"
    assert len(api.get("/api/tasks").json()["items"]) == 2

    # 6. Confirmation moves the tasks into the active list.
    batch = api.post("/api/tasks/batch", json={"ids": [zh_task["id"], de_task["id"]], "action": "confirm"}).json()
    assert batch["count"] == 2
    confirmed = api.get("/api/tasks", params={"status": "confirmed"}).json()["items"]
    assert {t["id"] for t in confirmed} == {zh_task["id"], de_task["id"]}

    # 7. Completed tasks stop producing reminders.
    api.post(f"/api/tasks/{zh_task['id']}/status", json={"status": "completed"})
    api.container.clock.advance(days=45)  # 2026-11-28: both deadlines are now overdue
    api.post("/api/notifications/scan")
    notes = api.get("/api/notifications").json()["items"]
    assert [n["task_id"] for n in notes] == [de_task["id"]]
    assert notes[0]["level"] == "overdue"

    # 8. A failing Gmail sync keeps all data and reports a recoverable error.
    source = api.post("/api/demo/mailbox").json()
    api.put("/api/demo/failure-mode", json={"mode": "server_error"})
    job = api.post(f"/api/sources/{source['id']}/sync", params={"wait": True}).json()["job"]
    assert job["status"] == "failed" and job["recoverable"] is True
    assert job["error_code"] == "transient_error"
    assert len(api.get("/api/tasks").json()["items"]) == 2
    failures = api.get("/api/failures").json()
    assert failures["jobs"][0]["id"] == job["id"]
    sources = api.get("/api/sources").json()["items"]
    assert next(s for s in sources if s["id"] == source["id"])["status"] == "error"

    # 9. Without Calendar OAuth the user gets a clear prompt instead of a fake success.
    response = api.post(f"/api/tasks/{de_task['id']}/calendar", json={"confirm": True})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "calendar_not_connected"
    preview = api.get(f"/api/tasks/{de_task['id']}/calendar/preview").json()
    assert preview["connected"] is False and preview["event"]["start"] == {"date": "2026-11-27"}

    # Dashboard, metrics and export reflect the real state.
    dashboard = api.get("/api/dashboard").json()
    assert dashboard["counts"]["overdue"] == 1
    metrics = api.get("/api/metrics").json()
    assert metrics["documents"]["total"] == 4  # the identical re-upload created no new document
    assert metrics["dedup"]["duplicates_merged"] >= 2
    export = api.get("/api/data/export")
    assert "attachment" in export.headers["content-disposition"]
    assert len(export.json()["tasks"]) == 2

    # Restart: a fresh container on the same data folder sees the same state.
    restarted = make_container()
    from taskradar.db.models import Task
    from taskradar.db.session import transaction

    with transaction(restarted.factory) as session:
        statuses = sorted(t.status for t in session.query(Task).all())
    assert statuses == ["completed", "confirmed"]


def test_demo_mailbox_flow_and_undo(api: Any) -> None:
    source = api.post("/api/demo/mailbox").json()
    job = api.post(f"/api/sources/{source['id']}/sync", params={"wait": True}).json()["job"]
    assert job["status"] == "succeeded", job
    fee = find(api, "Semesterbeitrag")
    assert fee["source_count"] == 2  # request + reminder merged
    api.post(f"/api/tasks/{fee['id']}/status", json={"status": "confirmed"})
    # The follow-up "payment received" mail completes the confirmed task automatically ...
    api.post("/api/demo/advance")
    api.post(f"/api/sources/{source['id']}/sync", params={"wait": True})
    detail = api.get(f"/api/tasks/{fee['id']}").json()
    assert detail["status"] == "completed"
    auto = next(e for e in detail["events"] if e["actor"] == "agent" and e["type"] == "status_changed")
    assert auto["revertible"]
    # ... and the user can undo it.
    undone = api.post(f"/api/events/{auto['id']}/undo").json()
    assert undone["status"] == "confirmed"
    # Suggestions endpoint and inbox data are consistent.
    assert api.get("/api/suggestions").status_code == 200
    candidates = api.get("/api/tasks", params={"status": "candidate"}).json()["items"]
    assert any(t["needs_review"] for t in candidates)  # e.g. the ambiguous "nächsten Freitag"


def test_task_editing_validation_and_manual_tasks(api: Any) -> None:
    created = api.post("/api/tasks", json={"title": "Arzttermin vereinbaren", "category": "personal"}).json()
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


def test_settings_roundtrip(api: Any) -> None:
    settings = api.get("/api/settings").json()
    assert settings["general"]["timezone"] == "Europe/Berlin"
    assert settings["llm"]["provider"] == "none"
    updated = api.put("/api/settings", json={"reminders": {"upcoming_days": 10}, "llm": {"cloud_consent": True}}).json()
    assert updated["reminders"]["upcoming_days"] == 10
    assert updated["llm"]["consent_at"]
    assert api.put("/api/settings", json={"general": {"timezone": "Mars/Base"}}).status_code == 422
    assert api.put("/api/settings", json={"nonsense": {}}).status_code == 422
