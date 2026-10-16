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


def eml(subject: str, body: str, key: str, *, date: str = "Wed, 14 Oct 2026 08:00:00 +0000") -> bytes:
    return (
        f"From: Office <office@uni.example>\r\nTo: me@example.com\r\nSubject: {subject}\r\n"
        f"Message-ID: <{key}@uni.example>\r\nDate: {date}\r\n"
        "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
        f"{body}\r\n"
    ).encode()


def upload_eml(api: Any, data: bytes, *, sample: bool = False) -> dict[str, Any]:
    response = api.post(
        "/api/documents/upload",
        files=[("files", ("mail.eml", data, "message/rfc822"))],
        data={"sample": "true"} if sample else None,
    )
    assert response.status_code == 200, response.text
    return response.json()["results"][0]


THREE_MAILS = [
    ("Semesterbeitrag", "Bitte überweisen Sie den Semesterbeitrag bis zum 20.11.2026.", "fee"),
    ("Visum", "Bitte laden Sie die Unterlagen für das Visum bis zum 25.11.2026 hoch.", "visa"),
    ("Prüfung", "Bitte melden Sie sich bis zum 30.11.2026 zur Prüfung Lineare Algebra an.", "exam"),
]


def test_merged_duplicates_are_not_counted_as_rejected(api: Any) -> None:
    for subject, body, key in THREE_MAILS:
        assert upload_eml(api, eml(subject, body, key))["tasks_created"] == 1
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
    assert [(i["id"], i["attention"], i["attention_flags"]) for i in dashboard["attention"]] == [
        (late["id"], "overdue", []),
        (soon["id"], "due_tomorrow", ["unconfirmed"]),  # marked as unconfirmed, never hidden
        (confirmed["id"], "due_soon", []),
    ]
    counts = dashboard["counts"]
    assert (counts["overdue"], counts["due_soon"], counts["due_soon_candidates"]) == (1, 1, 1)
    assert counts["needs_action"] == 1 and counts["candidates"] == 1  # the candidate, counted once


def _duplicate_suggestion(api: Any, new_id: str, existing: dict[str, Any]) -> int:
    from taskradar.db.session import transaction
    from taskradar.domain.enums import SuggestionKind

    c = api.container
    with transaction(c.factory) as session:
        task = c.tasks.get(session, new_id)
        task.review_reasons = ["possible_duplicate"]
        task.needs_review = True
        suggestion = c.tasks.suggest(
            session,
            task,
            kind=SuggestionKind.POSSIBLE_DUPLICATE,
            payload={"other_task_id": existing["id"], "other_title": existing["title"], "score": 0.7},
            evidence=[],
            confidence=0.7,
            reason="grey_zone_needs_user_decision",
            dedupe_key=f"{new_id}:possible_duplicate:{existing['id']}",
            related_task_id=existing["id"],
            summary="test",
        )
        assert suggestion is not None
        return suggestion.id


def test_undoing_an_accepted_duplicate_reopens_the_question(api: Any) -> None:
    existing = api.post("/api/tasks", json={"title": "Rückmeldung bezahlen", "due_date": "2026-11-15"}).json()
    new = api.post("/api/tasks", json={"title": "Semesterbeitrag zahlen", "due_date": "2026-11-20"}).json()
    api.post(f"/api/tasks/{new['id']}/status", json={"status": "candidate"})
    suggestion_id = _duplicate_suggestion(api, new["id"], existing)

    merged = api.post(f"/api/suggestions/{suggestion_id}/accept", json={"due_choice": "new"}).json()
    assert merged["due_date"] == "2026-11-20" and merged["undo_event_id"]
    assert api.get(f"/api/tasks/{new['id']}").json()["status"] == "dismissed"

    api.post(f"/api/events/{merged['undo_event_id']}/undo").raise_for_status()
    assert api.get(f"/api/tasks/{existing['id']}").json()["due_date"] == "2026-11-15"
    restored = api.get(f"/api/tasks/{new['id']}").json()
    assert restored["status"] == "candidate" and "possible_duplicate" in restored["review_reasons"]
    assert [s["id"] for s in api.get("/api/suggestions").json()["items"]] == [suggestion_id]  # decide again


