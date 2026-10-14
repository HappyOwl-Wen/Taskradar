"""Hybrid pipeline: deterministic pre-filter + LLM extraction + safe fallback to rules."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable

from taskradar.domain.enums import ContentType
from taskradar.domain.schemas import CandidateTask, CompletionSignal, ExtractionInput, ExtractionResult
from taskradar.extraction import lexicon as lx
from taskradar.extraction.dates import find_dates
from taskradar.extraction.llm_extractor import LLMExtractionFailed, LLMExtractor
from taskradar.extraction.rules import RuleBasedExtractor
from taskradar.llm.base import LLMError
from taskradar.reconciliation.normalize import action_similarity, entity_similarity, text_similarity


class ExtractionNotPermitted(Exception):
    """Raised by an authorization hook when content must not be sent to the model."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def has_obligation_cues(text: str) -> bool:
    """Cheap check used for data minimisation: only content with possible obligations goes to a model."""
    if lx.detect_action(text) is not None or lx.OBLIGATION_CUES.search(text):
        return True
    if any(p.search(text) for _, p in lx.COMPLETION_PATTERNS) or lx.REMINDER_CUES.search(text):
        return True
    return bool(find_dates(text[:20000], dt.date.today()))


class HybridExtractor:
    name = "hybrid"

    def __init__(
        self,
        rules: RuleBasedExtractor,
        llm: LLMExtractor | None,
        *,
        prefilter: bool = True,
        authorize: Callable[[ExtractionInput], None] | None = None,
    ) -> None:
        self.rules = rules
        self.llm = llm
        self.prefilter = prefilter
        self.authorize = authorize

    @property
    def version(self) -> str:
        return f"{self.rules.version}+{self.llm.version}" if self.llm else self.rules.version

    def extract(self, inp: ExtractionInput) -> ExtractionResult:
        base = self.rules.extract(inp)
        if self.llm is None:
            return base
        trace = list(base.trace)

        if self.prefilter:
            if base.content_type in (ContentType.MARKETING, ContentType.NEWSLETTER) and not base.tasks:
                trace.append({"step": "hybrid.skip_llm", "reason": "marketing_or_newsletter"})
                return base.model_copy(update={"trace": trace, "notes": [*base.notes, "llm_skipped_marketing"]})
            if not base.tasks and not base.completion_signals and not has_obligation_cues(inp.text):
                trace.append({"step": "hybrid.skip_llm", "reason": "no_obligation_cues"})
                return base.model_copy(update={"trace": trace, "notes": [*base.notes, "llm_skipped_no_cues"]})

        if self.authorize is not None:
            try:
                self.authorize(inp)
            except ExtractionNotPermitted as exc:
                trace.append({"step": "hybrid.llm_not_permitted", "reason": exc.code})
                return base.model_copy(update={"trace": trace, "notes": [*base.notes, f"llm_not_permitted:{exc.code}"]})

        try:
            llm_result = self.llm.extract(inp)
        except LLMExtractionFailed as exc:
            trace.extend(exc.trace)
            trace.append({"step": "hybrid.fallback_to_rules", "error": exc.code})
            return base.model_copy(
                update={
                    "extractor": f"{base.extractor}(fallback)",
                    "usage": exc.usage,
                    "trace": trace,
                    "notes": [*base.notes, f"llm_fallback:{exc.code}"],
                }
            )
        except LLMError as exc:
            trace.append({"step": "hybrid.fallback_to_rules", "error": exc.code})
            return base.model_copy(
                update={
                    "extractor": f"{base.extractor}(fallback)",
                    "trace": trace,
                    "notes": [*base.notes, f"llm_fallback:{exc.code}"],
                }
            )

        return self._merge(llm_result, base, trace)

    # -----------------------------------------------------------------------------------------

    @staticmethod
    def _same_task(a: CandidateTask, b: CandidateTask) -> bool:
        ent = entity_similarity(a.entities, b.entities)
        act = action_similarity(a.action_type, b.action_type)
        txt = text_similarity(f"{a.title} {a.action_required}", f"{b.title} {b.action_required}")
        if ent is not None and ent >= 0.5 and act >= 0.7:
            return True
        if a.due.date is not None and a.due.date == b.due.date and (txt >= 0.3 or (ent or 0) >= 0.5):
            return True
        return txt >= 0.5 and act >= 0.7

    def _merge(
        self, llm_result: ExtractionResult, base: ExtractionResult, trace: list[dict[str, object]]
    ) -> ExtractionResult:
        tasks = list(llm_result.tasks)
        added = 0
        if llm_result.content_type not in (ContentType.MARKETING, ContentType.NEWSLETTER):
            for rule_task in base.tasks:
                if any(self._same_task(rule_task, t) for t in tasks):
                    continue
                tasks.append(
                    rule_task.model_copy(
                        update={
                            "confidence": round(max(0.05, rule_task.confidence - 0.15), 3),
                            "uncertainties": [*rule_task.uncertainties, "only_detected_by_rules"],
                        }
                    )
                )
                added += 1
        signals: list[CompletionSignal] = list(llm_result.completion_signals)
        for rs in base.completion_signals:
            if not any(s.kind == rs.kind and set(s.entities) & set(rs.entities) for s in signals):
                signals.append(rs)
        trace = [
            *trace,
            *llm_result.trace,
            {"step": "hybrid.merge", "llm_tasks": len(llm_result.tasks), "rule_only_tasks_added": added},
        ]
        return llm_result.model_copy(
            update={
                "tasks": tasks,
                "completion_signals": signals,
                "is_actionable": bool(tasks),
                "extractor": f"hybrid:{llm_result.extractor}",
                "trace": trace,
                "notes": [*base.notes, *llm_result.notes],
            }
        )
