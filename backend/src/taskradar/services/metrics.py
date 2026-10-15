"""Observability metrics computed from real local data (never estimated or invented).

Demo and test data (sample sources and sample tasks) are left out of every figure.

* processing success rate (documents / messages)
* agent runs: average latency, fallbacks, token usage and estimated cost
* deduplication: merged duplicates, merges undone by the user (wrong-merge rate)
* user feedback on agent-created tasks: confirmed vs. dismissed (precision proxy); a task the user merged into
  another one is a missed duplicate, not a rejected extraction, and is counted separately
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.db.models import (
    Document,
    ExtractionRun,
    Message,
    Source,
    Task,
    TaskEvent,
    TaskLink,
    TaskSource,
    TaskSuggestion,
)
from taskradar.db.session import transaction
from taskradar.domain.enums import SAMPLE_SOURCE_KINDS


def _rate(part: int, total: int) -> float | None:
    return round(part / total, 4) if total else None


class MetricsService:
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._factory = session_factory

    def summary(self) -> dict[str, Any]:
        sample_sources = select(Source.id).where(Source.kind.in_(SAMPLE_SOURCE_KINDS))
        real_docs = Document.source_id.not_in(sample_sources)
        real_msgs = Message.source_id.not_in(sample_sources)
        real_runs = or_(
            ExtractionRun.message_id.in_(select(Message.id).where(real_msgs)),
            ExtractionRun.document_id.in_(select(Document.id).where(real_docs)),
        )
        real_tasks = Task.sample.is_(False)
        with transaction(self._factory) as session:
            doc_counts = dict(
                session.execute(select(Document.status, func.count()).where(real_docs).group_by(Document.status)).all()
            )
            msg_counts = dict(
                session.execute(select(Message.status, func.count()).where(real_msgs).group_by(Message.status)).all()
            )
            doc_total = sum(doc_counts.values())
            msg_total = sum(msg_counts.values())

            runs = session.execute(
                select(
                    func.count(ExtractionRun.id),
                    func.avg(ExtractionRun.latency_ms),
                    func.sum(ExtractionRun.input_tokens),
                    func.sum(ExtractionRun.output_tokens),
                    func.sum(ExtractionRun.cost_usd),
                ).where(real_runs)
            ).one()
            by_extractor = [
                {"extractor": name, "runs": count, "avg_latency_ms": round(avg or 0, 1)}
                for name, count, avg in session.execute(
                    select(ExtractionRun.extractor, func.count(), func.avg(ExtractionRun.latency_ms))
                    .where(real_runs)
                    .group_by(ExtractionRun.extractor)
                ).all()
            ]
            fallbacks = session.scalar(select(func.count()).where(ExtractionRun.status == "fallback", real_runs)) or 0
            llm_runs = session.scalar(select(func.count()).where(ExtractionRun.provider.isnot(None), real_runs)) or 0
            avg_doc_ms = session.scalar(
                select(func.avg(Document.processing_ms)).where(Document.processing_ms.isnot(None), real_docs)
            )

            duplicates = (
                session.scalar(
                    select(func.count())
                    .select_from(TaskSource)
                    .join(Task, Task.id == TaskSource.task_id)
                    .where(TaskSource.relation == "duplicate", real_tasks)
                )
                or 0
            )
            reverted_merges = (
                session.scalar(
                    select(func.count())
                    .select_from(TaskEvent)
                    .join(Task, Task.id == TaskEvent.task_id)
                    .where(
                        TaskEvent.event_type == "source_attached",
                        TaskEvent.reverted_at.isnot(None),
                        real_tasks,
                    )
                )
                or 0
            )
            dup_suggestions = dict(
                session.execute(
                    select(TaskSuggestion.status, func.count())
                    .join(Task, Task.id == TaskSuggestion.task_id)
                    .where(TaskSuggestion.kind == "possible_duplicate", real_tasks)
                    .group_by(TaskSuggestion.status)
                ).all()
            )

            agent_tasks = select(Task).where(Task.manual.is_(False), real_tasks)
            status_counts = dict(
                session.execute(
                    select(Task.status, func.count()).where(Task.manual.is_(False), real_tasks).group_by(Task.status)
                ).all()
            )
            total_tasks = session.scalar(select(func.count()).select_from(agent_tasks.subquery())) or 0
            accepted = sum(
                status_counts.get(s, 0) for s in ("confirmed", "in_progress", "waiting_for_reply", "completed")
            )
            # Merging a duplicate dismisses it; that is a deduplication miss, not a rejected extraction.
            merged_away = (
                session.scalar(
                    select(func.count(func.distinct(Task.id)))
                    .join(TaskLink, TaskLink.task_id == Task.id)
                    .where(
                        Task.manual.is_(False), real_tasks, Task.status == "dismissed", TaskLink.kind == "merged_into"
                    )
                )
                or 0
            )
            dismissed = status_counts.get("dismissed", 0) - merged_away
            auto_completed = (
                session.scalar(
                    select(func.count())
                    .select_from(TaskEvent)
                    .join(Task, Task.id == TaskEvent.task_id)
                    .where(TaskEvent.event_type == "status_changed", TaskEvent.actor == "agent", real_tasks)
                )
                or 0
            )
            auto_completed_reverted = (
                session.scalar(
                    select(func.count())
                    .select_from(TaskEvent)
                    .join(Task, Task.id == TaskEvent.task_id)
                    .where(
                        TaskEvent.event_type == "status_changed",
                        TaskEvent.actor == "agent",
                        TaskEvent.reverted_at.isnot(None),
                        real_tasks,
                    )
                )
                or 0
            )

        return {
            "documents": {
                "total": doc_total,
                "by_status": doc_counts,
                "success_rate": _rate(doc_counts.get("processed", 0) + doc_counts.get("skipped", 0), doc_total),
                "avg_processing_ms": round(avg_doc_ms, 1) if avg_doc_ms else None,
            },
            "messages": {
                "total": msg_total,
                "by_status": msg_counts,
                "success_rate": _rate(msg_counts.get("processed", 0) + msg_counts.get("skipped", 0), msg_total),
            },
            "agent": {
                "runs": runs[0] or 0,
                "avg_latency_ms": round(runs[1], 1) if runs[1] else None,
                "llm_runs": llm_runs,
                "llm_fallbacks": fallbacks,
                "input_tokens": int(runs[2] or 0),
                "output_tokens": int(runs[3] or 0),
                "estimated_cost_usd": round(float(runs[4] or 0), 6),
                "by_extractor": by_extractor,
            },
            "dedup": {
                "duplicates_merged": duplicates,
                "merges_undone": reverted_merges,
                "wrong_merge_rate": _rate(reverted_merges, duplicates),
                "possible_duplicate_suggestions": dup_suggestions,
                "duplicate_rate": _rate(duplicates, duplicates + total_tasks),
            },
            "feedback": {
                "agent_tasks": total_tasks,
                "by_status": status_counts,
                "accepted": accepted,
                "dismissed": dismissed,
                "merged_into_other": merged_away,
                "precision_proxy": _rate(accepted, accepted + dismissed),
                "automatic_status_changes": auto_completed,
                "automatic_status_changes_undone": auto_completed_reverted,
            },
        }
