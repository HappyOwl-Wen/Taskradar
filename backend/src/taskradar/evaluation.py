"""Offline evaluation of extraction and deduplication on a labelled synthetic dataset.

Run: ``python -m taskradar eval`` (no network, rule engine). Every number in the report is measured
by actually running the pipeline - nothing is estimated. The dataset is small and synthetic, so the
results describe behaviour on these cases only and are not a claim about real mailboxes.
"""

from __future__ import annotations

import datetime as dt
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from taskradar.domain.enums import ActionType, MatchRelation
from taskradar.domain.schemas import CandidateTask, ExtractionInput, TaskSnapshot, TextSegment
from taskradar.extraction.base import Extractor
from taskradar.extraction.rules import RuleBasedExtractor
from taskradar.reconciliation.normalize import action_similarity
from taskradar.reconciliation.reconciler import Reconciler

DATASET = Path(__file__).resolve().parent / "demo" / "eval_dataset.json"


@dataclass
class CaseResult:
    id: str
    expected: int
    predicted: int
    matched: int
    false_positives: list[str] = field(default_factory=list)
    missed: list[str] = field(default_factory=list)
    date_errors: list[str] = field(default_factory=list)
    dedup: list[str] = field(default_factory=list)
    completion: str | None = None
    ms: float = 0.0


@dataclass
class EvalReport:
    extractor: str
    cases: int
    expected_tasks: int
    predicted_tasks: int
    true_positives: int
    precision: float
    recall: float
    f1: float
    due_checked: int
    due_date_correct: int
    due_time_correct: int
    no_deadline_checked: int
    no_deadline_correct: int
    noise_cases: int
    noise_with_tasks: int
    expected_merges: int
    correct_merges: int
    false_merges: int
    missed_merges: int
    flagged_possible_duplicates: int
    completion_cases: int
    completion_detected: int
    completion_explicitness_correct: int
    completion_targets_expected: int
    completion_targets_correct: int
    avg_ms_per_item: float
    details: list[CaseResult]

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)

    def to_text(self) -> str:
        def pct(a: int, b: int) -> str:
            return f"{a}/{b} ({a / b:.0%})" if b else "n/a"

        lines = [
            f"TaskRadar evaluation - extractor: {self.extractor}",
            f"cases: {self.cases}   avg processing time: {self.avg_ms_per_item:.1f} ms/item",
            "",
            "Task detection",
            f"  precision {self.precision:.2f}   recall {self.recall:.2f}   F1 {self.f1:.2f}"
            f"   (TP {self.true_positives}, predicted {self.predicted_tasks}, expected {self.expected_tasks})",
            f"  deadline date correct:    {pct(self.due_date_correct, self.due_checked)}",
            f"  deadline time correct:    {pct(self.due_time_correct, self.due_checked)}",
            f"  'no deadline' kept empty: {pct(self.no_deadline_correct, self.no_deadline_checked)}",
            f"  marketing/info cases with false tasks: {pct(self.noise_with_tasks, self.noise_cases)}",
            "",
            "Deduplication (cases processed in order)",
            f"  correct merges: {pct(self.correct_merges, self.expected_merges)}   "
            f"wrong merges: {self.false_merges}   missed: {self.missed_merges}   "
            f"flagged as possible duplicate: {self.flagged_possible_duplicates}",
            "",
            "Completion evidence",
            f"  detected: {pct(self.completion_detected, self.completion_cases)}   "
            "explicit/uncertain classified correctly: "
            f"{pct(self.completion_explicitness_correct, self.completion_cases)}   "
            f"matched to the right task: {pct(self.completion_targets_correct, self.completion_targets_expected)}",
            "",
            "Per-case problems:",
        ]
        for case in self.details:
            problems = case.false_positives + case.missed + case.date_errors + case.dedup
            if case.completion and not case.completion.startswith("ok"):
                problems.append(case.completion)
            if problems:
                lines.append(f"  {case.id}: " + "; ".join(problems))
        return "\n".join(lines)


