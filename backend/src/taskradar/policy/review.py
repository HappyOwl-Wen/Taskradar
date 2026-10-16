"""Human-review policy: which agent conclusions may be applied automatically.

Rules of thumb encoded here:
* New tasks always start as *candidates*; the user confirms them.
* Low-confidence or uncertain extractions are flagged for review.
* A completion is applied automatically only for tasks the user already confirmed, only when the
  evidence is explicit and confident, and always as a revertible event. Otherwise it becomes a
  suggestion.
* Deadline changes are applied automatically only when the source explicitly announces a change and
  the user has not edited the deadline manually.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from taskradar.domain.enums import COMMITTED_STATUSES, CompletionKind, RelationHint, TaskStatus
from taskradar.domain.schemas import CandidateTask, CompletionSignal

REVIEW_UNCERTAINTIES = {
    "evidence_not_found_in_source",
    "possible_prompt_injection",
    "date_not_found_in_source",
    "date_conflict",
    "relative_date_without_source_date",
    "marketing_context",
    "low_ocr_confidence",
    "title_incomplete",
    "permission_only",
}


# The date engine's note on *why* a date is unclear, kept as a review reason so the UI can name the exact
# problem ("the weekday does not match the date") instead of listing generic examples.
DATE_NOTE_REASONS = {
    "weekday_mismatch": "weekday_mismatch",
    "day_month_order_ambiguous": "day_month_order_ambiguous",
    "next_weekday_ambiguous": "next_weekday_ambiguous",
    "this_week_day_already_passed": "this_week_day_already_passed",
    "weekday_equals_source_day": "weekday_equals_source_day",
    "approximate": "approximate_date",
    "period_starts_at_unknown_event": "period_starts_at_unknown_event",
}


@dataclass(frozen=True)
class PolicyConfig:
    review_confidence_threshold: float = 0.6
    auto_complete_on_explicit_confirmation: bool = True
    auto_complete_min_confidence: float = 0.85
    auto_apply_explicit_deadline_changes: bool = True


def review_reasons(cand: CandidateTask, config: PolicyConfig) -> list[str]:
    reasons: list[str] = []
    if cand.confidence < config.review_confidence_threshold:
        reasons.append("low_confidence")
    if cand.due.ambiguous:
        reasons.append("ambiguous_date")
    elif cand.due.needs_confirmation:
        reasons.append("date_needs_confirmation")
    if cand.due.ambiguous or cand.due.needs_confirmation:
        reasons.extend(DATE_NOTE_REASONS[note] for note in cand.due.notes if note in DATE_NOTE_REASONS)
    reasons.extend(u for u in cand.uncertainties if u in REVIEW_UNCERTAINTIES)
    return list(dict.fromkeys(reasons))


class CompletionAction(StrEnum):
    AUTO_COMPLETE = "auto_complete"
    SUGGEST_COMPLETE = "suggest_complete"
    SUGGEST_DISMISS = "suggest_dismiss"
    SUGGEST_WAITING = "suggest_waiting"
    ATTACH_ONLY = "attach_only"


def completion_action(signal: CompletionSignal, task_status: str, config: PolicyConfig) -> CompletionAction:
    if task_status in (TaskStatus.COMPLETED.value, TaskStatus.DISMISSED.value):
        return CompletionAction.ATTACH_ONLY
    if signal.kind == CompletionKind.IN_REVIEW:
        if task_status in (TaskStatus.CONFIRMED.value, TaskStatus.IN_PROGRESS.value):
            return CompletionAction.SUGGEST_WAITING
        return CompletionAction.ATTACH_ONLY
    if signal.kind == CompletionKind.CANCELLED:
        return CompletionAction.SUGGEST_DISMISS
    committed = task_status in {s.value for s in COMMITTED_STATUSES}
    if (
        committed
        and config.auto_complete_on_explicit_confirmation
        and signal.explicit
        and signal.confidence >= config.auto_complete_min_confidence
    ):
        return CompletionAction.AUTO_COMPLETE
    return CompletionAction.SUGGEST_COMPLETE


def deadline_update_should_apply(cand: CandidateTask, locked_fields: list[str], config: PolicyConfig) -> bool:
    if "due" in locked_fields:
        return False
    if cand.due.needs_confirmation or cand.due.date is None:
        return False
    return config.auto_apply_explicit_deadline_changes and cand.relation_hint == RelationHint.DEADLINE_CHANGE
