"""Deterministic multilingual (zh / de / en) date and deadline expression parser.

Design rules (from the product requirements):

* No deadline found -> no date. Nothing is invented.
* A date without a time stays date-only (no "23:59" is filled in).
* Relative expressions ("下周五", "next Friday", "innerhalb von 14 Tagen") are resolved against the
  *source* date (mail sent date / document date), never against "today", unless no source date
  exists - in which case the result is flagged for confirmation.
* Ambiguous expressions keep their original text, carry alternatives and are flagged.
"""

from __future__ import annotations

import calendar
import datetime as dt
import re
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

from taskradar.domain.enums import DueAnchor, TimeSemantics
from taskradar.domain.schemas import DueInfo

# ---------------------------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------------------------

EN_MONTHS = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}
DE_MONTHS = {
    "januar": 1,
    "jänner": 1,
    "februar": 2,
    "märz": 3,
    "maerz": 3,
    "marz": 3,
    "mär": 3,
    "mrz": 3,
    "april": 4,
    "mai": 5,
    "juni": 6,
    "juli": 7,
    "august": 8,
    "september": 9,
    "oktober": 10,
    "okt": 10,
    "november": 11,
    "dezember": 12,
    "dez": 12,
}
ALL_MONTHS = {**EN_MONTHS, **DE_MONTHS}
_MONTH_ALT = "|".join(sorted(ALL_MONTHS, key=len, reverse=True))

EN_WEEKDAYS = {
    "monday": 0,
    "mon": 0,
    "tuesday": 1,
    "tue": 1,
    "tues": 1,
    "wednesday": 2,
    "wed": 2,
    "thursday": 3,
    "thu": 3,
    "thurs": 3,
    "friday": 4,
    "fri": 4,
    "saturday": 5,
    "sat": 5,
    "sunday": 6,
    "sun": 6,
}
DE_WEEKDAYS = {
    "montag": 0,
    "dienstag": 1,
    "mittwoch": 2,
    "donnerstag": 3,
    "freitag": 4,
    "samstag": 5,
    "sonnabend": 5,
    "sonntag": 6,
}
ZH_WEEKDAYS = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
_WD_EN = "|".join(sorted((k for k in EN_WEEKDAYS if len(k) > 3), key=len, reverse=True))
_WD_DE = "|".join(sorted(DE_WEEKDAYS, key=len, reverse=True))

_ZH_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
WORD_NUMBERS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "fourteen": 14,
    "thirty": 30,
    "ein": 1,
    "eine": 1,
    "einem": 1,
    "einer": 1,
    "einen": 1,
    "zwei": 2,
    "drei": 3,
    "vier": 4,
    "fünf": 5,
    "sechs": 6,
    "sieben": 7,
    "acht": 8,
    "neun": 9,
    "zehn": 10,
    "elf": 11,
    "zwölf": 12,
    "vierzehn": 14,
    "dreißig": 30,
}


def zh_to_int(token: str) -> int | None:
    """Convert '3', '十一', '二十', '三十一', '两' to int."""
    token = token.strip()
    if token.isdigit():
        return int(token)
    if not token:
        return None
    if "十" in token:
        left, _, right = token.partition("十")
        tens = _ZH_DIGITS.get(left) if left else 1
        ones = _ZH_DIGITS.get(right) if right else 0
        if tens is None or ones is None:
            return None
        return tens * 10 + ones
    if len(token) == 1 and token in _ZH_DIGITS:
        return _ZH_DIGITS[token]
    return None


def _to_int(token: str) -> int | None:
    token = token.strip().lower()
    if token.isdigit():
        return int(token)
    if token in WORD_NUMBERS:
        return WORD_NUMBERS[token]
    return zh_to_int(token)


# ---------------------------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------------------------

