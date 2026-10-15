"""Task lifecycle service.

Every change is written as a :class:`TaskEvent`. Automatic (agent) changes are revertible:
status changes, field updates, merged duplicate notices (which can be split back into an
independent task) and manual merges.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from taskradar.db.base import utcnow
from taskradar.db.models import Task, TaskCandidate, TaskEvent, TaskLink, TaskSource, TaskSuggestion
from taskradar.deadlines.engine import parse_hhmm
from taskradar.domain.enums import (
    ActionType,
    Actor,
    Category,
    EventType,
    Priority,
    SourceRelation,
    SuggestionKind,
    SuggestionStatus,
    TaskStatus,
    TimeSemantics,
)
from taskradar.domain.schemas import CandidateTask, DueInfo, Evidence, TaskSnapshot
from taskradar.reconciliation.normalize import fingerprint


class TaskError(Exception):
    code = "task_error"
    status_code = 400

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        if code:
            self.code = code


class DueChoiceRequired(TaskError):
    """Two tasks with different deadlines are merged: the user has to say which date is right."""

    code = "due_choice_required"
    status_code = 409


# Everything that describes a task's deadline; a merge may take these over from the merged task.
_MERGE_DUE_FIELDS = (
    "due_date",
    "due_time",
    "due_text",
    "due_precision",
    "due_needs_confirmation",
    "due_anchor",
    "due_is_relative",
    "time_semantics",
)


class TaskNotFound(TaskError):
    code = "task_not_found"
    status_code = 404


class RevertConflict(TaskError):
    code = "revert_conflict"
    status_code = 409


class NotRevertible(TaskError):
    code = "not_revertible"
    status_code = 409


@dataclass
class Origin:
    key: str
    message_id: int | None = None
    document_id: int | None = None
    thread_id: str | None = None
    label: str = ""
    date: dt.datetime | None = None


USER_EDITABLE_FIELDS = {
    "title",
    "description",
    "category",
    "action_required",
    "priority",
    "due_date",
    "due_time",
    "time_semantics",
}
_DUE_FIELDS = {"due_date", "due_time"}
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _jsonable(value: Any) -> Any:
    if isinstance(value, dt.datetime):
        return value.isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    return value


def _from_json(field: str, value: Any) -> Any:
    if value is None:
        return None
    if field == "due_date":
        return dt.date.fromisoformat(value)
    if field in ("confirmed_at", "completed_at", "dismissed_at"):
        return dt.datetime.fromisoformat(value)
    return value


def _status_fields(task: Task) -> dict[str, Any]:
    return {
        "status": task.status,
        "confirmed_at": _jsonable(task.confirmed_at),
        "completed_at": _jsonable(task.completed_at),
        "dismissed_at": _jsonable(task.dismissed_at),
        "needs_review": task.needs_review,
    }


def candidate_from_row(row: TaskCandidate) -> CandidateTask:
    return CandidateTask(
        title=row.title,
        description=row.description,
        category=Category(row.category),
        action_type=ActionType(row.action_type),
        action_required=row.action_required,
        due=DueInfo.model_validate(row.due or {}),
        priority=Priority(row.priority),
        confidence=row.confidence,
        evidence=[Evidence.model_validate(e) for e in row.evidence or []],
        uncertainties=list(row.uncertainties or []),
        entities=list(row.entities or []),
    )


STATUS_LABELS_ZH = {
    "candidate": "待确认",
    "confirmed": "已确认",
    "in_progress": "进行中",
    "waiting_for_reply": "等待回复",
    "completed": "已完成",
    "dismissed": "已忽略",
}


class TaskService:
    def __init__(self, clock: Callable[[], dt.datetime] = utcnow) -> None:
        self.clock = clock

    # ------------------------------------------------------------------------------------------
    # Lookup & snapshots
    # ------------------------------------------------------------------------------------------

    def get(self, session: Session, task_id: str) -> Task:
        task = session.get(Task, task_id)
        if task is None:
            raise TaskNotFound("Task not found")
        return task

    @staticmethod
    def snapshot(task: Task) -> TaskSnapshot:
        try:
            action = ActionType(task.action_type)
        except ValueError:
            action = ActionType.OTHER
        try:
            category = Category(task.category)
        except ValueError:
            category = Category.OTHER
        return TaskSnapshot(
            id=task.id,
            title=task.title,
            description=task.description or "",
            action_type=action,
            category=category,
            entities=list(task.entities or []),
            due_date=task.due_date,
            due_time=parse_hhmm(task.due_time),
            status=task.status,
            origin_keys=[s.origin_key for s in task.sources],
            thread_ids=sorted({s.message.thread_id for s in task.sources if s.message and s.message.thread_id}),
            last_source_at=task.last_source_at,
            user_locked_fields=list(task.user_locked_fields or []),
        )

    def load_snapshots(self, session: Session, since_days: int = 400) -> list[TaskSnapshot]:
        cutoff = self.clock() - dt.timedelta(days=since_days)
        tasks = session.scalars(
            select(Task)
            .options(selectinload(Task.sources).selectinload(TaskSource.message))
            .where(Task.updated_at >= cutoff)
        ).all()
        return [self.snapshot(t) for t in tasks]

    # ------------------------------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------------------------------

    def record(
        self,
        session: Session,
        task: Task,
        event_type: EventType,
        actor: Actor,
        summary: str,
        *,
        data: dict[str, Any] | None = None,
        reason: str | None = None,
        revertible: bool = False,
    ) -> TaskEvent:
        event = TaskEvent(
            task_id=task.id,
            event_type=event_type.value,
            actor=actor.value,
            summary=summary[:1000],
            reason=reason,
            data=data or {},
            revertible=revertible,
            created_at=self.clock(),
        )
        session.add(event)
        session.flush()
        return event

    # ------------------------------------------------------------------------------------------
    # Creation & evidence
    # ------------------------------------------------------------------------------------------

    @staticmethod
    def apply_due(task: Task, due: DueInfo) -> None:
        task.due_date = due.date
        task.due_time = due.time.strftime("%H:%M") if due.time else None
        task.due_precision = due.precision.value
        task.due_text = due.text
        task.due_is_relative = due.is_relative
        task.due_needs_confirmation = due.needs_confirmation
        task.due_anchor = due.anchor.value if due.anchor else None
        task.time_semantics = due.semantics.value

    def create_from_candidate(
        self,
        session: Session,
        cand: CandidateTask,
        *,
        origin: Origin,
        candidate_row: TaskCandidate | None,
        timezone: str,
        review_reasons: list[str],
        actor: Actor = Actor.AGENT,
        status: TaskStatus = TaskStatus.CANDIDATE,
        summary: str | None = None,
    ) -> Task:
        now = self.clock()
        task = Task(
            title=cand.title[:200],
            description=cand.description,
            category=cand.category.value,
            action_type=cand.action_type.value,
            action_required=cand.action_required,
            status=status.value,
            priority=cand.priority.value,
            confidence=cand.confidence,
            timezone=timezone,
            needs_review=bool(review_reasons),
            review_reasons=review_reasons,
            entities=list(cand.entities),
            fingerprint=fingerprint(cand.action_type, cand.entities, cand.title),
            source_published_at=origin.date,
            last_source_at=origin.date,
            detected_at=now,
            created_at=now,
            updated_at=now,
            manual=actor == Actor.USER and origin.key == "manual",
        )
        if status == TaskStatus.CONFIRMED:
            task.confirmed_at = now
        self.apply_due(task, cand.due)
        session.add(task)
        session.flush()
        self._add_source(session, task, origin, candidate_row, SourceRelation.ORIGIN, cand.evidence)
        self.record(
            session,
            task,
            EventType.CREATED,
            actor,
            summary or (f"从「{origin.label}」中识别出任务" if origin.label else "任务已创建"),
            data={"origin": origin.key, "confidence": cand.confidence, "review_reasons": review_reasons},
        )
        if candidate_row is not None:
            candidate_row.task_id = task.id
        return task

    def add_source_evidence(self, session: Session, task: Task, origin_key: str, evidence: list[Evidence]) -> bool:
        """Add evidence found by a re-analysis to the task's existing source(s) for ``origin_key``."""
        changed = False
        for source in session.scalars(
            select(TaskSource).where(TaskSource.task_id == task.id, TaskSource.origin_key == origin_key)
        ):
            current = list(source.evidence or [])
            seen = {(e.get("kind"), e.get("quote")) for e in current}
            added = [e.model_dump(mode="json") for e in evidence if (e.kind, e.quote) not in seen]
            if added:
                source.evidence = [*current, *added]
                changed = True
        return changed

    def _add_source(
        self,
        session: Session,
        task: Task,
        origin: Origin,
        candidate_row: TaskCandidate | None,
        relation: SourceRelation,
        evidence: list[Evidence],
    ) -> TaskSource | None:
        existing = session.scalar(
            select(TaskSource).where(
                TaskSource.task_id == task.id,
                TaskSource.origin_key == origin.key,
                TaskSource.relation == relation.value,
            )
        )
        if existing is not None:
            return None
        source = TaskSource(
            task=task,
            candidate_id=candidate_row.id if candidate_row is not None else None,
            message_id=origin.message_id,
            document_id=origin.document_id,
            origin_key=origin.key,
            relation=relation.value,
            evidence=[e.model_dump(mode="json") for e in evidence],
            source_label=origin.label[:500],
            source_date=origin.date,
            created_at=self.clock(),
        )
        session.add(source)
        session.flush()
        if origin.date and (task.last_source_at is None or origin.date > task.last_source_at):
            task.last_source_at = origin.date
        return source

    def attach_source(
        self,
        session: Session,
        task: Task,
        *,
        origin: Origin,
        candidate_row: TaskCandidate | None,
        relation: SourceRelation,
        evidence: list[Evidence],
        summary: str,
        actor: Actor = Actor.AGENT,
        revertible: bool = True,
    ) -> TaskSource | None:
        source = self._add_source(session, task, origin, candidate_row, relation, evidence)
        if source is None:
            return None
        self.record(
            session,
            task,
            EventType.SOURCE_ATTACHED,
            actor,
            summary,
            data={
                "task_source_id": source.id,
                "relation": relation.value,
                "origin": origin.key,
                "candidate_id": candidate_row.id if candidate_row else None,
            },
            revertible=revertible,
        )
        if candidate_row is not None:
            candidate_row.task_id = task.id
        task.updated_at = self.clock()
        return source

    # ------------------------------------------------------------------------------------------
    # Mutations
    # ------------------------------------------------------------------------------------------

    def change_status(
        self,
        session: Session,
        task: Task,
        new_status: TaskStatus,
        *,
        actor: Actor,
        reason: str | None = None,
        summary: str | None = None,
        revertible: bool = True,
        extra_data: dict[str, Any] | None = None,
    ) -> TaskEvent | None:
        if task.status == new_status.value:
            return None
        before = _status_fields(task)
        now = self.clock()
        task.status = new_status.value
        if new_status == TaskStatus.CONFIRMED and task.confirmed_at is None:
            task.confirmed_at = now
        if new_status == TaskStatus.COMPLETED:
            task.completed_at = now
        elif new_status != TaskStatus.DISMISSED:
            task.completed_at = None
        if new_status == TaskStatus.DISMISSED:
            task.dismissed_at = now
        else:
            task.dismissed_at = None
        if actor == Actor.USER and new_status != TaskStatus.CANDIDATE:
            task.needs_review = False
        task.updated_at = now
        after = _status_fields(task)
        label = summary or (
            f"状态：{STATUS_LABELS_ZH.get(before['status'], before['status'])} → "
            f"{STATUS_LABELS_ZH.get(new_status.value, new_status.value)}"
        )
        return self.record(
            session,
            task,
            EventType.STATUS_CHANGED,
            actor,
            label,
            data={"before": before, "after": after, **(extra_data or {})},
            reason=reason,
            revertible=revertible,
        )

    def update_fields(
        self,
        session: Session,
        task: Task,
        changes: dict[str, Any],
        *,
        actor: Actor,
        reason: str | None = None,
        lock: bool = False,
        revertible: bool = True,
        summary: str | None = None,
        due_text: str | None = None,
    ) -> TaskEvent | None:
        normalized: dict[str, Any] = {}
        for key, value in changes.items():
            if key not in USER_EDITABLE_FIELDS:
                raise TaskError(f"Field {key} cannot be edited", code="field_not_editable")
            normalized[key] = self._normalize_field(key, value)
        before: dict[str, Any] = {}
        after: dict[str, Any] = {}
        for key, value in normalized.items():
            current = getattr(task, key)
            if current == value:
                continue
            before[key] = _jsonable(current)
            after[key] = _jsonable(value)
            setattr(task, key, value)
        if not after:
            return None
        if _DUE_FIELDS & set(after):
            for key in ("due_precision", "due_needs_confirmation", "due_text", "due_anchor", "due_is_relative"):
                before[key] = getattr(task, key)
            task.due_precision = "none" if task.due_date is None else ("date" if task.due_time is None else "datetime")
            if task.due_date is None:
                task.due_time = None
            task.due_version += 1
            if actor == Actor.USER:
                task.due_needs_confirmation = False
                task.due_anchor = None
                task.due_is_relative = False
            if due_text is not None:
                task.due_text = due_text
            for key in ("due_precision", "due_needs_confirmation", "due_text", "due_anchor", "due_is_relative"):
                after[key] = getattr(task, key)
        if lock and actor == Actor.USER:
            locked = set(task.user_locked_fields or [])
            locked.update("due" if k in _DUE_FIELDS else k for k in after if k in USER_EDITABLE_FIELDS)
            task.user_locked_fields = sorted(locked)
        if {"title", "action_required"} & set(after):
            with contextlib.suppress(ValueError):  # unknown legacy action type: keep the old fingerprint
                task.fingerprint = fingerprint(ActionType(task.action_type), list(task.entities or []), task.title)
        task.updated_at = self.clock()
        names = ", ".join(k for k in after if k in USER_EDITABLE_FIELDS)
        return self.record(
            session,
            task,
            EventType.FIELDS_UPDATED,
            actor,
            summary or f"修改了 {names}",
            data={"before": before, "after": after},
            reason=reason,
            revertible=revertible,
        )

    @staticmethod
    def _normalize_field(key: str, value: Any) -> Any:
        if key == "title":
            value = (value or "").strip()
            if not value:
                raise TaskError("Title must not be empty", code="invalid_title")
            return value[:200]
        if key == "due_date":
            if value in (None, ""):
                return None
            return value if isinstance(value, dt.date) else dt.date.fromisoformat(str(value))
        if key == "due_time":
            if value in (None, ""):
                return None
            value = value.strftime("%H:%M") if isinstance(value, dt.time) else str(value)
            if not _HHMM.match(value):
                raise TaskError("Time must be HH:MM", code="invalid_time")
            return value
        if key == "category":
            return Category(value).value
        if key == "priority":
            return Priority(value).value
        if key == "time_semantics":
            return TimeSemantics(value).value
        return value or ""

    # ------------------------------------------------------------------------------------------
    # Undo
    # ------------------------------------------------------------------------------------------

    def revert_event(self, session: Session, event_id: int, *, actor: Actor = Actor.USER) -> TaskEvent:
        event = session.get(TaskEvent, event_id)
        if event is None:
            raise TaskError("Event not found", code="event_not_found")
        if not event.revertible:
            raise NotRevertible("This change cannot be undone")
        if event.reverted_at is not None:
            raise RevertConflict("This change was already undone")
        task = event.task
        data = event.data or {}
        extra: dict[str, Any] = {}

        if event.event_type == EventType.STATUS_CHANGED.value:
            if task.status != data["after"]["status"]:
                raise RevertConflict("The status has changed since; undo is no longer possible")
            for key, value in data["before"].items():
                setattr(task, key, _from_json(key, value))
        elif event.event_type == EventType.FIELDS_UPDATED.value:
            for key, value in data["after"].items():
                if _jsonable(getattr(task, key)) != value:
                    raise RevertConflict(f"Field {key} has changed since; undo is no longer possible")
            for key, value in data["before"].items():
                setattr(task, key, _from_json(key, value))
            if _DUE_FIELDS & set(data["after"]):
                task.due_version += 1
        elif event.event_type == EventType.SOURCE_ATTACHED.value:
            new_task = self._detach_source(session, task, data)
            if new_task is not None:
                extra["split_task_id"] = new_task.id
        elif event.event_type == EventType.MERGED.value:
            self._unmerge(session, task, data)
        elif event.event_type == EventType.SUGGESTION_RESOLVED.value:
            self._reopen_suggestion(session, task, data, actor=actor)
        else:
            raise NotRevertible("This change cannot be undone")

        now = self.clock()
        task.updated_at = now
        event.reverted_at = now
        revert = self.record(
            session,
            task,
            EventType.REVERTED,
            actor,
            f"已撤销：{event.summary}",
            data={"reverted_event_id": event.id, **extra},
        )
        event.reverted_by_event_id = revert.id
        return revert

    def _reopen_suggestion(self, session: Session, task: Task, data: dict[str, Any], *, actor: Actor) -> None:
        """Undo a decision on a suggestion: revert what accepting it changed and make it pending again."""
        suggestion = session.get(TaskSuggestion, data.get("suggestion_id"))
        if suggestion is None:
            raise RevertConflict("The suggestion no longer exists")
        decided = SuggestionStatus.ACCEPTED.value if data.get("accepted") else SuggestionStatus.REJECTED.value
        allowed = (decided, SuggestionStatus.OBSOLETE.value, SuggestionStatus.PENDING.value)
        if suggestion.status not in allowed:
            raise RevertConflict("The suggestion was decided again since; undo is no longer possible")
        applied_id = data.get("applied_event_id")
        if applied_id is not None:
            applied = session.get(TaskEvent, applied_id)
            if applied is not None and applied.reverted_at is None:
                self.revert_event(session, applied_id, actor=actor)  # RevertConflict if the task changed since
        suggestion.status = SuggestionStatus.PENDING.value
        suggestion.resolved_at = None
        cleared = [r for r in data.get("cleared_review_reasons", []) if r not in (task.review_reasons or [])]
        if cleared:
            task.review_reasons = [*(task.review_reasons or []), *cleared]
            task.needs_review = bool(data.get("needs_review_before", True))

    def _detach_source(self, session: Session, task: Task, data: dict[str, Any]) -> Task | None:
        source = session.get(TaskSource, data.get("task_source_id"))
        if source is None or source.task_id != task.id:
            raise RevertConflict("The attached source no longer exists")
        relation = source.relation
        candidate = session.get(TaskCandidate, source.candidate_id) if source.candidate_id else None
        origin = Origin(
            key=source.origin_key,
            message_id=source.message_id,
            document_id=source.document_id,
            label=source.source_label,
            date=source.source_date,
        )
        task.sources.remove(source)
        session.delete(source)
        session.flush()
        if (
            relation in (SourceRelation.DUPLICATE.value, SourceRelation.DEADLINE_UPDATE.value)
            and candidate is not None
            and candidate.kind == "task"
        ):
            cand = candidate_from_row(candidate)
            new_task = self.create_from_candidate(
                session,
                cand,
                origin=origin,
                candidate_row=candidate,
                timezone=task.timezone,
                review_reasons=["split_from_merge"],
                actor=Actor.USER,
                summary=f"从「{task.title}」拆分为独立任务",
            )
            candidate.decision = "split_by_user"
            return new_task
        return None

    # ------------------------------------------------------------------------------------------
    # Merge
    # ------------------------------------------------------------------------------------------

    def merge_tasks(
        self,
        session: Session,
        source: Task,
        target: Task,
        *,
        actor: Actor = Actor.USER,
        due_choice: str | None = None,
    ) -> TaskEvent:
        """Merge ``source`` into ``target``; ``target`` stays, ``source`` is dismissed and its sources move over.

        If ``source`` has a different deadline, ``due_choice`` must say which one is right ("existing" keeps the
        target's date, "new" takes the source's). A deadline is never overwritten or dropped silently.
        """
        if source.id == target.id:
            raise TaskError("A task cannot be merged into itself", code="invalid_merge")
        conflict = source.due_date is not None and (source.due_date, source.due_time) != (
            target.due_date,
            target.due_time,
        )
        if conflict and due_choice not in ("existing", "new"):
            raise DueChoiceRequired("The tasks have different deadlines; choose which one to keep")
        target_due_before: dict[str, Any] | None = None
        if conflict and due_choice == "new":
            target_due_before = {k: _jsonable(getattr(target, k)) for k in _MERGE_DUE_FIELDS}
            for key in _MERGE_DUE_FIELDS:
                setattr(target, key, getattr(source, key))
            target.due_version += 1
            target.user_locked_fields = sorted(set(target.user_locked_fields or []) | {"due"})  # chosen by the user
        existing_keys = {(s.origin_key, s.relation) for s in target.sources}
        moved: list[int] = []
        for ts in list(source.sources):
            if (ts.origin_key, ts.relation) in existing_keys:
                continue
            ts.task = target
            moved.append(ts.id)
        before_status = _status_fields(source)
        now = self.clock()
        source.status = TaskStatus.DISMISSED.value
        source.dismissed_at = now
        source.updated_at = now
        target.updated_at = now
        session.add(TaskLink(task_id=source.id, other_task_id=target.id, kind="merged_into", created_at=now))
        closed: list[int] = []
        for sugg in session.scalars(
            select(TaskSuggestion).where(
                TaskSuggestion.status == SuggestionStatus.PENDING.value,
                TaskSuggestion.kind == SuggestionKind.POSSIBLE_DUPLICATE.value,
                ((TaskSuggestion.task_id == source.id) & (TaskSuggestion.related_task_id == target.id))
                | ((TaskSuggestion.task_id == target.id) & (TaskSuggestion.related_task_id == source.id)),
            )
        ):
            sugg.status = SuggestionStatus.OBSOLETE.value
            sugg.resolved_at = now
            closed.append(sugg.id)
        self.record(
            session,
            source,
            EventType.STATUS_CHANGED,
            actor,
            f"已合并到任务「{target.title}」",
            data={"before": before_status, "after": _status_fields(source), "merged_into": target.id},
        )
        return self.record(
            session,
            target,
            EventType.MERGED,
            actor,
            f"合并了任务「{source.title}」" + ("，并采用了它的截止日期" if target_due_before else ""),
            data={
                "merged_task_id": source.id,
                "moved_source_ids": moved,
                "source_before": before_status,
                "due_choice": due_choice if conflict else None,
                "target_due_before": target_due_before,
                "closed_suggestion_ids": closed,
            },
            revertible=True,
        )

    def _unmerge(self, session: Session, target: Task, data: dict[str, Any]) -> None:
        source = session.get(Task, data["merged_task_id"])
        if source is None:
            raise RevertConflict("The merged task no longer exists")
        for ts_id in data.get("moved_source_ids", []):
            ts = session.get(TaskSource, ts_id)
            if ts is not None and ts.task_id == target.id:
                ts.task = source
        for key, value in data.get("source_before", {}).items():
            setattr(source, key, _from_json(key, value))
        link = session.scalar(
            select(TaskLink).where(
                TaskLink.task_id == source.id, TaskLink.other_task_id == target.id, TaskLink.kind == "merged_into"
            )
        )
        if link is not None:
            session.delete(link)
        if data.get("target_due_before"):
            for key, value in data["target_due_before"].items():
                setattr(target, key, _from_json(key, value))
            target.due_version += 1
        # The duplicate question is open again: the user can decide anew.
        for sugg_id in data.get("closed_suggestion_ids", []):
            sugg = session.get(TaskSuggestion, sugg_id)
            if sugg is not None and sugg.status in (SuggestionStatus.OBSOLETE.value, SuggestionStatus.ACCEPTED.value):
                sugg.status = SuggestionStatus.PENDING.value
                sugg.resolved_at = None
        source.updated_at = self.clock()

    def link_tasks(self, session: Session, task: Task, other: Task, kind: str = "related") -> None:
        exists = session.scalar(
            select(TaskLink.id).where(
                TaskLink.task_id == task.id, TaskLink.other_task_id == other.id, TaskLink.kind == kind
            )
        )
        if exists is None:
            session.add(TaskLink(task_id=task.id, other_task_id=other.id, kind=kind, created_at=self.clock()))
            self.record(
                session, task, EventType.LINKED, Actor.AGENT, f"与任务「{other.title}」相关", data={"other": other.id}
            )

    # ------------------------------------------------------------------------------------------
    # Suggestions
    # ------------------------------------------------------------------------------------------

    def suggest(
        self,
        session: Session,
        task: Task,
        *,
        kind: SuggestionKind,
        payload: dict[str, Any],
        evidence: list[Evidence],
        confidence: float,
        reason: str,
        dedupe_key: str,
        candidate_row: TaskCandidate | None = None,
        related_task_id: str | None = None,
        summary: str,
    ) -> TaskSuggestion | None:
        if session.scalar(select(TaskSuggestion.id).where(TaskSuggestion.dedupe_key == dedupe_key)) is not None:
            return None
        suggestion = TaskSuggestion(
            task_id=task.id,
            kind=kind.value,
            payload=payload,
            evidence=[e.model_dump(mode="json") for e in evidence],
            confidence=confidence,
            reason=reason[:2000],
            status=SuggestionStatus.PENDING.value,
            dedupe_key=dedupe_key[:255],
            candidate_id=candidate_row.id if candidate_row else None,
            related_task_id=related_task_id,
            created_at=self.clock(),
        )
        session.add(suggestion)
        session.flush()
        self.record(
            session,
            task,
            EventType.SUGGESTION_CREATED,
            Actor.AGENT,
            summary,
            data={"suggestion_id": suggestion.id, "kind": kind.value},
        )
        task.updated_at = self.clock()
        return suggestion

    def accept_suggestion(
        self, session: Session, suggestion_id: int, *, actor: Actor = Actor.USER, due_choice: str | None = None
    ) -> TaskSuggestion:
        suggestion = self._pending_suggestion(session, suggestion_id)
        task = suggestion.task
        kind = SuggestionKind(suggestion.kind)
        applied: TaskEvent | None = None
        if kind == SuggestionKind.MARK_COMPLETED:
            applied = self.change_status(session, task, TaskStatus.COMPLETED, actor=actor, reason="accepted_suggestion")
        elif kind == SuggestionKind.MARK_DISMISSED:
            applied = self.change_status(session, task, TaskStatus.DISMISSED, actor=actor, reason="accepted_suggestion")
        elif kind == SuggestionKind.MARK_WAITING:
            applied = self.change_status(
                session, task, TaskStatus.WAITING_FOR_REPLY, actor=actor, reason="accepted_suggestion"
            )
        elif kind == SuggestionKind.UPDATE_DUE:
            applied = self.update_fields(
                session,
                task,
                {"due_date": suggestion.payload.get("due_date"), "due_time": suggestion.payload.get("due_time")},
                actor=actor,
                reason="accepted_suggestion",
                due_text=suggestion.payload.get("due_text"),
                summary="根据新来源更新截止日期",
            )
        elif kind == SuggestionKind.POSSIBLE_DUPLICATE:
            other = session.get(Task, suggestion.related_task_id) if suggestion.related_task_id else None
            if other is None:
                raise TaskError("The related task no longer exists", code="related_task_missing")
            applied = self.merge_tasks(session, task, other, actor=actor, due_choice=due_choice)
        suggestion.status = SuggestionStatus.ACCEPTED.value
        suggestion.resolved_at = self.clock()
        self.record(
            session,
            task,
            EventType.SUGGESTION_RESOLVED,
            actor,
            "已采纳建议",
            data={
                "suggestion_id": suggestion.id,
                "kind": kind.value,
                "accepted": True,
                "applied_event_id": applied.id if applied is not None else None,
            },
            revertible=True,
        )
        return suggestion

    def reject_suggestion(self, session: Session, suggestion_id: int, *, actor: Actor = Actor.USER) -> TaskSuggestion:
        suggestion = self._pending_suggestion(session, suggestion_id)
        suggestion.status = SuggestionStatus.REJECTED.value
        suggestion.resolved_at = self.clock()
        task = suggestion.task
        data: dict[str, Any] = {"suggestion_id": suggestion.id, "kind": suggestion.kind, "accepted": False}
        if suggestion.kind == SuggestionKind.POSSIBLE_DUPLICATE.value and "possible_duplicate" in (
            task.review_reasons or []
        ):
            still_open = session.scalar(
                select(TaskSuggestion.id).where(
                    TaskSuggestion.task_id == task.id,
                    TaskSuggestion.kind == SuggestionKind.POSSIBLE_DUPLICATE.value,
                    TaskSuggestion.status == SuggestionStatus.PENDING.value,
                    TaskSuggestion.id != suggestion.id,
                )
            )
            if still_open is None:
                data["cleared_review_reasons"] = ["possible_duplicate"]
                data["needs_review_before"] = task.needs_review
                task.review_reasons = [r for r in task.review_reasons if r != "possible_duplicate"]
                task.needs_review = task.needs_review and bool(task.review_reasons)
        self.record(
            session,
            task,
            EventType.SUGGESTION_RESOLVED,
            actor,
            "保留为独立任务" if suggestion.kind == SuggestionKind.POSSIBLE_DUPLICATE.value else "已拒绝建议",
            data=data,
            revertible=True,
        )
        return suggestion

    @staticmethod
    def _pending_suggestion(session: Session, suggestion_id: int) -> TaskSuggestion:
        suggestion = session.get(TaskSuggestion, suggestion_id)
        if suggestion is None:
            raise TaskError("Suggestion not found", code="suggestion_not_found")
        if suggestion.status != SuggestionStatus.PENDING.value:
            raise TaskError("Suggestion was already resolved", code="suggestion_resolved")
        return suggestion
