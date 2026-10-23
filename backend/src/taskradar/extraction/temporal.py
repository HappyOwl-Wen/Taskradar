"""Context and uncertainty policy for manual task entry.

The grammar emits calendar operations; this layer associates them with clauses, handles
corrections/conditions, and only exposes safe values for autofill. An optional semantic
provider may propose *operations*, never trusted computed dates. Nothing here uses a network.
"""

from __future__ import annotations

import datetime as dt
import re
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Literal, Protocol
from zoneinfo import ZoneInfo

from taskradar.extraction.temporal_calendar import Value, evaluate, wall_time_status
from taskradar.extraction.temporal_grammar import Expression, expressions

Status = Literal["absent", "resolved", "inferred", "unresolved", "urgency"]
Precision = Literal["none", "date", "datetime", "range", "time", "period"]


@dataclass
class Candidate:
    expression: Expression
    value: Value
    role: str = "unspecified"
    confidence: float = 1.0
    needs_confirmation: bool = False
    selectable: bool = True

    def payload(self, text: str) -> dict[str, object]:
        v = self.value
        return {
            "normalized_date": v.date.isoformat() if v.date and not v.end else None,
            "normalized_time": v.time.strftime("%H:%M") if v.time else None,
            "range_start": v.date.isoformat() if v.date and v.end else None,
            "range_end": v.end.isoformat() if v.end else None,
            "original_expression": text[self.expression.start : self.expression.end],
            "start": self.expression.start,
            "end": self.expression.end,
            "role": self.role,
            "confidence": self.confidence,
            "explanation": list(dict.fromkeys(v.notes)),
            "selectable": self.selectable,
        }


@dataclass
class TemporalResult:
    status: Status = "absent"
    precision: Precision = "none"
    normalized_date: dt.date | None = None
    normalized_time: dt.time | None = None
    original_expression: str | None = None
    confidence: float = 0.0
    needs_confirmation: bool = False
    explanation: list[str] = field(default_factory=list)
    candidates: list[Candidate] = field(default_factory=list)
    selected: Candidate | None = None
    discarded: list[Expression] = field(default_factory=list)

    def payload(self, text: str) -> dict[str, object]:
        return {
            "status": self.status,
            "precision": self.precision,
            "normalized_date": self.normalized_date.isoformat() if self.normalized_date else None,
            "normalized_time": self.normalized_time.strftime("%H:%M") if self.normalized_time else None,
            "original_expression": self.original_expression,
            "confidence": self.confidence,
            "needs_confirmation": self.needs_confirmation,
            "explanation": self.explanation,
            "candidates": [c.payload(text) for c in self.candidates],
        }


class SemanticProvider(Protocol):
    def propose(self, text: str, *, now: dt.datetime, timezone: str) -> list[Expression]:
        """Return source spans and calendar operations. Called only if local parsing finds no expression."""
        ...


_STOP = re.compile(r"[,，;；。!?！？\n]")
_DEADLINE = re.compile(
    r"(?:截止(?:日期|时间)?|截至|最晚|最迟|不晚于|到|至|"
    r"\b(?:due(?: by)?|by|before|until|to|deadline|spätestens(?: bis)?|bis))\s*$",
    re.I,
)
_DEADLINE_AFTER = re.compile(r"\s*(?:之前|以前|前|截止|为止|到期|\bat the latest\b)", re.I)
_START = re.compile(r"(?:从|自|开始于|\bfrom|\bstarting|\bab|\bvon)\s*$", re.I)
_NEGATION = re.compile(r"(?:不是|不要|并非|\bnot|\bnicht)\s*$", re.I)
_CORRECTION = re.compile(r"不对|改为|改成|更正|\binstead\b|\brather\b|\bsondern\b|\bnein\b", re.I)
_CONDITIONAL = re.compile(r"如果|假如|要是|否则|\bif\b|\bunless\b|\bwenn\b|\bfalls\b", re.I)
_APPROXIMATE = re.compile(
    r"差不多|大概|大约|左右|找一天|某一天|\baround\b|\bsometime\b|\babout\b|\birgendwann\b|\bungefähr\b|\bgegen\b", re.I
)
_URGENCY = re.compile(
    r"尽量早点|尽快|马上|赶紧|\bASAP\b|\bas soon as possible\b|\bdringend\b|\bschnellstmöglich\b", re.I
)
# These signal unsupported/incomplete temporal intent, never manufacture a date.
_INTENT = re.compile(
    r"\d+\s*(?:月|号|点|[:：])|下周|明[早晚天]|月底|截止|\b(?:tom+or+ow|next|due|deadline|morgen|nächste\w*)\b", re.I
)
_UNKNOWN_ANCHOR = re.compile(r"(?:签约|收到|完成|结束|到达).{0,12}(?:后|之后)$|\b(?:after|following|nach)\s+\w+", re.I)
_UNCERTAIN = {
    "exaggerated_modifier",
    "next_weekday_ambiguous",
    "date_order_ambiguous",
    "missing_year_past",
    "leap_year_inferred",
    "approximate",
    "past",
    "nonexistent_time",
    "ambiguous_time",
    "unknown_anchor",
    "semantic_candidate",
    "unsupported_timezone",
    "multiple_weekdays_in_range",
}


