"""Task lifecycle through the real services and database: creation, status, edits, undo, reminders."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from taskradar.container import Container
from taskradar.db.models import Notification, Task, TaskEvent
from taskradar.db.session import transaction
from taskradar.domain.enums import Actor, JobKind, JobStatus, JobTrigger, TaskStatus
from taskradar.services.jobs import JobAlreadyRunning, JobContext
from taskradar.services.tasks import NotRevertible, RevertConflict

from .conftest import add_task


def task(c: Container, task_id: str) -> Task:
    with transaction(c.factory) as session:
        found = session.get(Task, task_id)
        assert found is not None
        session.expunge(found)
        return found


def set_status(c: Container, task_id: str, status: TaskStatus) -> int | None:
    with transaction(c.factory) as session:
        event = c.tasks.change_status(session, c.tasks.get(session, task_id), status, actor=Actor.USER)
        return event.id if event else None


def undo(c: Container, event_id: int) -> None:
    with transaction(c.factory) as session:
        c.tasks.revert_event(session, event_id)


def test_a_new_todo_counts_at_once(container: Container) -> None:
    task_id = add_task(container, "交房租", due=dt.date(2026, 10, 16))
    created = task(container, task_id)
    assert created.manual and created.status == "confirmed" and created.confirmed_at is not None
    assert created.confidence == 1.0 and created.action_required == "交房租"
    assert (created.due_date, created.due_precision) == (dt.date(2026, 10, 16), "date")
    with transaction(container.factory) as session:
        [event] = session.scalars(select(TaskEvent).where(TaskEvent.task_id == task_id)).all()
        assert (event.event_type, event.actor) == ("created", "user")


def test_status_changes_are_recorded_and_the_last_one_can_be_undone(container: Container) -> None:
    task_id = add_task(container)
    events = [
        set_status(container, task_id, status)
        for status in (TaskStatus.IN_PROGRESS, TaskStatus.WAITING_FOR_REPLY, TaskStatus.COMPLETED)
    ]
    assert set_status(container, task_id, TaskStatus.COMPLETED) is None  # no change, no event
    with transaction(container.factory) as session:
        changes = session.scalars(
            select(TaskEvent).where(TaskEvent.task_id == task_id, TaskEvent.event_type == "status_changed")
        ).all()
        assert [e.data["after"]["status"] for e in changes] == ["in_progress", "waiting_for_reply", "completed"]
        assert [e.summary for e in changes] == [
            "状态：待办 → 进行中",
            "状态：进行中 → 等待回复",
            "状态：等待回复 → 已完成",
        ]
    assert task(container, task_id).completed_at is not None

    assert events[-1] is not None
    undo(container, events[-1])
    back = task(container, task_id)
    assert back.status == "waiting_for_reply" and back.completed_at is None
    with pytest.raises(RevertConflict):
        undo(container, events[-1])  # already undone

    # An older change cannot be undone once the status moved on.
    assert events[0] is not None
    with pytest.raises(RevertConflict):
        undo(container, events[0])


def test_edits_lock_the_field_and_can_be_undone(container: Container) -> None:
    task_id = add_task(container, due=dt.date(2026, 10, 20))
    with transaction(container.factory) as session:
        t = container.tasks.get(session, task_id)
        event = container.tasks.update_fields(
            session, t, {"due_date": dt.date(2026, 10, 22), "due_time": "09:30"}, actor=Actor.USER, lock=True
        )
        assert event is not None
        event_id = event.id
    edited = task(container, task_id)
    assert (edited.due_date, edited.due_time, edited.due_precision) == (dt.date(2026, 10, 22), "09:30", "datetime")
    assert edited.due_version == 1 and edited.user_locked_fields == ["due"]
    undo(container, event_id)
    restored = task(container, task_id)
    assert (restored.due_date, restored.due_time, restored.due_version) == (dt.date(2026, 10, 20), None, 2)


def test_changes_of_earlier_versions_stay_in_the_history(container: Container) -> None:
    """Merges and suggestions came from imported mails; they are shown but cannot be undone any more."""
    task_id = add_task(container)
    with transaction(container.factory) as session:
        old = TaskEvent(
            task_id=task_id,
            event_type="merged",
            actor="user",
            summary="合并了任务「旧的提醒」",
            data={"merged_task_id": "gone"},
            revertible=True,
            created_at=container.clock(),
        )
        session.add(old)
        session.flush()
        old_id = old.id
    with pytest.raises(NotRevertible):
        undo(container, old_id)


def test_data_survives_restart(make_container: Callable[..., Container]) -> None:
    first = make_container()
    task_id = add_task(first, due=dt.date(2026, 11, 20))
    set_status(first, task_id, TaskStatus.IN_PROGRESS)
    first.dispose()
    second = make_container()
    again = task(second, task_id)
    assert again.status == "in_progress" and again.due_date == dt.date(2026, 11, 20)
    with transaction(second.factory) as session:
        assert session.scalar(select(func.count()).select_from(TaskEvent)) == 2


def test_job_lock_prevents_concurrent_runs(container: Container) -> None:
    kind, key = JobKind.REMINDER_SCAN, "reminders"
    job_id = container.jobs.start(kind, lock_key=key, source_id=None, trigger=JobTrigger.MANUAL)
    with pytest.raises(JobAlreadyRunning):
        container.jobs.start(kind, lock_key=key, source_id=None, trigger=JobTrigger.MANUAL)
    container.jobs.finish(job_id, JobContext(job_id), status=JobStatus.SUCCEEDED)
    # After finishing, the lock is free again.
    container.jobs.start(kind, lock_key=key, source_id=None, trigger=JobTrigger.MANUAL)
    assert container.jobs.recover_interrupted() == 1


def test_reminders_are_deduplicated_and_stop_after_completion(container: Container) -> None:
    task_id = add_task(container, "Semesterbeitrag überweisen", due=dt.date(2026, 10, 16))
    container.notifications.scan()
    container.notifications.scan()
    with transaction(container.factory) as session:
        notes = session.scalars(select(Notification)).all()
        assert len(notes) == 1 and notes[0].level == "high"
    set_status(container, task_id, TaskStatus.COMPLETED)
    container.clock.advance(days=5)  # type: ignore[attr-defined]
    container.notifications.scan()
    with transaction(container.factory) as session:
        assert session.scalar(select(func.count()).select_from(Notification)) == 1


def test_unconfirmed_tasks_of_earlier_versions_stay_quiet_until_urgent(container: Container) -> None:
    task_id = add_task(container, due=dt.date(2026, 10, 16))
    set_status(container, task_id, TaskStatus.CANDIDATE)
    container.notifications.scan()
    with transaction(container.factory) as session:
        assert session.scalar(select(func.count()).select_from(Notification)) == 0  # only "high": quiet
    container.clock.advance(days=2)  # type: ignore[attr-defined]  # 14 hours left
    container.notifications.scan()
    with transaction(container.factory) as session:
        [note] = session.scalars(select(Notification)).all()
        assert note.level == "urgent" and note.title.endswith("（待确认）")


def test_windows_notifications_only_when_switched_on(container: Container, toasts: list[tuple[str, str]]) -> None:
    add_task(container, "交房租", due=dt.date(2026, 10, 15))
    container.notifications.scan()
    assert toasts == []  # off by default: the reminder is only in TaskRadar's own list
    container.settings.update({"notifications": {"desktop_enabled": True}})
    add_task(container, "交作业", due=dt.date(2026, 10, 15))
    container.notifications.scan()
    assert toasts == [("3 天内截止：交作业", "截止：2026-10-15")]
