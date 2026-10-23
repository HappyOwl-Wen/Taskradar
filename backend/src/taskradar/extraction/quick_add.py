"""Quick entry for the user's own to-dos.

One line such as "周五前交房租", "Freitag 10 Uhr Zahnarzt" or "submit the report by Oct 20 5pm" becomes a
title plus a deadline, using the compositional engine (:mod:`taskradar.extraction.temporal`). Relative dates are
resolved from the moment the user types them. Parsing is local and only proposes values; the user reviews them
before anything is saved.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

from taskradar.domain.enums import ActionType, Category, DueAnchor, TimeSemantics
from taskradar.domain.schemas import DueInfo
from taskradar.extraction import lexicon as lx
from taskradar.extraction.temporal import TemporalResult, parse_temporal

MAX_QUICK_TEXT = 300
_EDGE_JUNK = re.compile(r"^[\s,，.。:：;；!！?？\-–—]+|[\s,，.。:：;；\-–—]+$")

_DATE = chr(0xE000)  # stands in for the date expression; a private-use character never typed by the user
# The date with the deadline words around it ("bis spätestens …", "by …", "请于…前").
_DATE_PHRASE = re.compile(
    r"(?:"
    r"bis\s+(?:spätestens\s+)?(?:zum\s+|zur\s+|am\s+|den\s+)?"
    r"|spätestens\s+(?:am\s+|bis\s+(?:zum\s+)?|zum\s+)?"
    r"|(?:no later than|not later than|due(?: by)?|by|before|until|till|on|at|at the latest by|am|um)\s+(?:the\s+)?"
    r"|截止(?:日期|时间)?(?:为|是)?"
    r"|请于|请在|务必于|务必在|须于|需于|应于|[于在]"
    r")?\s*" + _DATE + r"+\s*(?:前|之前|以前|截止|为止)?",
    re.I,
)


def remove_date_phrase(text: str, start: int, end: int) -> str:
    """``text`` without the date expression at ``start:end`` and the deadline words around it."""
    masked = text[:start] + _DATE * (end - start) + text[end:]
    masked = re.sub(_DATE + "+", _DATE, masked)
    return re.sub(r"\s{2,}", " ", _DATE_PHRASE.sub(" ", masked)).strip().replace(_DATE, "").strip()


@dataclass
class QuickTask:
    title: str
    due: DueInfo | None
    category: Category
    action_type: ActionType
    temporal: TemporalResult


def parse_quick_task(text: str, *, now: dt.datetime, tz: str) -> QuickTask:
    line = " ".join(text.split())[:MAX_QUICK_TEXT]
    temporal = parse_temporal(line, now=now, timezone=tz)
    chosen = temporal.selected
    due: DueInfo | None = None
    title = line
    if chosen is not None and temporal.normalized_date is not None:
        semantics = TimeSemantics.DEADLINE
        # A clock time without a deadline word ("Freitag 10 Uhr Zahnarzt") is usually an appointment.
        if chosen.role != "deadline" and (temporal.normalized_time is not None or lx.APPOINTMENT_CUES.search(line)):
            semantics = TimeSemantics.APPOINTMENT
        # Only the local engine's reliable resolution is eligible for autofill.
        due = DueInfo(
            date=temporal.normalized_date,
            time=temporal.normalized_time,
            text=temporal.original_expression,
            is_relative=any(op.kind in ("offset", "period", "weekday") for op in chosen.expression.operations),
            anchor=DueAnchor.SOURCE_DATE,
            semantics=semantics,
            notes=temporal.explanation,
        )
        # Only the selected, reliable expression is removed. Contextual dates and unknown wording stay intact.
        spans = [chosen.expression, *temporal.discarded]
        for span in sorted(spans, key=lambda e: e.start, reverse=True):
            title = remove_date_phrase(title, span.start, span.end)
        if temporal.discarded:
            title = re.sub(
                r"(?:不是|不对|改为|改成|更正|而是|\bnot\b|\binstead\b|\brather\b|\bnicht\b|\bsondern\b)[\s,，:：]*",
                "",
                title,
                flags=re.I,
            )
            title = re.sub(r"^是\s*", "", _EDGE_JUNK.sub("", title))
    title = re.sub(r"([，。；：])\s+", r"\1", title)
    title = _EDGE_JUNK.sub("", title) or line
    found = lx.detect_action(title)
    action = found[0] if found else ActionType.OTHER
    return QuickTask(
        title=title[:200], due=due, category=lx.detect_category(line, action), action_type=action, temporal=temporal
    )
