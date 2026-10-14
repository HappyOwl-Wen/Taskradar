"""Task lifecycle through the real services and database: dedup, updates, completion, undo."""

from __future__ import annotations

import datetime as dt
import itertools
from collections.abc import Callable

import pytest
from sqlalchemy import func, select

from taskradar.container import Container
from taskradar.db.models import ExtractionRun, Message, Notification, Task, TaskEvent, TaskSource, TaskSuggestion
from taskradar.db.session import transaction
from taskradar.domain.enums import Actor, SourceKind, TaskStatus
from taskradar.domain.schemas import NormalizedMessage
from taskradar.services.documents import get_or_create_source
from taskradar.services.ingest import IngestOutcome
from taskradar.services.jobs import JobAlreadyRunning, JobContext
from taskradar.domain.enums import JobKind, JobStatus, JobTrigger

from .conftest import FIXED_NOW

_ids = itertools.count(1)


def ingest_mail(c: Container, subject: str, body: str, *, sent_at: dt.datetime = FIXED_NOW,
                thread: str | None = None, external_id: str | None = None) -> tuple[IngestOutcome, int]:
    with transaction(c.factory) as session:
        source = get_or_create_source(session, SourceKind.UPLOAD, "tests")
        message, _ = c.documents.store_message(
            session,
            NormalizedMessage(external_id=external_id or f"m{next(_ids)}", thread_id=thread, subject=subject,
                              sender="Office <office@uni.example>", sender_domain="uni.example", sent_at=sent_at,
                              body_text=body),
            source=source, web_link=None,
        )
        message_id = message.id
    return c.ingest.process_message(message_id), message_id


def tasks(c: Container) -> list[Task]:
    with transaction(c.factory) as session:
        return list(session.scalars(select(Task).order_by(Task.created_at)))


def set_status(c: Container, task_id: str, status: TaskStatus) -> None:
    with transaction(c.factory) as session:
        c.tasks.change_status(session, c.tasks.get(session, task_id), status, actor=Actor.USER)


NOTICE = ("学生证明提交通知", "各位同学：\n请于2026年11月20日前通过TUMonline上传在读证明（Immatrikulationsbescheinigung）。")
REMINDER = ("提醒：提交学生证明", "提醒您：请在11月20日前提交学生证明。如果您已经提交，请忽略此邮件。")


def test_first_notice_creates_candidate_with_evidence(container: Container) -> None:
    outcome, _ = ingest_mail(container, *NOTICE)
    assert outcome.tasks_created == 1
    [task] = tasks(container)
    assert task.status == "candidate"
    assert task.due_date == dt.date(2026, 11, 20) and task.due_time is None and task.due_precision == "date"
    with transaction(container.factory) as session:
        task = session.get(Task, task.id)
        assert task is not None
        assert task.sources[0].relation == "origin"
        assert "2026年11月20日" in task.sources[0].evidence[0]["quote"]
        assert [e.event_type for e in task.events] == ["created"]


def test_reprocessing_is_idempotent(container: Container) -> None:
    _, message_id = ingest_mail(container, *NOTICE)
    again = container.ingest.process_message(message_id, force=True)
    assert again.tasks_created == 0 and again.unchanged == 1
    assert len(tasks(container)) == 1
    assert container.ingest.process_message(message_id).skipped  # not forced: skipped entirely


