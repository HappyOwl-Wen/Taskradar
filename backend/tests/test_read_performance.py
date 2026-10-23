"""Read-path equivalence and bounded ORM loading, using isolated data and no timing assertions."""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import event, insert, select
from sqlalchemy.orm import selectinload

from taskradar.api.serializers import task_summary
from taskradar.db.calendar_models import WorkBlock
from taskradar.db.models import CalendarLink, Notification, Task, TaskLink, TaskSource, Timer
from taskradar.db.session import transaction
from taskradar.deadlines.engine import Thresholds
from tests.conftest import FIXED_NOW

SORTS = ("due", "priority", "urgency", "created_at", "updated_at", "detected_at")
URGENCY = {
    value: index
    for index, value in enumerate(("overdue", "urgent", "high", "upcoming", "normal", "no_deadline", "inactive"))
}
PRIORITY = {"high": 0, "medium": 1, "low": 2}
OPEN = ("candidate", "confirmed", "in_progress", "waiting_for_reply")
LANES = {
    "todo": ("confirmed", "candidate"),
    "in_progress": ("in_progress",),
    "waiting_for_reply": ("waiting_for_reply",),
}


@pytest.fixture
def dataset(api: Any) -> Iterator[list[dict[str, Any]]]:
    c = api.container
    with transaction(c.factory) as session:
        session.execute(
            insert(Task),
            [
                {
                    "id": f"task-{i:03}",
                    "title": f"Task {i}",
                    "description": "Notes " * 50,
                    "status": (*OPEN, "completed", "dismissed")[i % 6],
                    "priority": ("high", "medium", "low")[i % 3],
                    "due_date": dt.date(2026, 10, 10) + dt.timedelta(days=i % 22) if i % 5 else None,
                    "due_time": "02:30" if i % 3 else None,
                    "timezone": ("Europe/Berlin", "America/New_York", "Asia/Shanghai")[i % 3],
                    "category": "finance" if i % 2 else "other",
                    "manual": bool(i % 2),
                    "sample": i % 17 == 0,
                    "deleted_at": FIXED_NOW if i % 19 == 0 else None,
                    "created_at": FIXED_NOW - dt.timedelta(minutes=i // 3),
                    "updated_at": FIXED_NOW - dt.timedelta(hours=i % 9),
                    "detected_at": FIXED_NOW - dt.timedelta(minutes=i // 4),
                    "completed_at": FIXED_NOW - dt.timedelta(days=i % 10) if i % 6 == 4 else None,
                }
                for i in range(330)  # Exceeds a ranking batch and includes equal sort keys.
            ],
        )
        session.execute(
            insert(TaskSource),
            [{"task_id": f"task-{i:03}", "origin_key": "manual", "relation": "origin"} for i in range(330)],
        )
        session.execute(
            insert(CalendarLink),
            [
                {
                    "task_id": f"task-{i:03}",
                    "calendar_id": "calendar",
                    "event_id": str(i),
                    "event_kind": "all_day",
                    "status": "synced" if i % 10 else "removed",
                }
                for i in range(0, 330, 5)
            ],
        )
    with transaction(c.factory) as session:
        reference = [
            task_summary(task, now=FIXED_NOW, thresholds=Thresholds())
            for task in session.scalars(
                select(Task)
                .where(Task.deleted_at.is_(None))
                .options(selectinload(Task.sources), selectinload(Task.calendar_links))
            )
        ]
    yield reference


def sort_key(item: dict[str, Any], sort: str) -> tuple[Any, ...]:
    deadline = item["effective_deadline"]
    if sort == "due":
        return (deadline is None, deadline or "", URGENCY[item["urgency"]])
    if sort == "urgency":
        return (URGENCY[item["urgency"]], deadline or "9999")
    if sort == "priority":
        return (PRIORITY[item["priority"]], deadline or "9999")
    return (item[sort],)


@pytest.mark.parametrize("sort", SORTS)
@pytest.mark.parametrize("order", ("asc", "desc"))
@pytest.mark.parametrize("urgency", ([], ["overdue", "high", "no_deadline"]))
def test_task_pages_match_full_sort_with_ties_timezones_and_filters(api, dataset, sort, order, urgency):
    expected = [item for item in dataset if not urgency or item["urgency"] in urgency]
    expected.sort(key=lambda item: sort_key(item, sort), reverse=order == "desc")
    for offset in (0, 7, 999):
        response = api.get(
            "/api/tasks",
            params={
                "sort": sort,
                "order": order,
                "urgency": urgency,
                "limit": 13,
                "offset": offset,
            },
        )
        assert response.status_code == 200, response.text
        assert response.json() == {"items": expected[offset : offset + 13], "total": len(expected)}


@pytest.mark.parametrize("sort", ("due", "created_at"))
def test_task_page_counts_keep_search_and_relationship_filters(api, dataset, sort):
    expected = [
        item
        for item in dataset
        if (
            not item["sample"]
            and item["manual"]
            and item["category"] == "finance"
            and item["status"] in OPEN
            and item["calendar_status"] == "synced"
            and "Task 1" in item["title"]
        )
    ]
    expected.sort(key=lambda item: sort_key(item, sort))
    result = api.get(
        "/api/tasks",
        params={
            "sort": sort,
            "sample": False,
            "manual": True,
            "category": "finance",
            "in_calendar": True,
            "status": list(OPEN),
            "q": "Task 1",
            "offset": 1,
            "limit": 3,
        },
    ).json()
    assert result == {"items": expected[1:4], "total": len(expected)}


@pytest.mark.parametrize("sort", ("due", "created_at"))
@pytest.mark.parametrize("urgency", ([], ["overdue"]))
def test_task_pages_only_materialize_the_returned_tasks(api, dataset, sort, urgency):
    loaded = []

    def on_load(task, _context):
        loaded.append(task.id)

    event.listen(Task, "load", on_load)
    try:
        page = api.get("/api/tasks", params={"sort": sort, "urgency": urgency, "offset": 4, "limit": 9}).json()
    finally:
        event.remove(Task, "load", on_load)
    assert len(loaded) == len(page["items"]) == 9
    assert set(loaded) == {item["id"] for item in page["items"]}


def test_dashboard_keeps_exact_counts_and_order_with_bounded_loading(api, dataset):
    active = [item for item in dataset if not item["sample"] and item["status"] in OPEN]
    today = FIXED_NOW.date()
    attention = []
    reasons = ("overdue", "due_today", "due_tomorrow", "due_soon")
    for item in active:
        due = dt.date.fromisoformat(item["due_date"]) if item["due_date"] else None
        if item["urgency"] == "overdue":
            reason = "overdue"
        elif due and due <= today:
            reason = "due_today"
        elif due == today + dt.timedelta(days=1):
            reason = "due_tomorrow"
        elif due and due <= today + dt.timedelta(days=7):
            reason = "due_soon"
        else:
            continue
        attention.append({**item, "attention": reason})
    attention.sort(key=lambda item: (reasons.index(item["attention"]), item["effective_deadline"] or "9999"))
    recent = [
        item
        for item in dataset
        if not item["sample"]
        and item["status"] == "completed"
        and item["completed_at"] >= (FIXED_NOW - dt.timedelta(days=7)).isoformat()
    ]
    recent.sort(key=lambda item: item["completed_at"], reverse=True)
    lanes = {
        lane: sorted(
            [item for item in active if item["status"] in statuses],
            key=lambda item: (item["effective_deadline"] or "9999", PRIORITY[item["priority"]]),
        )[:8]
        for lane, statuses in LANES.items()
    }
    loaded = []

    def on_load(task, _context):
        loaded.append(task.id)

    event.listen(Task, "load", on_load)
    try:
        result = api.get("/api/dashboard").json()
    finally:
        event.remove(Task, "load", on_load)
    assert result["attention"] == attention[:12]
    assert result["attention_total"] == len(attention)
    assert result["lanes"] == lanes
    assert result["completed_recent"] == recent[:5]
    assert result["counts"] == {
        **{reason: sum(item["attention"] == reason for item in attention) for reason in reasons},
        "active": len(active),
        "unconfirmed": sum(item["status"] == "candidate" for item in active),
        **{lane: sum(item["status"] in statuses for item in active) for lane, statuses in LANES.items()},
        "completed_7d": len(recent),
        "sample_open": sum(item["sample"] and item["status"] in OPEN for item in dataset),
    }
    assert len(loaded) <= 3 * 8 + 12 + 5


def test_related_tasks_are_read_together_and_trashed_ones_are_hidden(container):
    with transaction(container.factory) as session:
        session.add_all(
            [Task(id=str(i), title=f"Task {i}", deleted_at=FIXED_NOW if i == 40 else None) for i in range(41)]
        )
        session.flush()
        session.add_all(
            [TaskLink(task_id="0" if i % 2 else str(i), other_task_id=str(i) if i % 2 else "0") for i in range(1, 41)]
        )
    loaded = []

    def on_load(task, _context):
        loaded.append(task.id)

    from taskradar.api.routes.tasks import get_task

    event.listen(Task, "load", on_load)
    try:
        detail = get_task("0", container)
    finally:
        event.remove(Task, "load", on_load)
    assert loaded == ["0"]
    assert {link["task_id"]: link["direction"] for link in detail["links"]} == {
        str(i): "outgoing" if i % 2 else "incoming" for i in range(1, 40)
    }


def test_calendar_unscheduled_excludes_tasks_with_blocks_outside_the_view(container):
    with transaction(container.factory) as session:
        session.add_all([Task(id=str(i), title=f"Task {i}", status="confirmed") for i in range(4)])
        session.flush()
        session.add_all(
            [
                WorkBlock(
                    id=str(i),
                    task_id=task_id,
                    title="Work",
                    start_at=FIXED_NOW,
                    end_at=FIXED_NOW + dt.timedelta(hours=1),
                    timezone="Europe/Berlin",
                )
                for i, task_id in enumerate(("0", "0", "1", None))
            ]
        )
    result = container.workspace.view(dt.date(2026, 11, 1), dt.date(2026, 12, 1))
    assert result["items"] == []
    assert result["unscheduled"] == [{"id": "2", "title": "Task 2"}, {"id": "3", "title": "Task 3"}]


def test_timer_overview_query_count_does_not_grow_with_linked_tasks(container):
    def seed(start, end):
        with transaction(container.factory) as session:
            session.execute(
                insert(Task),
                [
                    {"id": str(i), "title": f"Task {i}", "deleted_at": FIXED_NOW if i == 0 else None}
                    for i in range(start, end)
                ],
            )
            session.execute(
                insert(Timer),
                [
                    {
                        "kind": "countdown",
                        "task_id": str(i),
                        "status": "finished",
                        "duration_seconds": 60,
                        "finished_at": FIXED_NOW,
                    }
                    for i in range(start, end)
                ],
            )

    seed(0, 1)
    container.settings.get()
    statements = []

    def on_query(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(container.engine, "before_cursor_execute", on_query)
    try:
        container.timers.overview()
        initial = len(statements)
        seed(1, 40)
        statements.clear()
        view = container.timers.overview()
        assert len(statements) == initial
    finally:
        event.remove(container.engine, "before_cursor_execute", on_query)
    assert len(view["countdowns"]) == 40
    assert {timer["task_title"] for timer in view["countdowns"]} == {None, *(f"Task {i}" for i in range(1, 40))}


def test_notification_counts_and_bulk_read_do_not_materialize_notifications(container):
    with transaction(container.factory) as session:
        session.add_all(
            [
                Task(id="real", title="Real"),
                Task(id="sample", title="Sample", sample=True),
                Task(id="trash", title="Trash", deleted_at=FIXED_NOW),
            ]
        )
        session.flush()
        session.add_all(
            [
                Notification(id=i + 1, task_id=task_id, title="Note", level="info", dedupe_key=str(i))
                for i, task_id in enumerate(("real", "sample", "trash", None))
            ]
        )
    loaded = []

    def on_load(note, _context):
        loaded.append(note.id)

    event.listen(Notification, "load", on_load)
    try:
        assert container.notifications.unread_count() == 2
        container.notifications.mark_read(1)
        assert container.notifications.unread_count() == 1
        container.notifications.mark_read()
        assert container.notifications.unread_count() == 0
    finally:
        event.remove(Notification, "load", on_load)
    assert loaded == []