_ABS_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("iso", re.compile(r"(?<!\d)(?P<y>20\d{2})\s*[-/.]\s*(?P<m>[01]?\d)\s*[-/.]\s*(?P<d>[0-3]?\d)(?!\d)")),
    ("zh_full", re.compile(r"(?P<y>20\d{2})\s*年\s*(?P<m>[01]?\d)\s*月\s*(?P<d>[0-3]?\d)\s*[日号]?")),
    ("zh_md", re.compile(r"(?<![\d年])(?P<m>[01]?\d)\s*月\s*(?P<d>[0-3]?\d)\s*[日号]")),
    (
        "zh_md_cn",
        re.compile(
            r"(?P<m>十[一二]?|[一二三四五六七八九])月(?P<d>[一二三]?十[一二三四五六七八九]?|[一二三四五六七八九])[日号]"
        ),
    ),
    ("de_num", re.compile(r"(?<![\d.])(?P<d>[0-3]?\d)\.\s?(?P<m>[01]?\d)\.(?:\s?(?P<y>20\d{2}|\d{2})(?!\d))?(?!\d)")),
    (
        "text_dmy",
        re.compile(
            rf"(?<!\d)(?P<d>[0-3]?\d)(?:\.|st|nd|rd|th)?\s+(?:of\s+)?(?P<mon>{_MONTH_ALT})\.?(?:,?\s+(?P<y>20\d{{2}}))?(?![a-zäöüß])",
            re.I,
        ),
    ),
    (
        "text_mdy",
        re.compile(
            rf"(?<![a-zäöüß])(?P<mon>{_MONTH_ALT})\.?\s+(?P<d>[0-3]?\d)(?:st|nd|rd|th)?(?:,?\s+(?P<y>20\d{{2}}))?(?![\d:])",
            re.I,
        ),
    ),
    ("slash", re.compile(r"(?<![\d/])(?P<a>[0-3]?\d)/(?P<b>[0-3]?\d)/(?P<y>20\d{2}|\d{2})(?![\d/])")),
]

_REL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("zh_day", re.compile(r"大后天|后天|明天|明日|明晚|今天|今日|今晚|当天")),
    ("zh_next2_week_wd", re.compile(r"下下(?:个)?(?:周|星期|礼拜)(?P<wd>[一二三四五六日天])")),
    ("zh_next_week_wd", re.compile(r"下(?:个)?(?:周|星期|礼拜)(?P<wd>[一二三四五六日天])")),
    ("zh_this_week_wd", re.compile(r"(?:本|这个|这)(?:周|星期|礼拜)(?P<wd>[一二三四五六日天])")),
    ("zh_wd", re.compile(r"(?<![下本这个])(?:周|星期|礼拜)(?P<wd>[一二三四五六日天])")),
    (
        "zh_within",
        re.compile(
            r"(?P<n>\d{1,3}|[一二三四五六七八九十两]{1,3})\s*(?:个)?(?P<unit>工作日|天|日|周|星期|个月)\s*(?:之内|以内|内)"
        ),
    ),
    ("zh_month_end", re.compile(r"(?P<which>本月|这个月|下个?月)?\s*(?:月底|月末)")),
    ("zh_m_end", re.compile(r"(?P<m>[01]?\d)\s*月\s*(?:底|末|下旬)")),
    ("zh_week_end", re.compile(r"(?P<which>本周|这周|下周)(?:末|内|之内)")),
    ("en_day", re.compile(r"\b(?:the day after tomorrow|tomorrow|today|tonight)\b", re.I)),
    ("en_next_wd", re.compile(rf"\bnext\s+(?P<wd>{_WD_EN})\b", re.I)),
    ("en_this_wd", re.compile(rf"\b(?:this coming|this|coming)\s+(?P<wd>{_WD_EN})\b", re.I)),
    (
        "en_wd",
        re.compile(
            rf"\b(?:by|on|until|before|due)\s+(?P<wd>{_WD_EN})\b(?!\s*,?\s*(?:the\s+)?(?:{_MONTH_ALT}|\d))", re.I
        ),
    ),
    (
        "en_within",
        re.compile(
            r"\b(?:within|in)\s+(?:the\s+next\s+)?(?P<n>\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|"
            r"eleven|twelve|fourteen|thirty)\s+"
            r"(?P<unit>business days?|working days?|calendar days?|days?|weeks?|months?)\b",
            re.I,
        ),
    ),
    (
        "en_end",
        re.compile(
            rf"\b(?:the\s+)?end\s+of\s+(?:(?:(?P<which>this|the|next)\s+)?(?P<unit>week|month)|(?P<mon>{_MONTH_ALT}))\b",
            re.I,
        ),
    ),
    ("de_day", re.compile(r"\b(?:übermorgen|morgen|heute)\b")),
    ("de_next_wd", re.compile(rf"\b(?:nächsten|nächster|nächste)\s+(?:Woche\s+)?(?P<wd>{_WD_DE})\b", re.I)),
    ("de_this_wd", re.compile(rf"\b(?:diesen|dieser|kommenden|kommender)\s+(?P<wd>{_WD_DE})\b", re.I)),
    ("de_wd", re.compile(rf"\b(?:bis|am|zum|vor)\s+(?P<wd>{_WD_DE})\b(?!\s*,?\s*(?:den\s+)?\d)", re.I)),
    (
        "de_within",
        re.compile(
            r"\b(?:innerhalb\s+(?:von\s+)?|binnen\s+|in\s+)(?P<n>\d{1,3}|einer|einem|eine|zwei|drei|vier|fünf|sechs|"
            r"sieben|acht|neun|zehn|elf|zwölf|vierzehn|dreißig)\s+(?P<unit>Werktagen|Werktage|Arbeitstagen|Tagen|Tage|"
            r"Wochen|Woche|Monaten|Monat)\b",
            re.I,
        ),
    ),
    (
        "de_end",
        re.compile(
            rf"\bEnde\s+(?:(?P<which>der|dieser|nächster|kommender)\s+(?P<unit>Woche)|(?P<which2>des|dieses|nächsten)\s+"
            rf"(?P<unit2>Monats)|(?P<mon>{_MONTH_ALT}))\b",
            re.I,
        ),
    ),
    ("de_mid_start", re.compile(rf"\b(?P<pos>Anfang|Mitte)\s+(?P<mon>{_MONTH_ALT})\b", re.I)),
]