def test_keeping_tasks_separate_clears_the_duplicate_flag_and_can_be_undone(api: Any) -> None:
    existing = api.post("/api/tasks", json={"title": "Visa appointment", "due_date": "2026-11-02"}).json()
    new = api.post("/api/tasks", json={"title": "Visa documents", "due_date": "2026-11-02"}).json()
    api.post(f"/api/tasks/{new['id']}/status", json={"status": "candidate"})
    suggestion_id = _duplicate_suggestion(api, new["id"], existing)

    kept = api.post(f"/api/suggestions/{suggestion_id}/reject").json()
    assert kept["id"] == new["id"] and kept["status"] == "candidate"
    assert "possible_duplicate" not in kept["review_reasons"] and kept["needs_review"] is False
    assert api.get("/api/suggestions").json()["items"] == []
    assert api.get(f"/api/tasks/{existing['id']}").json()["status"] == "confirmed"  # both tasks stay

    api.post(f"/api/events/{kept['undo_event_id']}/undo").raise_for_status()
    again = api.get(f"/api/tasks/{new['id']}").json()
    assert again["review_reasons"] == ["possible_duplicate"] and again["needs_review"] is True
    assert [s["id"] for s in api.get("/api/suggestions").json()["items"]] == [suggestion_id]


def test_undo_ids_for_status_changes_and_batches(api: Any) -> None:
    a = api.post("/api/tasks", json={"title": "Formular A"}).json()
    b = api.post("/api/tasks", json={"title": "Formular B"}).json()
    for task in (a, b):
        api.post(f"/api/tasks/{task['id']}/status", json={"status": "candidate"})

    confirmed = api.post(f"/api/tasks/{a['id']}/status", json={"status": "confirmed"}).json()
    api.post(f"/api/events/{confirmed['undo_event_id']}/undo").raise_for_status()
    assert api.get(f"/api/tasks/{a['id']}").json()["status"] == "candidate"
    unchanged = api.post(f"/api/tasks/{a['id']}/status", json={"status": "candidate"}).json()
    assert unchanged["undo_event_id"] is None  # nothing changed, nothing to undo

    batch = api.post("/api/tasks/batch", json={"ids": [a["id"], b["id"]], "action": "dismiss"}).json()
    assert batch["count"] == 2 and len(batch["undo_event_ids"]) == 2
    for event_id in batch["undo_event_ids"]:
        api.post(f"/api/events/{event_id}/undo").raise_for_status()
    assert {api.get(f"/api/tasks/{t['id']}").json()["status"] for t in (a, b)} == {"candidate"}


def test_undoing_an_accepted_status_suggestion(api: Any) -> None:
    from taskradar.db.session import transaction
    from taskradar.domain.enums import SuggestionKind

    task = api.post("/api/tasks", json={"title": "Bescheinigung hochladen"}).json()
    c = api.container
    with transaction(c.factory) as session:
        suggestion = c.tasks.suggest(
            session,
            c.tasks.get(session, task["id"]),
            kind=SuggestionKind.MARK_COMPLETED,
            payload={},
            evidence=[],
            confidence=0.8,
            reason="completion_signal",
            dedupe_key=f"{task['id']}:mark_completed:test",
            summary="test",
        )
        assert suggestion is not None
        suggestion_id = suggestion.id

    done = api.post(f"/api/suggestions/{suggestion_id}/accept").json()
    assert done["status"] == "completed"
    api.post(f"/api/events/{done['undo_event_id']}/undo").raise_for_status()
    assert api.get(f"/api/tasks/{task['id']}").json()["status"] == "confirmed"
    assert [s["id"] for s in api.get("/api/suggestions").json()["items"]] == [suggestion_id]
    # A second undo of the same decision is refused instead of silently doing something else.
    assert api.post(f"/api/events/{done['undo_event_id']}/undo").status_code == 409