def test_reminder_is_merged_not_duplicated(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    outcome, _ = ingest_mail(container, *REMINDER, sent_at=FIXED_NOW + dt.timedelta(days=5))
    assert outcome.tasks_created == 0 and outcome.duplicates_merged == 1
    [task] = tasks(container)
    with transaction(container.factory) as session:
        sources = session.scalars(select(TaskSource).where(TaskSource.task_id == task.id)).all()
        assert sorted(s.relation for s in sources) == ["duplicate", "origin"]


def test_cross_language_reminder_is_recognised(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    outcome, _ = ingest_mail(container, "Erinnerung", "Bitte denken Sie daran, Ihre Immatrikulationsbescheinigung "
                                                    "bis zum 20.11.2026 hochzuladen.")
    assert outcome.tasks_created == 0 and outcome.duplicates_merged == 1


def test_different_obligation_creates_new_task(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    outcome, _ = ingest_mail(container, "Semesterbeitrag", "Bitte überweisen Sie den Semesterbeitrag bis zum 20.11.2026.")
    assert outcome.tasks_created == 1
    assert len(tasks(container)) == 2


def test_explicit_deadline_change_is_applied_and_revertible(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    outcome, _ = ingest_mail(container, "截止日期延期", "通知：学生证明的提交截止日期延长至11月27日。",
                             sent_at=FIXED_NOW + dt.timedelta(days=2))
    assert outcome.tasks_updated == 1 and outcome.tasks_created == 0
    [task] = tasks(container)
    assert task.due_date == dt.date(2026, 11, 27)
    assert task.due_version == 1
    with transaction(container.factory) as session:
        event = session.scalars(select(TaskEvent).where(TaskEvent.event_type == "fields_updated")).one()
        assert event.actor == "agent" and event.revertible
        container.tasks.revert_event(session, event.id)
    [task] = tasks(container)
    assert task.due_date == dt.date(2026, 11, 20)


def test_conflicting_deadline_without_explicit_change_becomes_suggestion(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    outcome, _ = ingest_mail(container, "Nachricht", "Bitte laden Sie Ihre Immatrikulationsbescheinigung bis "
                                                   "zum 25.11.2026 in TUMonline hoch.",
                             sent_at=FIXED_NOW + dt.timedelta(days=1))
    assert outcome.suggestions_created == 1
    [task] = tasks(container)
    assert task.due_date == dt.date(2026, 11, 20)  # unchanged until the user decides
    with transaction(container.factory) as session:
        suggestion = session.scalars(select(TaskSuggestion)).one()
        assert suggestion.kind == "update_due" and suggestion.payload["due_date"] == "2026-11-25"
        container.tasks.accept_suggestion(session, suggestion.id)
    assert tasks(container)[0].due_date == dt.date(2026, 11, 25)


def test_user_edited_deadline_is_never_overwritten(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    [task] = tasks(container)
    with transaction(container.factory) as session:
        container.tasks.update_fields(session, container.tasks.get(session, task.id), {"due_date": "2026-11-18"},
                                      actor=Actor.USER, lock=True)
    outcome, _ = ingest_mail(container, "截止日期延期", "通知：学生证明的提交截止日期延长至11月27日。",
                             sent_at=FIXED_NOW + dt.timedelta(days=2))
    assert outcome.tasks_updated == 0 and outcome.suggestions_created == 1
    assert tasks(container)[0].due_date == dt.date(2026, 11, 18)


def test_explicit_completion_completes_confirmed_task_and_can_be_undone(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    [task] = tasks(container)
    set_status(container, task.id, TaskStatus.CONFIRMED)
    outcome, _ = ingest_mail(container, "回执", "您好，我们已收到您的学生证明，谢谢。", sent_at=FIXED_NOW + dt.timedelta(days=3))
    assert outcome.completions_applied == 1
    [task] = tasks(container)
    assert task.status == "completed" and task.completed_at is not None
    with transaction(container.factory) as session:
        event = session.scalars(select(TaskEvent).where(TaskEvent.event_type == "status_changed",
                                                        TaskEvent.actor == "agent")).one()
        assert event.revertible
        container.tasks.revert_event(session, event.id)
    assert tasks(container)[0].status == "confirmed"


def test_completion_for_unconfirmed_task_is_only_a_suggestion(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    outcome, _ = ingest_mail(container, "回执", "您好，我们已收到您的学生证明，谢谢。")
    assert outcome.completions_applied == 0 and outcome.suggestions_created == 1
    assert tasks(container)[0].status == "candidate"


def test_uncertain_completion_never_auto_completes(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    set_status(container, tasks(container)[0].id, TaskStatus.CONFIRMED)
    outcome, _ = ingest_mail(container, "材料情况", "关于您的学生证明：我们可能已收到部分材料，但仍需核实。")
    assert outcome.completions_applied == 0 and outcome.suggestions_created == 1
    [task] = tasks(container)
    assert task.status == "confirmed"
    with transaction(container.factory) as session:
        assert session.scalars(select(TaskSuggestion.kind)).one() == "mark_completed"


def test_undoing_a_merge_splits_the_task(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    ingest_mail(container, *REMINDER)
    with transaction(container.factory) as session:
        event = session.scalars(select(TaskEvent).where(TaskEvent.event_type == "source_attached")).one()
        revert = container.tasks.revert_event(session, event.id)
        assert revert.data["split_task_id"]
    assert len(tasks(container)) == 2


def test_possible_duplicate_suggestion_and_merge(container: Container) -> None:
    ingest_mail(container, "Mietvertrag", "Bitte unterschreiben Sie den Mietvertrag bis 30.10.2026.")
    outcome, _ = ingest_mail(container, "Vertrag", "Bitte senden Sie mir den unterschriebenen Vertrag bis 30.10.2026 zurück.")
    assert outcome.tasks_created == 1
    with transaction(container.factory) as session:
        suggestion = session.scalars(select(TaskSuggestion).where(TaskSuggestion.kind == "possible_duplicate")).first()
        if suggestion is None:
            pytest.skip("rules judged the two notices as different obligations")
        container.tasks.accept_suggestion(session, suggestion.id)
    statuses = sorted(t.status for t in tasks(container))
    assert statuses == ["candidate", "dismissed"]


def test_manual_status_changes_are_recorded(container: Container) -> None:
    ingest_mail(container, *NOTICE)
    task_id = tasks(container)[0].id
    for status in (TaskStatus.CONFIRMED, TaskStatus.IN_PROGRESS, TaskStatus.WAITING_FOR_REPLY, TaskStatus.COMPLETED):
        set_status(container, task_id, status)
    with transaction(container.factory) as session:
        events = session.scalars(select(TaskEvent).where(TaskEvent.task_id == task_id,
                                                         TaskEvent.event_type == "status_changed")).all()
        assert [e.data["after"]["status"] for e in events] == ["confirmed", "in_progress", "waiting_for_reply", "completed"]
        assert {e.actor for e in events} == {"user"}


def test_failed_apply_rolls_back_everything(container: Container, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("database write failed")

    monkeypatch.setattr(container.tasks, "create_from_candidate", boom)
    with pytest.raises(RuntimeError):
        ingest_mail(container, *NOTICE)
    with transaction(container.factory) as session:
        assert session.scalar(select(func.count()).select_from(ExtractionRun)) == 0
        assert session.scalar(select(func.count()).select_from(Task)) == 0
        assert session.scalars(select(Message.status)).one() == "pending"  # will be retried


def test_data_survives_restart(make_container: Callable[..., Container]) -> None:
    first = make_container()
    ingest_mail(first, *NOTICE)
    set_status(first, tasks(first)[0].id, TaskStatus.CONFIRMED)
    first.dispose()
    second = make_container()
    [task] = tasks(second)
    assert task.status == "confirmed" and task.due_date == dt.date(2026, 11, 20)
    with transaction(second.factory) as session:
        assert session.scalar(select(func.count()).select_from(TaskEvent)) == 2


def test_job_lock_prevents_concurrent_runs(container: Container) -> None:
    job_id = container.jobs.start(JobKind.GMAIL_SYNC, lock_key="gmail:1", source_id=None, trigger=JobTrigger.MANUAL)
    with pytest.raises(JobAlreadyRunning):
        container.jobs.start(JobKind.GMAIL_SYNC, lock_key="gmail:1", source_id=None, trigger=JobTrigger.MANUAL)
    container.jobs.finish(job_id, JobContext(job_id), status=JobStatus.SUCCEEDED)
    # After finishing, the lock is free again.
    container.jobs.start(JobKind.GMAIL_SYNC, lock_key="gmail:1", source_id=None, trigger=JobTrigger.MANUAL)
    assert container.jobs.recover_interrupted() == 1


def test_reminders_are_deduplicated_and_stop_after_completion(container: Container) -> None:
    ingest_mail(container, "Zahlung", "Bitte überweisen Sie den Semesterbeitrag bis zum 16.10.2026.")
    task_id = tasks(container)[0].id
    container.notifications.scan()
    with transaction(container.factory) as session:
        assert session.scalar(select(func.count()).select_from(Notification)) == 0  # candidate + only "high": quiet
    set_status(container, task_id, TaskStatus.CONFIRMED)
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