_TIME_PATTERNS: list[tuple[str, re.Pattern[str], int]] = [
    # (name, pattern, max gap in chars between date and time)
    (
        "hm",
        re.compile(
            r"(?<![\d:.])(?P<h>[01]?\d|2[0-4])\s*[:：]\s*(?P<min>[0-5]\d)(?:\s*(?P<ampm>a\.?m\.?|p\.?m\.?))?"
            r"(?:\s*(?:Uhr|hrs|h)\b)?(?:\s*(?P<tz>CEST|CET|MESZ|MEZ|UTC|GMT)\b)?",
            re.I,
        ),
        28,
    ),
    ("h_dot_uhr", re.compile(r"(?<![\d.])(?P<h>[01]?\d|2[0-4])\.(?P<min>[0-5]\d)\s*Uhr\b", re.I), 28),
    ("h_ampm", re.compile(r"(?<![\d:.])(?P<h>1[0-2]|0?[1-9])\s*(?P<ampm>a\.?m\.?|p\.?m\.?)(?![a-z])", re.I), 28),
    ("h_uhr", re.compile(r"(?<![\d:.])(?P<h>[01]?\d|2[0-4])\s*Uhr\b", re.I), 28),
    (
        "zh_period",
        re.compile(
            r"(?P<period>上午|下午|晚上|中午|早上|凌晨|傍晚)\s*(?P<h>[012]?\d|[一二三四五六七八九十]{1,3})\s*[点时](?:\s*(?P<min>[0-5]?\d|半|一刻|三刻)\s*分?)?"
        ),
        10,
    ),
    (
        "zh_plain",
        re.compile(r"(?<![\d第])(?P<h>[012]?\d)\s*[点时](?:\s*(?P<min>[0-5]?\d|半)\s*分?)?(?![钟])"),
        3,
    ),
    ("midnight", re.compile(r"\bmidnight\b|\bMitternacht\b|午夜|24\s*[:：]\s*00", re.I), 28),
    ("noon", re.compile(r"\bnoon\b|\bmidday\b|正午", re.I), 28),
]

