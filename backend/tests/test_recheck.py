"""Re-checking old tasks with the current rules: finds leftovers of older rules, changes nothing."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select

from taskradar.container import Container
from taskradar.db.models import Task, TaskEvent
from taskradar.db.session import transaction
from taskradar.domain.enums import ActionType, Actor, Category, SourceKind, SourceRelation, TaskStatus
from taskradar.domain.schemas import CandidateTask, DueInfo, NormalizedMessage
from taskradar.services.documents import get_or_create_source
from taskradar.services.tasks import Origin

from .test_lifecycle import NOTICE, ingest_mail


def _store_mail(c: Container, key: str, subject: str, body: str) -> int:
    with transaction(c.factory) as session:
        source = get_or_create_source(session, SourceKind.UPLOAD, "tests")
        message, _ = c.documents.store_message(
            session,
            NormalizedMessage(external_id=key, subject=subject, sender="x@example.com", body_text=body),
            source=source,
            web_link=None,
        )
        message.status = "processed"
        message.extractor_version = "rules:rules-1.3"
        return message.id


def _old_task(c: Container, title: str, message_ids: list[int]) -> str:
    """A task as an older rule version created it, with the given mails as its evidence."""
    with transaction(c.factory) as session:
        cand = CandidateTask(
            title=title,
            category=Category.OTHER,
            action_type=ActionType.REPLY,
            action_required=title,
            confidence=0.7,
            due=DueInfo(),
        )
        first, *rest = message_ids
        task = c.tasks.create_from_candidate(
            session,
            cand,
            origin=Origin(key=f"message:{first}", message_id=first, label="old"),
            candidate_row=None,
            timezone="Europe/Berlin",
            review_reasons=[],
        )
        for mid in rest:
            c.tasks.attach_source(
                session,
                task,
                origin=Origin(key=f"message:{mid}", message_id=mid, label="old"),
                candidate_row=None,
                relation=SourceRelation.DUPLICATE,
                evidence=[],
                summary="merged",
            )
        c.tasks.change_status(
            session,
            task,
            TaskStatus.CONFIRMED,
            actor=Actor.USER,
        )
        return task.id


def _run(c: Container) -> dict[str, Any]:
    return c.recheck.run(serialize=lambda t: {"id": t.id, "title": t.title, "created_at": t.created_at.isoformat()})


def test_recheck_finds_leftovers_of_older_rules_and_changes_nothing(container: Container) -> None:
    ingest_mail(container, *NOTICE)  # a task the current rules still find
    footer = _store_mail(
        container,
        "ticket",
        "[Ticket #4711] Update",
        "##- Please type your reply above this line -##\n\nYour request has been updated.\n\n"
        "This email was sent automatically. Please do not reply.",
    )
    reply_task = _old_task(container, "Reply above this line", [footer])
    merged = [
        _store_mail(container, f"m{i}", subject, body)
        for i, (subject, body) in enumerate(
            [
                ("Konto", "Bitte bestätigen Sie Ihre E-Mail-Adresse bis zum 20.11.2026."),
                ("Bestellung", "Ihre Bestellung wurde versandt."),
                ("Newsletter", "Unsere neuen Angebote sind da."),
            ]
        )
    ]
    overmerged = _old_task(container, "E-Mail-Adresse bestätigen", merged)
    with transaction(container.factory) as session:
        events_before = session.scalar(select(func.count()).select_from(TaskEvent))

    result = _run(container)
    verdicts = {item["task"]["id"]: item for item in result["items"]}
    assert verdicts[reply_task]["verdict"] == "not_found"
    assert verdicts[reply_task]["extracted_by"] == ["rules:rules-1.3"]
    assert verdicts[overmerged]["verdict"] == "overmerged"
    assert (verdicts[overmerged]["sources_total"], verdicts[overmerged]["sources_supporting"]) == (3, 1)
    assert len(result["items"]) == 2 and result["checked"] == 3  # the current notice is fine

    with transaction(container.factory) as session:  # read-only
        assert session.scalar(select(func.count()).select_from(TaskEvent)) == events_before
        assert {t.status for t in session.scalars(select(Task))} == {"candidate", "confirmed"}


def test_recheck_endpoint_skips_manual_and_test_tasks(api: Any) -> None:
    api.post("/api/tasks", json={"title": "Reply above this line"})  # typed by the user: never questioned
    response = api.get("/api/review/recheck")
    assert response.status_code == 200
    body = response.json()
    assert body["items"] == [] and body["checked"] == 0 and body["rules_version"].startswith("rules-")
