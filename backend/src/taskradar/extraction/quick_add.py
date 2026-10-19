"""Quick entry for the user's own to-dos.

One line such as "周五前交房租", "Freitag 10 Uhr Zahnarzt" or "submit the report by Oct 20 5pm" becomes a
title plus a deadline, using the zh/de/en date engine (:mod:`taskradar.extraction.dates`). Relative dates are
resolved from the moment the user types them. Parsing is local and only proposes values; the user reviews them
before anything is saved.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from taskradar.domain.enums import ActionType, Category, DueAnchor, TimeSemantics
from taskradar.domain.schemas import DueInfo
from taskradar.extraction import lexicon as lx
from taskradar.extraction.dates import bare_weekday_mention, choose_deadline, find_dates, mention_to_due
from taskradar.parsing.language import detect_language

MAX_QUICK_TEXT = 300
_EDGE_JUNK = re.compile(r"^[\s,，.。:：;；!！?？\-–—]+|[\s,，.。:：;；\-–—]+$")

_DATE = chr(0xE000)  # stands in for the date expression; a private-use character never typed by the user
# The date with the deadline words around it ("bis spätestens …", "by …", "请于…前").
_DATE_PHRASE = re.compile(
    r"(?:"
    r"bis\s+(?:spätestens\s+)?(?:zum\s+|zur\s+|am\s+|den\s+)?"
    r"|spätestens\s+(?:am\s+|bis\s+(?:zum\s+)?|zum\s+)?"
    r"|(?:no later than|not later than|by|before|until|till|on|at the latest by)\s+(?:the\s+)?"
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


def parse_quick_task(text: str, *, now: dt.datetime, tz: str) -> QuickTask:
    line = " ".join(text.split())[:MAX_QUICK_TEXT]
    today = now.astimezone(ZoneInfo(tz)).date()
    mentions = find_dates(line, today, tz=tz, lang=detect_language(line))
    chosen = choose_deadline(mentions) or bare_weekday_mention(line, today, tz=tz)
    due: DueInfo | None = None
    title = line
    if chosen is not None and chosen.date is not None:
        semantics = TimeSemantics.DEADLINE
        # A clock time without a deadline word ("Freitag 10 Uhr Zahnarzt") is usually an appointment.
        if not chosen.deadline_cue and (chosen.time is not None or lx.APPOINTMENT_CUES.search(line)):
            semantics = TimeSemantics.APPOINTMENT
        # "Today" is when the user typed it, so relative dates need no extra confirmation.
        due = mention_to_due(chosen, anchor_kind=DueAnchor.SOURCE_DATE, semantics=semantics)
        title = remove_date_phrase(line, chosen.start, chosen.end)
    title = _EDGE_JUNK.sub("", title) or line
    found = lx.detect_action(title)
    action = found[0] if found else ActionType.OTHER
    return QuickTask(title=title[:200], due=due, category=lx.detect_category(line, action), action_type=action)