_DEADLINE_BEFORE = re.compile(
    r"(截止(日期|时间)?|截至|最晚|最迟|不晚于|期限|务必于|务必在|请于|请在|须于|须在|需于|需在|应于|应在|于|在|deadline|"
    r"due( date)?|due (by|on)|by|before|until|till|no later than|not later than|latest( by)?|on or before|prior to|"
    r"closes?( on)?|expires?( on)?|ends?( on)?|bis( zum| zur| spätestens)?|spätestens( am| bis| zum| bis zum)?|"
    r"frist|abgabe( bis| am)?|fällig( am| bis)?|fälligkeit(sdatum)?( am)?|zahlungsziel|zahlungsfrist|vor dem|"
    r"einsendeschluss|anmeldeschluss|bewerbungsschluss|stichtag|zahlbar bis|到期日(期)?)"
    r"\s*[:：为是]?\s*(the\s+|den\s+|dem\s+)?(\w+,?\s*)?$",
    re.I,
)
_DEADLINE_AFTER = re.compile(r"^\s*(前|之前|以前|截止|为止|到期|at the latest|deadline|spätestens|fällig)", re.I)
# "within 14 days after contract signing": the period starts at an event we do not know, so the
# date must not be computed from the mail date. Receipt of the message itself is a known anchor.
_EVENT_ANCHOR_AFTER = re.compile(
    r"^\s*(?:(?:of|after|following|from)\s+"
    r"(?!(?:the\s+)?(?:receipt|date of this|this\s+(?:letter|e-?mail|notice|message)|today))"
    r"|(?:nach|ab)\s+(?!(?:dem\s+)?(?:Erhalt|Zugang|Zustellung|Eingang|Datum dieses|heute)))",
    re.I,
)
_EVENT_ANCHOR_BEFORE_ZH = re.compile(r"(后|之后|以后)\s*$")
_RECEIPT_BEFORE_ZH = re.compile(r"(收到|接到|收悉)[^，。；]{0,12}(后|之后|以后)\s*$")
# Relative weekday matches such as "bis Freitag" / "by Friday" carry their own deadline cue.
_CUE_INSIDE = re.compile(r"^(by|until|before|due|bis|vor)\b", re.I)
_SENTENCE_STOP = re.compile(r"[\n。！？!?；;]")


# ---------------------------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------------------------


@dataclass
class DateMention:
    start: int
    end: int
    text: str
    kind: str  # pattern name
    date: dt.date | None
    time: dt.time | None = None
    is_relative: bool = False
    ambiguous: bool = False
    approximate: bool = False
    year_inferred: bool = False
    alternatives: list[dt.date] = field(default_factory=list)
    deadline_cue: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def span(self) -> tuple[int, int]:
        return (self.start, self.end)


# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------


def _safe_date(y: int, m: int, d: int) -> dt.date | None:
    try:
        return dt.date(y, m, d)
    except ValueError:
        return None


def _infer_year(month: int, day: int, anchor: dt.date) -> tuple[dt.date | None, bool]:
    """Pick the year for a date without year: the anchor year unless that is >60 days in the past."""
    candidate = _safe_date(anchor.year, month, day)
    if candidate is None:
        candidate = _safe_date(anchor.year + 1, month, day)
        return candidate, True
    if candidate < anchor - dt.timedelta(days=60):
        return _safe_date(anchor.year + 1, month, day), True
    return candidate, False


def _last_day(year: int, month: int) -> dt.date:
    return dt.date(year, month, calendar.monthrange(year, month)[1])


def _add_months(d: dt.date, months: int) -> dt.date:
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return dt.date(year, month, day)


def _add_business_days(d: dt.date, n: int) -> dt.date:
    current = d
    added = 0
    while added < n:
        current += dt.timedelta(days=1)
        if current.weekday() < 5:
            added += 1
    return current


def _monday(d: dt.date) -> dt.date:
    return d - dt.timedelta(days=d.weekday())


def _upcoming(anchor: dt.date, weekday: int) -> dt.date:
    return anchor + dt.timedelta(days=(weekday - anchor.weekday()) % 7)


def _weekday_index(token: str) -> int | None:
    token = token.lower()
    if token in EN_WEEKDAYS:
        return EN_WEEKDAYS[token]
    if token in DE_WEEKDAYS:
        return DE_WEEKDAYS[token]
    return ZH_WEEKDAYS.get(token)


# ---------------------------------------------------------------------------------------------
# Absolute dates
# ---------------------------------------------------------------------------------------------


