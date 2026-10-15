"""The status summary turns runtime problems into a few plain items (no logs needed)."""

from __future__ import annotations

from typing import Any

from taskradar.db.models import CalendarLink, Document, Source, SyncJob
from taskradar.db.session import transaction
from taskradar.domain.enums import SourceKind
from taskradar.security import secrets as sk


def _codes(summary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["code"]: item for item in summary["items"]}


def _gmail(api: Any, *, connected: bool = True) -> int:
    c = api.container
    if connected:
        c.secrets.set(sk.GOOGLE_TOKEN_GMAIL, '{"token": "fake"}')
    with transaction(c.factory) as session:
        source = Source(kind=SourceKind.GMAIL.value, name="Gmail", account="me@gmail.example", status="ok")
        session.add(source)
        session.flush()
        return source.id


def test_nothing_to_report_without_problems(api: Any) -> None:
    summary = api.get("/api/system/summary").json()
    # The test app runs without the background scheduler, which the summary does report.
    assert set(_codes(summary)) <= {"scheduler_off", "ocr_missing"}
    assert summary["overall"] in ("ok", "attention")


def test_gmail_problems_are_named_with_a_way_to_fix_them(api: Any) -> None:
    source_id = _gmail(api, connected=False)
    item = _codes(api.get("/api/system/summary").json())["gmail_auth_required"]
    assert (item["level"], item["action"]) == ("error", "gmail_settings")
    assert api.get("/api/system/summary").json()["overall"] == "problem"

    api.container.secrets.set(sk.GOOGLE_TOKEN_GMAIL, '{"token": "fake"}')
    with transaction(api.container.factory) as session:
        session.add(
            SyncJob(
                source_id=source_id,
                kind="gmail_sync",
                trigger="scheduled",
                lock_key=f"gmail:{source_id}",
                status="partial",
                items_seen=16,
                items_failed=4,
                details={"failed_codes": {"permanent_error": 4}},
            )
        )
    item = _codes(api.get("/api/system/summary").json())["gmail_items_failed"]
    assert item["params"] == {"count": 4, "codes": {"permanent_error": 4}} and item["action"] == "records"


def test_failed_files_and_calendar_events_are_counted_but_test_data_is_not(api: Any) -> None:
    c = api.container
    with transaction(c.factory) as session:
        real = Source(kind=SourceKind.UPLOAD.value, name="Uploads", status="ok")
        test = Source(kind=SourceKind.SAMPLE_UPLOAD.value, name="Test data", status="ok")
        session.add_all([real, test])
        session.flush()
        for i, source in enumerate([real, real, test]):
            session.add(
                Document(
                    source_id=source.id,
                    dedupe_key=f"d{i}",
                    kind="pdf",
                    original_name=f"f{i}.pdf",
                    sha256=f"{i:064d}",
                    mime_type="application/pdf",
                    status="failed",
                    error_code="corrupted_file",
                    imported_at=c.clock(),
                )
            )
    task = api.post("/api/tasks", json={"title": "Visa appointment", "due_date": "2026-11-02"}).json()
    with transaction(c.factory) as session:
        session.add(
            CalendarLink(task_id=task["id"], calendar_id="cal", event_id="e1", event_kind="all_day", status="failed")
        )
    items = _codes(api.get("/api/system/summary").json())
    assert items["items_failed"]["params"] == {"count": 2, "codes": {"corrupted_file": 2}}
    assert items["calendar_failed"]["params"] == {"count": 1}
