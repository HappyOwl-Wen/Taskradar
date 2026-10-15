"""Quick entry for the user's own to-dos.

One line such as "周五前交房租", "Freitag 10 Uhr Zahnarzt" or "submit the report by Oct 20 5pm" becomes a
title plus a deadline, using the same zh/de/en date engine as the extractor. Relative dates are resolved
from the moment the user types them. Parsing is local and only proposes values; the user reviews them
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
from taskradar.extraction.rules import remove_date_phrase
from taskradar.parsing.language import detect_language

MAX_QUICK_TEXT = 300
_EDGE_JUNK = re.compile(r"^[\s,，.。:：;；!！?？\-–—]+|[\s,，.。:：;；\-–—]+$")


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
        title = remove_date_phrase(line, [(chosen.start, chosen.end)])
    title = _EDGE_JUNK.sub("", title) or line
    found = lx.detect_action(title)
    action = found[0] if found else ActionType.OTHER
    return QuickTask(title=title[:200], due=due, category=lx.detect_category(line, action), action_type=action)
