"""Task reconciliation: decide whether a new candidate is a duplicate, an update or a new task.

Layer 1 - deterministic: same source item (message / file hash), same mail thread.
Layer 2 - normalised comparison: canonical entities, action type, title text, deadline.
Layer 3 - semantic judge (optional LLM) for the grey zone only.

Without a judge, grey-zone matches never merge silently; they become *possible duplicates* that
the user resolves in the inbox.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Literal, Protocol

from taskradar.domain.enums import ACTIVE_STATUSES, MatchRelation, RelationHint
from taskradar.domain.schemas import CandidateTask, CompletionSignal, MatchDecision, TaskSnapshot
from taskradar.extraction.dates import find_dates
from taskradar.reconciliation.normalize import action_similarity, entity_similarity, object_overlap, text_similarity


@dataclass(frozen=True)
class ReconcileConfig:
    same_threshold: float = 0.70
    gray_threshold: float = 0.45
    completion_threshold: float = 0.55
    completion_margin: float = 0.08
    recurring_gap_days: int = 120


@dataclass(frozen=True)
class JudgeVerdict:
    relation: Literal["same_task", "related", "different"]
    confidence: float
    reason: str


class RelationJudge(Protocol):
    def judge(self, candidate: CandidateTask, task: TaskSnapshot) -> JudgeVerdict | None: ...


def _task_text(task: TaskSnapshot) -> str:
    return f"{task.title} {task.description[:300]}"


class Reconciler:
    def __init__(self, config: ReconcileConfig | None = None, judge: RelationJudge | None = None) -> None:
        self.config = config or ReconcileConfig()
        self.judge = judge

    # -----------------------------------------------------------------------------------------

    def content_score(self, cand: CandidateTask, task: TaskSnapshot) -> tuple[float, list[str]]:
        ent = entity_similarity(cand.entities, task.entities)
        act = action_similarity(cand.action_type, task.action_type)
        cand_text = f"{cand.title} {cand.action_required}"
        txt = text_similarity(cand_text, _task_text(task))
        # The object may be named in a neighbouring sentence ("... für die Rechnung Nr. 4711 ...").
        obj = object_overlap(f"{cand_text} {cand.description[:600]}", f"{task.title} {task.description[:600]}")
        reasons = [f"entities={ent if ent is None else round(ent, 2)}", f"action={act:.2f}", f"text={txt:.2f}",
                   f"object={obj:.2f}"]
        txt = max(txt, obj)
        if ent is None:
            # Without specific entities the action type alone must not create a match.
            score = 0.65 * txt + 0.35 * act * min(1.0, txt * 2.5)
        elif ent == 0.0:
            # Both sides name specific, different objects (e.g. tuition fee vs. residence permit).
            score = min(0.3, 0.3 * txt + 0.1 * act)
            reasons.append("different_objects")
        else:
            score = 0.5 * ent + 0.3 * txt + 0.2 * act
        return round(score, 3), reasons

    def match_task(
        self,
        cand: CandidateTask,
        *,
        origin_key: str,
        thread_id: str | None,
        source_date: dt.datetime | None,
        existing: list[TaskSnapshot],
    ) -> MatchDecision:
        best: tuple[float, TaskSnapshot, list[str], str] | None = None
        for task in existing:
            score, reasons = self.content_score(cand, task)
            layer = "normalized"
            if origin_key in task.origin_keys:
                if score >= 0.5:
                    return MatchDecision(
                        relation=MatchRelation.SAME_ORIGIN, task_id=task.id, score=1.0, layer="deterministic",
                        reasons=["same_source_item", *reasons],
                    )
                continue  # a different task extracted from the same item
            if (
                thread_id
                and thread_id in task.thread_ids
                and score >= 0.35
                and action_similarity(cand.action_type, task.action_type) >= 0.5
                and entity_similarity(cand.entities, task.entities) != 0.0  # None (unknown) is fine
            ):
                score = max(score, self.config.same_threshold + 0.05)
                reasons.append("same_mail_thread")
                layer = "deterministic"
            if best is None or score > best[0]:
                best = (score, task, reasons, layer)

        if best is None:
            return MatchDecision(relation=MatchRelation.NEW, score=0.0, reasons=["no_existing_tasks"])
        score, task, reasons, layer = best

        if score >= self.config.same_threshold:
            return self._same_task_relation(cand, task, source_date, score, layer, reasons)

        if score >= self.config.gray_threshold:
            if self.judge is not None:
                verdict = self.judge.judge(cand, task)
                if verdict is not None:
                    reasons = [*reasons, f"judge={verdict.relation}:{verdict.confidence:.2f}", verdict.reason[:200]]
                    if verdict.relation == "same_task" and verdict.confidence >= 0.7:
                        return self._same_task_relation(cand, task, source_date, score, "semantic", reasons)
                    if verdict.relation == "related" and verdict.confidence >= 0.6:
                        return MatchDecision(
                            relation=MatchRelation.RELATED, task_id=task.id, score=score, layer="semantic", reasons=reasons
                        )
                    return MatchDecision(relation=MatchRelation.NEW, score=score, layer="semantic", reasons=reasons)
            same_or_unknown_date = cand.due.date is None or task.due_date is None or cand.due.date == task.due_date
            refers_back = cand.relation_hint in (RelationHint.REMINDER, RelationHint.DEADLINE_CHANGE)
            if same_or_unknown_date or refers_back:
                return MatchDecision(
                    relation=MatchRelation.POSSIBLE_DUPLICATE, task_id=task.id, score=score, layer="normalized",
                    reasons=[*reasons, "grey_zone_needs_user_decision"],
                )
            return MatchDecision(
                relation=MatchRelation.NEW, score=score, layer="normalized",
                reasons=[*reasons, "similar_but_different_deadline"],
            )
        return MatchDecision(relation=MatchRelation.NEW, score=score, layer="normalized", reasons=reasons)

    def _same_task_relation(
        self,
        cand: CandidateTask,
        task: TaskSnapshot,
        source_date: dt.datetime | None,
        score: float,
        layer: str,
        reasons: list[str],
    ) -> MatchDecision:
        def decision(relation: MatchRelation, *extra: str) -> MatchDecision:
            return MatchDecision(
                relation=relation, task_id=task.id, score=score, layer=layer, reasons=[*reasons, *extra]  # type: ignore[arg-type]
            )

        if cand.due.date is None or task.due_date is None or cand.due.date == task.due_date:
            return decision(MatchRelation.DUPLICATE)
        gap = abs((cand.due.date - task.due_date).days)
        explicit_change = cand.relation_hint == RelationHint.DEADLINE_CHANGE
        if gap > self.config.recurring_gap_days and not explicit_change:
            return MatchDecision(
                relation=MatchRelation.RELATED, task_id=task.id, score=score, layer=layer,  # type: ignore[arg-type]
                reasons=[*reasons, f"deadline_gap_{gap}_days_recurring"],
            )
        newer = source_date is None or task.last_source_at is None or source_date >= task.last_source_at
        if explicit_change:
            return decision(MatchRelation.DEADLINE_UPDATE, "explicit_deadline_change")
        # A different date is only treated as an update of the same obligation when the new source
        # itself refers back to it (reminder / same thread) or the match is very strong.
        strong = cand.relation_hint == RelationHint.REMINDER or "same_mail_thread" in reasons or score >= 0.85
        if newer and strong:
            return decision(MatchRelation.DEADLINE_UPDATE, "newer_source")
        return decision(MatchRelation.POSSIBLE_DUPLICATE, "conflicting_deadline_needs_review")

    # -----------------------------------------------------------------------------------------

    def match_completion(
        self, signal: CompletionSignal, *, thread_id: str | None, existing: list[TaskSnapshot]
    ) -> MatchDecision:
        scored: list[tuple[float, TaskSnapshot, list[str]]] = []
        for task in existing:
            if task.status not in {s.value for s in ACTIVE_STATUSES}:
                continue
            ent = entity_similarity(signal.entities, task.entities)
            act = action_similarity(signal.action_type, task.action_type)
            txt = max(text_similarity(signal.subject, _task_text(task)),
                      object_overlap(signal.subject, f"{task.title} {task.description[:600]}"))
            if ent is None:
                score = 0.6 * txt + 0.2 * act * min(1.0, txt * 2.5)
            elif ent == 0.0:
                score = 0.1 * txt
            else:
                score = 0.6 * ent + 0.25 * txt + 0.15 * act
            reasons = [f"entities={ent if ent is None else round(ent, 2)}", f"action={act:.2f}", f"text={txt:.2f}"]
            if task.due_date is not None and task.due_date in {
                m.date for m in find_dates(signal.subject, task.due_date) if not m.is_relative
            }:
                score += 0.25  # e.g. "Ihr Termin am 22.10.2026 wurde storniert"
                reasons.append("same_date")
            if thread_id and thread_id in task.thread_ids:
                score += 0.25
                reasons.append("same_mail_thread")
            scored.append((round(min(score, 1.0), 3), task, reasons))
        if not scored:
            return MatchDecision(relation=MatchRelation.NEW, reasons=["no_active_tasks"])
        scored.sort(key=lambda s: s[0], reverse=True)
        best_score, best_task, reasons = scored[0]
        if best_score < self.config.completion_threshold:
            return MatchDecision(relation=MatchRelation.NEW, score=best_score, reasons=[*reasons, "no_matching_task"])
        if len(scored) > 1 and best_score - scored[1][0] < self.config.completion_margin:
            return MatchDecision(
                relation=MatchRelation.NEW, score=best_score, reasons=[*reasons, "ambiguous_completion_target"]
            )
        layer = "deterministic" if "same_mail_thread" in reasons else "normalized"
        return MatchDecision(
            relation=MatchRelation.DUPLICATE, task_id=best_task.id, score=best_score, layer=layer, reasons=reasons  # type: ignore[arg-type]
        )