def _absolute_mentions(text: str, anchor: dt.date, lang: str | None) -> list[DateMention]:
    mentions: list[DateMention] = []
    for name, pattern in _ABS_PATTERNS:
        for m in pattern.finditer(text):
            gd = m.groupdict()
            year_inferred = False
            alternatives: list[dt.date] = []
            ambiguous = False
            notes: list[str] = []
            value: dt.date | None
            if name == "slash":
                a, b = int(gd["a"]), int(gd["b"])
                y = int(gd["y"])
                y = y + 2000 if y < 100 else y
                dmy = _safe_date(y, b, a)
                mdy = _safe_date(y, a, b)
                if dmy and mdy and dmy != mdy:
                    ambiguous = True
                    primary, other = (mdy, dmy) if lang == "en" else (dmy, mdy)
                    alternatives = [other]
                    notes.append("day_month_order_ambiguous")
                    value = primary
                else:
                    value = dmy or mdy
            else:
                if name == "zh_md_cn":
                    month = zh_to_int(gd["m"])
                    day = zh_to_int(gd["d"])
                elif "mon" in gd and gd.get("mon"):
                    month = ALL_MONTHS.get(gd["mon"].lower().rstrip("."))
                    day = int(gd["d"])
                else:
                    month = int(gd["m"])
                    day = int(gd["d"])
                if month is None or day is None or not (1 <= month <= 12 and 1 <= day <= 31):
                    continue
                if gd.get("y"):
                    y = int(gd["y"])
                    y = y + 2000 if y < 100 else y
                    value = _safe_date(y, month, day)
                else:
                    value, year_inferred = _infer_year(month, day, anchor)
                    notes.append("year_inferred")
            if value is None:
                continue
            mentions.append(
                DateMention(
                    start=m.start(),
                    end=m.end(),
                    text=m.group(0),
                    kind=name,
                    date=value,
                    ambiguous=ambiguous,
                    alternatives=alternatives,
                    year_inferred=year_inferred,
                    notes=notes,
                )
            )
    return mentions


# ---------------------------------------------------------------------------------------------
# Relative dates
# ---------------------------------------------------------------------------------------------