def _input(case: dict[str, Any], default_sent: str, idx: int) -> ExtractionInput:
    subject = case.get("subject") or ""
    body = case["body"]
    text = f"{subject}\n\n{body}" if subject else body
    sent = dt.datetime.fromisoformat(case.get("sent_at") or default_sent)
    return ExtractionInput(
        origin_kind="message",
        origin_id=idx,
        title=subject or None,
        text=text,
        segments=[TextSegment(text=text, page=None, offset=0)],
        sent_at=sent,
        received_at=sent,
        labels=case.get("labels", []),
        is_bulk=bool(case.get("bulk")),
    )


def _matches(pred: CandidateTask, exp: dict[str, Any]) -> bool:
    haystack = " ".join([pred.title, pred.action_required, *[e.quote for e in pred.evidence]]).lower()
    keyword = any(k.lower() in haystack for k in exp.get("keywords", []))
    try:
        action_ok = action_similarity(pred.action_type, ActionType(exp["action"])) >= 0.5
    except ValueError:
        action_ok = False
    due_ok = exp.get("due") is not None and pred.due.date is not None and pred.due.date.isoformat() == exp["due"]
    return sum([keyword, action_ok, due_ok]) >= 2


def run_evaluation(dataset: Path | None = None, extractor: Extractor | None = None) -> EvalReport:
    data = json.loads((dataset or DATASET).read_text(encoding="utf-8"))
    extractor = extractor or RuleBasedExtractor()
    reconciler = Reconciler()
    default_sent = data["default_sent_at"]

    existing: list[TaskSnapshot] = []
    group_of: dict[str, str] = {}
    groups_seen: set[str] = set()
    details: list[CaseResult] = []
    totals: dict[str, int] = dict.fromkeys(
        (
            "expected",
            "predicted",
            "tp",
            "due_checked",
            "due_date",
            "due_time",
            "nodue_checked",
            "nodue_ok",
            "noise",
            "noise_fp",
            "exp_merges",
            "merges_ok",
            "merges_bad",
            "merges_missed",
            "flagged",
            "comp_cases",
            "comp_detected",
            "comp_explicit_ok",
            "comp_targets",
            "comp_targets_ok",
        ),
        0,
    )
    elapsed_total = 0.0
    counter = 0

    for idx, case in enumerate(data["cases"], start=1):
        inp = _input(case, default_sent, idx)
        started = time.perf_counter()
        result = extractor.extract(inp)
        elapsed = (time.perf_counter() - started) * 1000
        elapsed_total += elapsed
        expected = case.get("tasks", [])
        res = CaseResult(case["id"], len(expected), len(result.tasks), 0, ms=round(elapsed, 2))
        totals["expected"] += len(expected)
        totals["predicted"] += len(result.tasks)
        if not expected and not case.get("completion"):
            totals["noise"] += 1
            if result.tasks:
                totals["noise_fp"] += 1

        # -- match predictions to expectations --------------------------------------------
        remaining = list(expected)
        pairs: list[tuple[CandidateTask, dict[str, Any] | None]] = []
        for pred in result.tasks:
            hit = next((e for e in remaining if _matches(pred, e)), None)
            if hit is not None:
                remaining.remove(hit)
                res.matched += 1
                totals["tp"] += 1
                if hit.get("due"):
                    totals["due_checked"] += 1
                    if pred.due.date and pred.due.date.isoformat() == hit["due"]:
                        totals["due_date"] += 1
                    else:
                        res.date_errors.append(f"date {pred.due.date} != {hit['due']}")
                    exp_time = hit.get("time")
                    got_time = pred.due.time.strftime("%H:%M") if pred.due.time else None
                    if got_time == exp_time:
                        totals["due_time"] += 1
                    else:
                        res.date_errors.append(f"time {got_time} != {exp_time}")
                else:
                    totals["nodue_checked"] += 1
                    if pred.due.date is None:
                        totals["nodue_ok"] += 1
                    else:
                        res.date_errors.append(f"invented date {pred.due.date}")
            else:
                res.false_positives.append(f"FP '{pred.title}'")
            pairs.append((pred, hit))
        res.missed = [f"missed '{e['keywords'][0]}'" for e in remaining]

        # -- deduplication simulation ----------------------------------------------------------
        for pred, hit in pairs:
            group = hit["group"] if hit else f"fp:{case['id']}"
            if hit and group in groups_seen:
                totals["exp_merges"] += 1
            decision = reconciler.match_task(
                pred, origin_key=f"case:{case['id']}", thread_id=None, source_date=inp.sent_at, existing=existing
            )
            if decision.relation in (MatchRelation.DUPLICATE, MatchRelation.DEADLINE_UPDATE) and decision.task_id:
                if group_of.get(decision.task_id) == group:
                    totals["merges_ok"] += 1
                else:
                    totals["merges_bad"] += 1
                    res.dedup.append(f"wrong merge into {group_of.get(decision.task_id)}")
                if decision.relation == MatchRelation.DEADLINE_UPDATE:
                    for i, snap in enumerate(existing):
                        if snap.id == decision.task_id:
                            existing[i] = snap.model_copy(update={"due_date": pred.due.date})
                continue
            if hit and group in groups_seen:
                if decision.relation == MatchRelation.POSSIBLE_DUPLICATE:
                    totals["flagged"] += 1
                    res.dedup.append(f"flagged possible duplicate of {group}")
                else:
                    totals["merges_missed"] += 1
                    res.dedup.append(f"missed merge with {group}")
            counter += 1
            task_id = f"t{counter}"
            group_of[task_id] = group
            groups_seen.add(group)
            existing.append(
                TaskSnapshot(
                    id=task_id,
                    title=pred.title,
                    description=pred.description,
                    action_type=pred.action_type,
                    category=pred.category,
                    entities=pred.entities,
                    due_date=pred.due.date,
                    due_time=pred.due.time,
                    status="confirmed",
                    origin_keys=[f"case:{case['id']}"],
                    last_source_at=inp.sent_at,
                )
            )

        # -- completion evidence -----------------------------------------------------------------
        expected_completion = case.get("completion")
        if expected_completion:
            totals["comp_cases"] += 1
            signal = result.completion_signals[0] if result.completion_signals else None
            if signal is None:
                res.completion = "completion not detected"
            else:
                totals["comp_detected"] += 1
                explicit_ok = signal.explicit == expected_completion["explicit"]
                totals["comp_explicit_ok"] += int(explicit_ok)
                res.completion = (
                    "ok" if explicit_ok else f"explicit={signal.explicit} expected {expected_completion['explicit']}"
                )
                if expected_completion.get("group"):
                    totals["comp_targets"] += 1
                    decision = reconciler.match_completion(signal, thread_id=None, existing=existing)
                    target = group_of.get(decision.task_id or "")
                    if target == expected_completion["group"]:
                        totals["comp_targets_ok"] += 1
                    else:
                        res.completion = f"completion matched {target!r}, expected {expected_completion['group']}"
        details.append(res)

    precision = totals["tp"] / totals["predicted"] if totals["predicted"] else 0.0
    recall = totals["tp"] / totals["expected"] if totals["expected"] else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return EvalReport(
        extractor=getattr(extractor, "name", "?") + ":" + getattr(extractor, "version", "?"),
        cases=len(data["cases"]),
        expected_tasks=totals["expected"],
        predicted_tasks=totals["predicted"],
        true_positives=totals["tp"],
        precision=round(precision, 3),
        recall=round(recall, 3),
        f1=round(f1, 3),
        due_checked=totals["due_checked"],
        due_date_correct=totals["due_date"],
        due_time_correct=totals["due_time"],
        no_deadline_checked=totals["nodue_checked"],
        no_deadline_correct=totals["nodue_ok"],
        noise_cases=totals["noise"],
        noise_with_tasks=totals["noise_fp"],
        expected_merges=totals["exp_merges"],
        correct_merges=totals["merges_ok"],
        false_merges=totals["merges_bad"],
        missed_merges=totals["merges_missed"],
        flagged_possible_duplicates=totals["flagged"],
        completion_cases=totals["comp_cases"],
        completion_detected=totals["comp_detected"],
        completion_explicitness_correct=totals["comp_explicit_ok"],
        completion_targets_expected=totals["comp_targets"],
        completion_targets_correct=totals["comp_targets_ok"],
        avg_ms_per_item=round(elapsed_total / max(1, len(data["cases"])), 2),
        details=details,
    )