def test_attention_puts_time_before_conflicts(api: Any) -> None:
    # FIXED_NOW is Wednesday 14 October 2026. A candidate due at the end of the month with a disputed date
    # used to be listed above tasks due today and tomorrow.
    month_end = api.post("/api/tasks", json={"title": "Mitgliedsbeitrag überweisen", "due_date": "2026-10-31"}).json()
    other = api.post("/api/tasks", json={"title": "Beitrag Verein", "due_date": "2026-10-28"}).json()
    api.post(f"/api/tasks/{month_end['id']}/status", json={"status": "candidate"})
    _duplicate_suggestion(api, month_end["id"], other)
    today = api.post("/api/tasks", json={"title": "Folien wiederholen", "due_date": "2026-10-14"}).json()
    tomorrow_candidate = api.post("/api/tasks", json={"title": "Antrag abgeben", "due_date": "2026-10-15"}).json()
    api.post(f"/api/tasks/{tomorrow_candidate['id']}/status", json={"status": "candidate"})
    tomorrow = api.post("/api/tasks", json={"title": "Tutor beantragen", "due_date": "2026-10-15"}).json()
    late = api.post("/api/tasks", json={"title": "Gebühr zahlen", "due_date": "2026-10-12"}).json()
    api.post(f"/api/tasks/{late['id']}/status", json={"status": "candidate"})

    dashboard = api.get("/api/dashboard").json()
    attention = dashboard["attention"]
    order = [(i["title"], i["attention"]) for i in attention]
    assert order[:4] == [
        (late["title"], "overdue"),
        (today["title"], "due_today"),
        (tomorrow["title"], "due_tomorrow"),  # confirmed before unconfirmed on the same day
        (tomorrow_candidate["title"], "due_tomorrow"),
    ]
    assert order.index((month_end["title"], "conflict")) > 3
    flags = {i["id"]: i["attention_flags"] for i in attention}
    assert flags[late["id"]] == ["unconfirmed"] and set(flags[month_end["id"]]) == {"unconfirmed", "conflict"}
    # The summary sentence counts overdue … due within a week; the unconfirmed month-end task is not part of it.
    assert dashboard["attention_counts"] == {
        "overdue": 1,
        "due_today": 1,
        "due_tomorrow": 2,
        "conflict": 2,
    }  # both of the pair
    assert dashboard["attention_unconfirmed"] == 2


def test_suggestions_name_both_tasks_and_their_deadlines(api: Any) -> None:
    existing = api.post("/api/tasks", json={"title": "Probe Workshop fee", "due_date": "2026-10-28"}).json()
    new = api.post("/api/tasks", json={"title": "Pay the Probe Workshop fee", "due_date": "2026-10-30"}).json()
    api.post(f"/api/tasks/{new['id']}/status", json={"status": "candidate"})
    _duplicate_suggestion(api, new["id"], existing)
    views = (
        api.get("/api/dashboard").json()["suggestions"][0],
        api.get("/api/suggestions").json()["items"][0],
        api.get(f"/api/tasks/{new['id']}").json()["suggestions"][0],  # the inbox detail says it too
    )
    for entry in views:
        assert (entry["task_title"], entry["task_due_date"], entry["task_status"]) == (
            new["title"],
            "2026-10-30",
            "candidate",
        )
        assert (entry["related_task_title"], entry["related_due_date"], entry["related_task_status"]) == (
            existing["title"],
            "2026-10-28",
            "confirmed",
        )
        assert entry["deadlines_differ"] is True and entry["task_sample"] is False