def _relative_mentions(text: str, anchor: dt.date) -> list[DateMention]:
    mentions: list[DateMention] = []
    for name, pattern in _REL_PATTERNS:
        for m in pattern.finditer(text):
            gd = m.groupdict()
            token = m.group(0)
            value: dt.date | None = None
            ambiguous = False
            approximate = False
            alternatives: list[dt.date] = []
            notes: list[str] = []

            if name == "zh_day":
                offset = {
                    "今天": 0,
                    "今日": 0,
                    "今晚": 0,
                    "当天": 0,
                    "明天": 1,
                    "明日": 1,
                    "明晚": 1,
                    "后天": 2,
                    "大后天": 3,
                }[token]
                value = anchor + dt.timedelta(days=offset)
            elif name in ("en_day", "de_day"):
                low = token.lower()
                offset = 2 if ("after" in low or low == "übermorgen") else 1 if low in ("tomorrow", "morgen") else 0
                value = anchor + dt.timedelta(days=offset)
            elif name in ("zh_next2_week_wd", "zh_next_week_wd", "zh_this_week_wd", "zh_wd"):
                wd = ZH_WEEKDAYS[gd["wd"]]
                if name == "zh_next2_week_wd":
                    value = _monday(anchor) + dt.timedelta(days=14 + wd)
                elif name == "zh_next_week_wd":
                    value = _monday(anchor) + dt.timedelta(days=7 + wd)
                elif name == "zh_this_week_wd":
                    value = _monday(anchor) + dt.timedelta(days=wd)
                    if value < anchor:
                        ambiguous = True
                        alternatives = [value + dt.timedelta(days=7)]
                        notes.append("this_week_day_already_passed")
                else:
                    value = _upcoming(anchor, wd)
                    if value == anchor:
                        ambiguous = True
                        alternatives = [anchor + dt.timedelta(days=7)]
                        notes.append("weekday_equals_source_day")
            elif name in ("en_next_wd", "de_next_wd"):
                parsed_wd = _weekday_index(gd["wd"])
                assert parsed_wd is not None
                wd = parsed_wd
                upcoming = _upcoming(anchor, wd)
                if upcoming == anchor:
                    upcoming += dt.timedelta(days=7)
                next_week = _monday(anchor) + dt.timedelta(days=7 + wd)
                if upcoming == next_week:
                    value = next_week
                    alternatives = [next_week + dt.timedelta(days=7)]
                else:
                    value = next_week
                    alternatives = [upcoming]
                ambiguous = True
                notes.append("next_weekday_ambiguous")
            elif name in ("en_this_wd", "de_this_wd", "en_wd", "de_wd"):
                parsed_wd = _weekday_index(gd["wd"])
                assert parsed_wd is not None
                wd = parsed_wd
                value = _upcoming(anchor, wd)
                if value == anchor and name in ("en_wd", "de_wd"):
                    ambiguous = True
                    alternatives = [anchor + dt.timedelta(days=7)]
                    notes.append("weekday_equals_source_day")
            elif name in ("zh_within", "en_within", "de_within"):
                n = _to_int(gd["n"])
                unit = gd["unit"].lower()
                if n is None or n <= 0 or n > 400:
                    continue
                if unit in ("工作日",) or unit.startswith(("business", "working", "werktag", "arbeitstag")):
                    value = _add_business_days(anchor, n)
                    notes.append("business_days_ignore_holidays")
                elif unit in ("天", "日") or unit.startswith(("day", "calendar", "tag")):
                    value = anchor + dt.timedelta(days=n)
                elif unit in ("周", "星期") or unit.startswith(("week", "woche")):
                    value = anchor + dt.timedelta(weeks=n)
                elif unit in ("个月",) or unit.startswith(("month", "monat")):
                    value = _add_months(anchor, n)
                notes.append("within_period")
            elif name == "zh_month_end":
                which = gd.get("which") or ""
                base = _add_months(anchor.replace(day=1), 1) if which.startswith("下") else anchor
                value = _last_day(base.year, base.month)
                approximate = True
            elif name == "zh_m_end":
                month = int(gd["m"])
                if not 1 <= month <= 12:
                    continue
                first, _ = _infer_year(month, 1, anchor.replace(day=1))
                if first is None:
                    continue
                value = _last_day(first.year, month)
                approximate = True
            elif name == "zh_week_end":
                which = gd["which"]
                base = _monday(anchor) + dt.timedelta(days=7 if which == "下周" else 0)
                value = base + dt.timedelta(days=4)
                alternatives = [base + dt.timedelta(days=6)]
                approximate = True
            elif name in ("en_end", "de_end"):
                month_token = gd.get("mon")
                unit = (gd.get("unit") or gd.get("unit2") or "").lower()
                which = (gd.get("which") or gd.get("which2") or "").lower()
                nxt = which in ("next", "nächster", "nächsten", "kommender")
                if month_token:
                    month = ALL_MONTHS[month_token.lower()]
                    first, _ = _infer_year(month, 1, anchor.replace(day=1))
                    if first is None:
                        continue
                    value = _last_day(first.year, month)
                elif unit.startswith(("week", "woche")):
                    base = _monday(anchor) + dt.timedelta(days=7 if nxt else 0)
                    value = base + dt.timedelta(days=4)
                    alternatives = [base + dt.timedelta(days=6)]
                else:
                    base = _add_months(anchor.replace(day=1), 1) if nxt else anchor
                    value = _last_day(base.year, base.month)
                approximate = True
            elif name == "de_mid_start":
                month = ALL_MONTHS[gd["mon"].lower()]
                first, _ = _infer_year(month, 1, anchor.replace(day=1))
                if first is None:
                    continue
                value = first if gd["pos"].lower() == "anfang" else first.replace(day=15)
                approximate = True

            if value is None:
                continue
            mentions.append(
                DateMention(
                    start=m.start(),
                    end=m.end(),
                    text=token,
                    kind=name,
                    date=value,
                    is_relative=True,
                    ambiguous=ambiguous,
                    approximate=approximate,
                    alternatives=alternatives,
                    notes=notes,
                )
            )
    return mentions


# ---------------------------------------------------------------------------------------------
# Times
# ---------------------------------------------------------------------------------------------


@dataclass
class _TimeMention:
    start: int
    end: int
    time: dt.time
    max_gap: int
    tz: str | None = None
    note: str | None = None


