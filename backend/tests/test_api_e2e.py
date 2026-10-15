"""End-to-end acceptance flow through the HTTP API (no real Google account needed)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from taskradar.container import Container
from taskradar.domain.enums import TimeSemantics
from taskradar.extraction.rules import RuleBasedExtractor

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
    # The letter is dated (12 Oct) but carries no time of day; the API says so explicitly.
    assert source["source_day"] == "2026-10-12" and detail["source_published_day"] == "2026-10-12"
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


def test_merged_duplicates_are_not_counted_as_rejected(api: Any) -> None:
    source = api.post("/api/demo/mailbox").json()
    assert api.post(f"/api/sources/{source['id']}/sync", params={"wait": True}).json()["job"]["status"] == "succeeded"
    first, second, third = api.get("/api/tasks", params={"sort": "created_at"}).json()["items"][:3]
    api.post(f"/api/tasks/{first['id']}/status", json={"status": "confirmed"})
    merged = api.post(f"/api/tasks/{second['id']}/merge", json={"into_task_id": first["id"], "due_choice": "existing"})
    assert merged.status_code == 200, merged.text
    api.post(f"/api/tasks/{third['id']}/status", json={"status": "dismissed"})

    feedback = api.get("/api/metrics").json()["feedback"]
    assert feedback["by_status"]["dismissed"] == 2  # the raw status of both
    assert (feedback["dismissed"], feedback["merged_into_other"], feedback["accepted"]) == (1, 1, 1)
    assert feedback["precision_proxy"] == 0.5  # 1 confirmed / (1 confirmed + 1 really dismissed)

    # Undoing the merge brings the task back and it no longer counts as merged.
    detail = api.get(f"/api/tasks/{first['id']}").json()
    merge_event = next(e for e in detail["events"] if e["type"] == "merged")
    api.post(f"/api/events/{merge_event['id']}/undo")
    feedback = api.get("/api/metrics").json()["feedback"]
    assert (feedback["dismissed"], feedback["merged_into_other"]) == (1, 0)


def test_reanalysis_fills_a_deadline_the_first_run_missed(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    eml = (
        "From: Billing <billing@shop.example>\r\nTo: me@example.com\r\nSubject: Payment reminder\r\n"
        "Message-ID: <bill-7781@shop.example>\r\nDate: Wed, 14 Oct 2026 08:00:00 +0000\r\n"
        "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
        "Invoice 7781\r\nDue date: 10/28/2026\r\nPayment status: 未支付\r\n\r\n"
        "Please pay the outstanding amount soon.\r\n"
    ).encode()
    # The previous rule engine only looked for deadline lines *after* the instruction.
    monkeypatch.setattr(
        RuleBasedExtractor, "_context_date", staticmethod(lambda *_: (None, None, TimeSemantics.DEADLINE))
    )
    imported = api.post("/api/documents/upload", files=[("files", ("bill.eml", eml, "message/rfc822"))]).json()
    message_id = imported["results"][0]["message_id"]
    task = find(api, "Pay")
    assert task["due_date"] is None
    monkeypatch.undo()

    api.post(f"/api/messages/{message_id}/reprocess")
    detail = api.get(f"/api/tasks/{task['id']}").json()
    assert detail["due_date"] == "2026-10-28"
    filled = next(e for e in detail["events"] if e["type"] == "fields_updated")
    assert filled["actor"] == "agent" and filled["revertible"]
    [source] = detail["sources"]
    assert [e["kind"] for e in source["evidence"]] == ["action", "deadline"]  # where the date comes from
    assert "Due date: 10/28/2026" in source["evidence"][1]["quote"]
    assert len(api.get("/api/tasks").json()["items"]) == 1  # re-analysis never duplicates the task

    # Re-analysing again changes nothing, and a date the user set is never overridden.
    api.post(f"/api/messages/{message_id}/reprocess")
    assert len(api.get(f"/api/tasks/{task['id']}").json()["sources"][0]["evidence"]) == 2
    api.patch(f"/api/tasks/{task['id']}", json={"due_date": "2026-10-30"})
    api.post(f"/api/messages/{message_id}/reprocess")
    after = api.get(f"/api/tasks/{task['id']}").json()
    assert after["due_date"] == "2026-10-30"
    assert [e["kind"] for e in after["sources"][0]["evidence"]] == ["action", "deadline"]


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


def test_merging_different_deadlines_needs_an_explicit_choice(api: Any) -> None:
    kept = api.post("/api/tasks", json={"title": "Miete November", "due_date": "2026-11-01"}).json()
    dup = api.post(
        "/api/tasks", json={"title": "Miete November überweisen", "due_date": "2026-11-03", "due_time": "12:00"}
    ).json()

    refused = api.post(f"/api/tasks/{dup['id']}/merge", json={"into_task_id": kept["id"]})
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "due_choice_required"
    assert api.get(f"/api/tasks/{dup['id']}").json()["status"] == "confirmed"  # nothing happened

    merged = api.post(f"/api/tasks/{dup['id']}/merge", json={"into_task_id": kept["id"], "due_choice": "new"}).json()
    assert (merged["id"], merged["due_date"], merged["due_time"]) == (kept["id"], "2026-11-03", "12:00")
    assert "due" in merged["user_locked_fields"]
    assert api.get(f"/api/tasks/{dup['id']}").json()["status"] == "dismissed"

    # Undoing the merge restores both tasks, including the kept task's own deadline.
    event = next(e for e in merged["events"] if e["type"] == "merged")
    restored = api.post(f"/api/events/{event['id']}/undo").json()
    assert (restored["due_date"], restored["due_time"]) == ("2026-11-01", None)
    assert api.get(f"/api/tasks/{dup['id']}").json()["status"] == "confirmed"

    # Keeping the existing date is just as explicit.
    kept_date = api.post(f"/api/tasks/{dup['id']}/merge", json={"into_task_id": kept["id"], "due_choice": "existing"})
    assert kept_date.json()["due_date"] == "2026-11-01"


def test_same_deadline_merges_without_a_question(api: Any) -> None:
    kept = api.post("/api/tasks", json={"title": "Exam registration", "due_date": "2026-11-20"}).json()
    dup = api.post("/api/tasks", json={"title": "Register for the exam", "due_date": "2026-11-20"}).json()
    undated = api.post("/api/tasks", json={"title": "Exam registration (no date)"}).json()
    assert api.post(f"/api/tasks/{dup['id']}/merge", json={"into_task_id": kept["id"]}).status_code == 200
    assert api.post(f"/api/tasks/{undated['id']}/merge", json={"into_task_id": kept["id"]}).status_code == 200


def test_accepting_a_duplicate_suggestion_with_another_deadline_needs_a_choice(api: Any) -> None:
    from taskradar.db.session import transaction
    from taskradar.domain.enums import SuggestionKind

    existing = api.post("/api/tasks", json={"title": "Rückmeldung bezahlen", "due_date": "2026-11-15"}).json()
    new = api.post("/api/tasks", json={"title": "Semesterbeitrag zahlen", "due_date": "2026-11-20"}).json()
    c = api.container
    with transaction(c.factory) as session:
        suggestion = c.tasks.suggest(
            session,
            c.tasks.get(session, new["id"]),
            kind=SuggestionKind.POSSIBLE_DUPLICATE,
            payload={"other_task_id": existing["id"], "other_title": existing["title"], "score": 0.7},
            evidence=[],
            confidence=0.7,
            reason="conflicting_deadline_needs_review",
            dedupe_key=f"{new['id']}:possible_duplicate:{existing['id']}",
            related_task_id=existing["id"],
            summary="test",
        )
        assert suggestion is not None
        suggestion_id = suggestion.id

    refused = api.post(f"/api/suggestions/{suggestion_id}/accept")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "due_choice_required"
    assert [s["id"] for s in api.get("/api/suggestions").json()["items"]] == [suggestion_id]  # still pending

    merged = api.post(f"/api/suggestions/{suggestion_id}/accept", json={"due_choice": "new"}).json()
    assert (merged["id"], merged["due_date"]) == (existing["id"], "2026-11-20")
    assert api.get("/api/suggestions").json()["items"] == []


def test_dashboard_never_hides_unconfirmed_tasks_due_soon(api: Any) -> None:
    # FIXED_NOW is Wednesday 14 October 2026.
    soon = api.post("/api/tasks", json={"title": "Antrag einreichen", "due_date": "2026-10-15"}).json()
    api.post(f"/api/tasks/{soon['id']}/status", json={"status": "candidate"})  # not confirmed yet
    confirmed = api.post("/api/tasks", json={"title": "Miete überweisen", "due_date": "2026-10-16"}).json()
    late = api.post("/api/tasks", json={"title": "Bücher zurückgeben", "due_date": "2026-10-10"}).json()
    api.post("/api/tasks", json={"title": "Später", "due_date": "2026-12-01"})
    api.post("/api/tasks", json={"title": "Ohne Datum"})

    dashboard = api.get("/api/dashboard").json()
    assert [(i["id"], i["attention"]) for i in dashboard["attention"]] == [
        (late["id"], "overdue"),
        (soon["id"], "unconfirmed_due"),
        (confirmed["id"], "due_soon"),
    ]
    counts = dashboard["counts"]
    assert (counts["overdue"], counts["due_soon"], counts["due_soon_candidates"]) == (1, 1, 1)
    assert counts["needs_action"] == 1 and counts["candidates"] == 1  # the candidate, counted once