def test_test_data_never_counts_reminds_or_reaches_the_calendar(api: Any) -> None:
    real = upload_eml(api, eml(*THREE_MAILS[0][:2], "real-fee"))
    assert real["tasks_created"] == 1
    before = api.get("/api/metrics").json()
    # The same notice imported as test data: its own task, never matched with the real one.
    test = upload_eml(api, eml(*THREE_MAILS[0][:2], "test-fee"), sample=True)
    assert (test["tasks_created"], test["duplicates_merged"], test["suggestions_created"]) == (1, 0, 0)
    overdue = upload_eml(
        api, eml("Mahnung", "Bitte zahlen Sie die Mahngebühr bis zum 10.10.2026.", "test-late"), sample=True
    )
    assert overdue["tasks_created"] == 1
    samples = api.get("/api/tasks", params={"sample": True}).json()["items"]
    assert len(samples) == 2 and all(t["sample"] for t in samples)
    assert len(api.get("/api/tasks", params={"sample": False}).json()["items"]) == 1

    dashboard = api.get("/api/dashboard").json()
    assert dashboard["counts"]["candidates"] == 1 and dashboard["counts"]["sample_open"] == 2
    assert all(not i["sample"] for i in dashboard["attention"])
    after = api.get("/api/metrics").json()
    assert after["messages"]["total"] == before["messages"]["total"]
    assert after["feedback"] == before["feedback"]

    # No reminder, even though one of them is overdue and confirmed.
    late = next(t for t in samples if t["due_date"] == "2026-10-10")
    api.post(f"/api/tasks/{late['id']}/status", json={"status": "confirmed"})
    api.post("/api/notifications/scan")
    assert all(n["task_id"] != late["id"] for n in api.get("/api/notifications").json()["items"])
    # Never written to Google Calendar.
    refused = api.post(f"/api/tasks/{late['id']}/calendar", json={"confirm": True})
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "sample_task"
    assert "sample_task" in api.get(f"/api/tasks/{late['id']}/calendar/preview").json()["warnings"]
    # Never merged with real tasks.
    real_task = api.get("/api/tasks", params={"sample": False}).json()["items"][0]
    mixed = api.post(f"/api/tasks/{late['id']}/merge", json={"into_task_id": real_task["id"], "due_choice": "new"})
    assert mixed.status_code == 409 and mixed.json()["error"]["code"] == "sample_mismatch"


def test_marking_a_task_as_test_data_hides_its_reminders_and_can_be_undone(api: Any) -> None:
    task = api.post("/api/tasks", json={"title": "测试：整理报销单", "due_date": "2026-10-14"}).json()
    api.post("/api/notifications/scan")
    assert any(n["task_id"] == task["id"] for n in api.get("/api/notifications").json()["items"])

    marked = api.post(f"/api/tasks/{task['id']}/sample", json={"sample": True}).json()
    assert marked["sample"] is True and marked["undo_event_id"]
    assert all(n["task_id"] != task["id"] for n in api.get("/api/notifications").json()["items"])
    assert api.get("/api/dashboard").json()["counts"]["active"] == 0

    api.post(f"/api/events/{marked['undo_event_id']}/undo").raise_for_status()
    assert api.get(f"/api/tasks/{task['id']}").json()["sample"] is False
    assert api.get("/api/dashboard").json()["counts"]["active"] == 1


def test_created_test_tasks_and_removing_the_test_data_source(api: Any) -> None:
    manual = api.post("/api/tasks", json={"title": "测试：没有截止日期", "sample": True}).json()
    assert manual["sample"] is True and api.get("/api/dashboard").json()["counts"]["active"] == 0
    kept = upload_eml(api, eml(*THREE_MAILS[1][:2], "real-visa"))
    upload_eml(api, eml(*THREE_MAILS[2][:2], "test-exam"), sample=True)
    source = next(s for s in api.get("/api/sources").json()["items"] if s["kind"] == "sample_upload")
    removed = api.delete(f"/api/sources/{source['id']}").json()
    assert removed["removed_tasks"] == 1
    titles = [t["title"] for t in api.get("/api/tasks").json()["items"]]
    assert manual["title"] in titles  # created by hand: not part of the removed source
    assert api.get(f"/api/messages/{kept['message_id']}").status_code == 200  # real data untouched
    assert len(titles) == 2


def test_demo_mailbox_tasks_are_samples(api: Any) -> None:
    source = api.post("/api/demo/mailbox").json()
    assert api.post(f"/api/sources/{source['id']}/sync", params={"wait": True}).json()["job"]["status"] == "succeeded"
    items = api.get("/api/tasks").json()["items"]
    assert items and all(t["sample"] for t in items)
    dashboard = api.get("/api/dashboard").json()
    assert dashboard["counts"]["candidates"] == 0 and dashboard["counts"]["sample_open"] == len(items)
    assert api.get("/api/metrics").json()["feedback"]["agent_tasks"] == 0
    removed = api.delete(f"/api/sources/{source['id']}").json()
    assert removed["removed_tasks"] == len(items)
    assert api.get("/api/tasks").json()["items"] == []