def _time_mentions(text: str) -> list[_TimeMention]:
    found: list[_TimeMention] = []
    for name, pattern, max_gap in _TIME_PATTERNS:
        for m in pattern.finditer(text):
            gd = m.groupdict()
            note = None
            tz = None
            if name == "midnight":
                value = dt.time(23, 59)
                note = "explicit_midnight"
            elif name == "noon":
                value = dt.time(12, 0)
            else:
                hour = zh_to_int(gd["h"]) if gd.get("h") else None
                if hour is None:
                    continue
                raw_min = gd.get("min")
                if raw_min in (None, ""):
                    minute = 0
                elif raw_min == "半":
                    minute = 30
                elif raw_min == "一刻":
                    minute = 15
                elif raw_min == "三刻":
                    minute = 45
                else:
                    minute = int(raw_min)
                ampm = (gd.get("ampm") or "").lower().replace(".", "")
                period = gd.get("period")
                if ampm == "pm" and hour < 12:
                    hour += 12
                elif ampm == "am" and hour == 12:
                    hour = 0
                if (period in ("下午", "晚上", "傍晚") and hour < 12) or (period == "中午" and hour < 6):
                    hour += 12
                if hour == 24 and minute == 0:
                    hour, minute, note = 23, 59, "explicit_midnight"
                if not (0 <= hour <= 23 and 0 <= minute <= 59):
                    continue
                value = dt.time(hour, minute)
                tz = (gd.get("tz") or "").upper() or None
            found.append(_TimeMention(m.start(), m.end(), value, max_gap, tz, note))
    # Remove overlapping time matches (keep the earliest/longest).
    found.sort(key=lambda t: (t.start, -(t.end - t.start)))
    result: list[_TimeMention] = []
    for t in found:
        if result and t.start < result[-1].end:
            continue
        result.append(t)
    return result


_GAP_ALLOWED_BEFORE_TIME = re.compile(
    r"^[\s,，、(（）)\-–—]*(?:\(?[^\d\n。；;]{0,8}\)?)?[\s,，、]*(?:um|at|by|bis|gegen|until|before|um\s+spätestens|前|的)?[\s,，、]*$",
    re.I,
)
_GAP_ALLOWED_AFTER_TIME = re.compile(r"^\s*(?:am|on|,|，|den|的)?\s*(?:den\s*)?$", re.I)


def _attach_times(text: str, dates: list[DateMention], times: list[_TimeMention], tz_name: str) -> None:
    used: set[int] = set()
    for mention in dates:
        if mention.date is None:
            continue
        best: _TimeMention | None = None
        for idx, t in enumerate(times):
            if idx in used:
                continue
            if t.start >= mention.end:
                gap = text[mention.end : t.start]
                if (
                    len(gap) <= t.max_gap
                    and not _SENTENCE_STOP.search(gap)
                    and _GAP_ALLOWED_BEFORE_TIME.match(gap)
                    and not any(d is not mention and mention.end <= d.start < t.start for d in dates)
                ):
                    best = t
                    used.add(idx)
                    break
            elif t.end <= mention.start:
                gap = text[t.end : mention.start]
                if len(gap) <= 8 and _GAP_ALLOWED_AFTER_TIME.match(gap):
                    best = t
                    used.add(idx)
                    break
        if best is None:
            continue
        mention.time = best.time
        mention.start = min(mention.start, best.start)
        mention.end = max(mention.end, best.end)
        mention.text = text[mention.start : mention.end]
        if best.note:
            mention.notes.append(best.note)
        if best.tz in ("UTC", "GMT"):
            local = dt.datetime.combine(mention.date, best.time, dt.UTC).astimezone(ZoneInfo(tz_name))
            mention.date = local.date()
            mention.time = local.time().replace(second=0, microsecond=0)
            mention.notes.append("converted_from_utc")


# ---------------------------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------------------------


_WEEKDAY_NEAR = re.compile(
    rf"(?P<wd>{_WD_EN}|{_WD_DE}|(?:周|星期|礼拜)[一二三四五六日天])",
    re.I,
)


def _check_weekday_consistency(text: str, mention: DateMention) -> None:
    if mention.is_relative or mention.date is None:
        return
    window = text[max(0, mention.start - 14) : mention.start] + " " + text[mention.end : mention.end + 8]
    match = _WEEKDAY_NEAR.search(window)
    if not match:
        return
    token = match.group("wd")
    wd = _weekday_index(token[-1] if token[0] in "周星礼" else token)
    if wd is None:
        return
    if wd != mention.date.weekday():
        mention.ambiguous = True
        mention.notes.append("weekday_mismatch")