def _context(text: str, expr: Expression) -> tuple[str, str]:
    before = _STOP.split(text[: expr.start])[-1]
    after = _STOP.split(text[expr.end :])[0]
    return before, after


def parse_temporal(
    text: str, *, now: dt.datetime, timezone: str, provider: SemanticProvider | None = None
) -> TemporalResult:
    if now.tzinfo is None:
        raise ValueError("reference time must be timezone aware")
    local = now.astimezone(ZoneInfo(timezone))
    parsed = expressions(text)
    from_provider = False
    if not parsed and provider:
        try:
            parsed = provider.propose(text, now=now, timezone=timezone)
            from_provider = True
        except Exception:
            parsed = []  # Optional semantic strategies cannot break manual task creation.
    result = TemporalResult()
    for expr in parsed[:40]:
        if not (0 <= expr.start < expr.end <= len(text)) or len(expr.operations) > 100:
            continue
        value = evaluate(expr.operations, local.date())
        before, after = _context(text, expr)
        # Possessives identify content ("read Friday's report"), not scheduling instructions.
        if re.match(r"['’]s\b", after, re.I):
            continue
        if _NEGATION.search(before):
            result.discarded.append(expr)
            continue
        role = (
            "deadline"
            if _DEADLINE.search(before) or _DEADLINE_AFTER.match(after)
            else "start"
            if _START.search(before)
            else "unspecified"
        )
        if any(op.kind == "within" for op in expr.operations):
            role = "deadline"
        since_previous = text[result.candidates[-1].expression.end : expr.start] if result.candidates else before
        if _CORRECTION.search(since_previous):
            result.discarded.extend(c.expression for c in result.candidates)
            result.candidates.clear()
            value.notes.append("corrected")
        if from_provider:
            value.notes.append("semantic_candidate")
        if "next_weekday_ambiguous" in value.notes and value.date:
            upcoming = local.date() + dt.timedelta(days=(value.date.weekday() - local.weekday()) % 7 or 7)
            if upcoming == value.date:
                value.notes.remove("next_weekday_ambiguous")
        if role == "deadline" and value.date and result.candidates:
            previous = result.candidates[-1]
            if (
                previous.role == "start"
                and previous.value.date
                and value.date < previous.value.date
                and any(op.kind == "weekday" for op in expr.operations)
            ):
                while value.date < previous.value.date:
                    value.date += dt.timedelta(days=7)
                value.notes.append("range_end_after_start")
        if _APPROXIMATE.search(before + after):
            value.notes.append("approximate")
        event_prefix = bool(
            before.strip() and re.match(r"[前后]\d|[前后][一二两三四五六七八九十]", text[expr.start : expr.end])
        )
        if event_prefix or _UNKNOWN_ANCHOR.search(before) or re.match(r"\s*(?:after|following|nach)\b", after, re.I):
            value.date, value.end = None, None
            value.notes.append("unknown_anchor")
        # A daypart narrows a day, not a fabricated hour. A following clock can qualify it.
        if value.time and value.daypart in ("afternoon", "evening") and value.time.hour < 12:
            value.time = value.time.replace(hour=value.time.hour + 12)
        if value.date and value.time:
            status = wall_time_status(value.date, value.time, timezone)
            if status != "valid":
                value.notes.append(status)
            elif dt.datetime.combine(value.date, value.time, local.tzinfo) < local:
                value.notes.append("past")
        elif value.date and value.date < local.date() and not value.end:
            value.notes.append("past")
        if value.time and re.match(r"\s*(?:CET|CEST|MEZ|MESZ|UTC|GMT|[+-]\d\d:?)\b", after, re.I):
            value.notes.append("unsupported_timezone")
        if value.daypart and not value.time:
            value.notes.append("daypart_only")
        if value.time and not value.date:
            value.notes.append("date_required")
        if value.end and any(op.kind == "weekend" for op in expr.operations) and _DEADLINE_AFTER.match(after):
            value.date, value.end = value.date - dt.timedelta(days=1) if value.date else None, None
            value.notes.extend(["approximate", "before_weekend"])
        if value.end:
            value.notes.append("date_range")
        uncertain = bool(set(value.notes) & _UNCERTAIN) or value.invalid or value.end is not None
        selectable = not value.invalid and not set(value.notes) & {
            "nonexistent_time",
            "ambiguous_time",
            "unsupported_timezone",
            "unknown_anchor",
        }
        candidate = Candidate(
            expr,
            value,
            role,
            0.55 if uncertain else 0.95 if "year_inferred" in value.notes else 1.0,
            uncertain,
            bool(selectable),
        )
        result.candidates.append(candidate)
        # Alternative calendar readings are visible, but never automatically chosen.
        alternatives = list(value.alternatives)
        for op in expr.operations:
            if op.kind == "note" and op.unit == "date_order_ambiguous":
                year, month, day = op.parts
                with suppress(ValueError):
                    alternatives.append(dt.date(year or local.year, month, day))
            if op.kind == "note" and op.unit == "next_weekday_ambiguous" and value.date:
                upcoming = local.date() + dt.timedelta(days=(value.date.weekday() - local.weekday()) % 7 or 7)
                if upcoming != value.date:
                    alternatives.append(upcoming)
        for date in dict.fromkeys(alternatives):
            alternative = Value(date=date, time=value.time, notes=["alternative_interpretation"])
            result.candidates.append(Candidate(expr, alternative, role, 0.5, True, bool(selectable)))
    if not result.candidates:
        result.status = (
            "urgency"
            if _URGENCY.search(text)
            else "unresolved"
            if _INTENT.search(text) or result.discarded
            else "absent"
        )
        result.explanation = (
            ["urgency_only"]
            if result.status == "urgency"
            else ["unrecognized"]
            if result.status == "unresolved"
            else []
        )
        return result

    candidates = result.candidates
    # Group alternatives by source expression, so one ambiguous weekday is not mistaken for two tasks.
    primary = list({(c.expression.start, c.expression.end): c for c in reversed(candidates)}.values())
    deadlines = [c for c in primary if c.role == "deadline"]
    selected = deadlines[0] if len(deadlines) == 1 else primary[0] if len(primary) == 1 else None
    conditional = bool(_CONDITIONAL.search(text))
    if conditional or selected is None:
        result.status, result.needs_confirmation = "inferred", True
        result.explanation = ["conditional" if conditional else "multiple_dates"]
        result.precision = "range" if any(c.value.end for c in candidates) else "date"
        result.confidence = 0.4
        for c in candidates:
            c.value.notes.extend(result.explanation)
            c.confidence = min(c.confidence, 0.4)
        return result
    result.selected = selected
    v = selected.value
    result.original_expression = text[selected.expression.start : selected.expression.end]
    result.confidence = selected.confidence
    result.needs_confirmation = selected.needs_confirmation
    result.explanation = list(dict.fromkeys(v.notes))
    if len(primary) > 1:
        result.explanation.append("deadline_preferred")
    result.precision = (
        "range"
        if v.end
        else "datetime"
        if v.date and v.time
        else "date"
        if v.date
        else "time"
        if v.time
        else "period"
        if v.daypart
        else "none"
    )
    result.status = (
        "unresolved"
        if v.invalid or "unknown_anchor" in v.notes
        else "inferred"
        if selected.needs_confirmation
        else "resolved"
    )
    if not selected.needs_confirmation:
        result.normalized_date, result.normalized_time = v.date, v.time
    return result
