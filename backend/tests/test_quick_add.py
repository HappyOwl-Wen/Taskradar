"""Quick entry for the user's own to-dos: one line -> title + deadline (zh/de/en), reviewed before saving."""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

from taskradar.domain.enums import TimeSemantics
from taskradar.extraction.quick_add import parse_quick_task

from .conftest import FIXED_NOW  # Wednesday, 14 October 2026, 10:00 in Berlin

TZ = "Europe/Berlin"


@pytest.mark.parametrize(
    ("text", "title", "date", "time", "semantics"),
    [
        ("周五前交房租", "交房租", dt.date(2026, 10, 16), None, TimeSemantics.DEADLINE),
        ("明天下午3点开组会", "开组会", dt.date(2026, 10, 15), dt.time(15, 0), TimeSemantics.APPOINTMENT),
        ("10月20日前提交选课", "提交选课", dt.date(2026, 10, 20), None, TimeSemantics.DEADLINE),
        ("Freitag 10 Uhr Zahnarzt", "Zahnarzt", dt.date(2026, 10, 16), dt.time(10, 0), TimeSemantics.APPOINTMENT),
        ("Miete bis 1.11. überweisen", "Miete überweisen", dt.date(2026, 11, 1), None, TimeSemantics.DEADLINE),
        ("Mittwoch Sport", "Sport", dt.date(2026, 10, 14), None, TimeSemantics.DEADLINE),  # today is Wednesday
        (
            "submit the report by Oct 20 5pm",
            "submit the report",
            dt.date(2026, 10, 20),
            dt.time(17),
            TimeSemantics.DEADLINE,
        ),
        ("call mom tomorrow", "call mom", dt.date(2026, 10, 15), None, TimeSemantics.DEADLINE),
    ],
)
def test_quick_entry_finds_title_and_date(
    text: str, title: str, date: dt.date, time: dt.time | None, semantics: TimeSemantics
) -> None:
    quick = parse_quick_task(text, now=FIXED_NOW, tz=TZ)
    assert quick.title == title
    assert quick.due is not None
    assert (quick.due.date, quick.due.time, quick.due.semantics) == (date, time, semantics)
    assert not quick.due.needs_confirmation  # relative to the moment the user typed it


def test_quick_entry_without_a_date_keeps_the_text() -> None:
    quick = parse_quick_task("  renew   passport ", now=FIXED_NOW, tz=TZ)
    assert (quick.title, quick.due) == ("renew passport", None)
    assert quick.category.value == "administrative"


def test_quick_parse_and_create_a_custom_todo(api: Any) -> None:
    parsed = api.post("/api/tasks/quick-parse", json={"text": "周五前交房租"}).json()
    temporal = parsed.pop("temporal")
    assert temporal["status"] == "resolved"
    assert temporal["precision"] == "date"
    assert temporal["normalized_date"] == "2026-10-16"
    assert temporal["needs_confirmation"] is False
    assert temporal["candidates"][0]["role"] == "deadline"
    assert parsed == {
        "title": "交房租",
        "category": "financial",
        "action_type": parsed["action_type"],
        "due_date": "2026-10-16",
        "due_time": None,
        "due_text": "周五",
        "time_semantics": "deadline",
        "ambiguous": False,
        "alternatives": [],
        "timezone": "Europe/Berlin",
    }
    created = api.post("/api/tasks", json={k: v for k, v in parsed.items() if k not in ("ambiguous", "alternatives")})
    assert created.status_code == 201, created.text
    task = created.json()
    assert (task["status"], task["manual"], task["due_date"], task["due_text"]) == (
        "confirmed",
        True,
        "2026-10-16",
        "周五",
    )
    assert task["source_kinds"] == ["manual"]
    assert [t["id"] for t in api.get("/api/tasks", params={"source_kind": "manual"}).json()["items"]] == [task["id"]]

    assert api.post("/api/tasks/quick-parse", json={"text": ""}).status_code == 422
    assert api.post("/api/tasks/quick-parse", json={"text": "x" * 301}).status_code == 422
    assert api.get("/api/tasks").json()["total"] == 1  # parsing never saves anything