def find_dates(
    text: str,
    anchor: dt.date,
    *,
    tz: str = "Europe/Berlin",
    lang: str | None = None,
) -> list[DateMention]:
    """Find all date expressions in ``text`` resolved against ``anchor`` (the source date)."""
    if not text:
        return []
    candidates = _absolute_mentions(text, anchor, lang) + _relative_mentions(text, anchor)
    candidates.sort(key=lambda c: (c.start, -(c.end - c.start)))
    selected: list[DateMention] = []
    for c in candidates:
        if any(c.start < s.end and s.start < c.end for s in selected):
            # Keep the longer of two overlapping matches.
            overlapping = [s for s in selected if c.start < s.end and s.start < c.end]
            if all((c.end - c.start) > (s.end - s.start) for s in overlapping):
                for s in overlapping:
                    selected.remove(s)
                selected.append(c)
            continue
        selected.append(c)
    selected.sort(key=lambda c: c.start)
    _attach_times(text, selected, _time_mentions(text), tz)
    for mention in selected:
        _check_weekday_consistency(text, mention)
        before = text[max(0, mention.start - 40) : mention.start]
        before = _SENTENCE_STOP.split(before)[-1]
        after = text[mention.end : mention.end + 14]
        mention.deadline_cue = (
            mention.kind.endswith("_within")
            or bool(_CUE_INSIDE.match(mention.text))
            or bool(_DEADLINE_BEFORE.search(before) or _DEADLINE_AFTER.search(after))
        )
        if mention.kind.endswith("_within"):
            zh_before = text[max(0, mention.start - 20) : mention.start]
            event_after = bool(_EVENT_ANCHOR_AFTER.match(text[mention.end : mention.end + 60]))
            event_before = bool(_EVENT_ANCHOR_BEFORE_ZH.search(zh_before)) and not _RECEIPT_BEFORE_ZH.search(zh_before)
            if event_after or event_before:
                mention.date = None
                mention.ambiguous = True
                mention.notes.append("period_starts_at_unknown_event")
                if event_after:  # "innerhalb von 14 Tagen | nach Vertragsunterzeichnung"
                    tail = re.match(r"[^.,;:!?。，；：！？\n]{0,60}", text[mention.end :])
                    if tail and tail.group(0).strip():
                        mention.end += len(tail.group(0).rstrip())
                else:  # "签约后 | 14天内"
                    head = re.search(r"[^，。；：！？\n请在于]{1,10}(?:后|之后|以后)\s*$", zh_before)
                    if head:
                        mention.start -= len(head.group(0))
                mention.text = text[mention.start : mention.end]
    return selected


_BARE_WEEKDAY = re.compile(rf"\b(?P<wd>{_WD_EN}|{_WD_DE})\b", re.I)


def bare_weekday_mention(text: str, anchor: dt.date, *, tz: str = "Europe/Berlin") -> DateMention | None:
    """A weekday name on its own ("Freitag 10 Uhr Zahnarzt") as the next such day, today included.

    Mails use bare weekdays for opening hours and the like, so only the user's own quick entries use this.
    """
    m = _BARE_WEEKDAY.search(text)
    index = _weekday_index(m.group("wd")) if m else None
    if m is None or index is None:
        return None
    mention = DateMention(
        start=m.start(),
        end=m.end(),
        text=m.group(0),
        kind="bare_weekday",
        date=_upcoming(anchor, index),
        is_relative=True,
    )
    _attach_times(text, [mention], _time_mentions(text), tz)
    return mention


def mention_to_due(
    mention: DateMention,
    *,
    anchor_kind: DueAnchor,
    semantics: TimeSemantics = TimeSemantics.DEADLINE,
) -> DueInfo:
    notes = list(mention.notes)
    needs_confirmation = mention.ambiguous or mention.approximate
    if mention.is_relative and anchor_kind == DueAnchor.IMPORT_TIME:
        needs_confirmation = True
        notes.append("relative_to_import_time")
    if mention.approximate:
        notes.append("approximate")
    return DueInfo(
        date=mention.date,
        time=mention.time,
        text=mention.text.strip(),
        is_relative=mention.is_relative,
        ambiguous=mention.ambiguous,
        needs_confirmation=needs_confirmation,
        anchor=anchor_kind if mention.is_relative else None,
        alternatives=mention.alternatives,
        semantics=semantics,
        notes=notes,
    )


def choose_deadline(mentions: list[DateMention]) -> DateMention | None:
    """Prefer an explicitly cued deadline; else the first concrete mention."""
    if not mentions:
        return None
    cued = [m for m in mentions if m.deadline_cue]
    if cued:
        return cued[0]
    return mentions[0]
