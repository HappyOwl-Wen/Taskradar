"""Small multilingual temporal grammar, shared calendar operations, longest-token lexing.

Rules recognise lexical categories, not whole task sentences. Composition (period + weekday,
anchor + relative offset, date + daypart + clock) happens separately from token recognition.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from taskradar.extraction.dates import ALL_MONTHS, DE_WEEKDAYS, EN_WEEKDAYS, WORD_NUMBERS, ZH_WEEKDAYS, zh_to_int
from taskradar.extraction.temporal_calendar import Operation as Op


def alt(words: Iterable[str]) -> str:
    return "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))


NUM = rf"(?:\d+|[零〇一二两三四五六七八九十百千]+|{alt(WORD_NUMBERS)})"
WEEKDAYS = {**EN_WEEKDAYS, **DE_WEEKDAYS, **ZH_WEEKDAYS}
WD = rf"(?:{alt(EN_WEEKDAYS)}|{alt(DE_WEEKDAYS)}|[一二三四五六日天])"
UNIT = (
    r"(?:工作日|天|日|周|星期|礼拜|个月|月|年|business days?|working days?|days?|weeks?|months?|years?|"
    r"Arbeitstage[n]?|Werktage[n]?|Tage[n]?|Wochen?|Monate[n]?|Jahre[n]?)"
)
PARTS = {
    "早上": "morning",
    "早晨": "morning",
    "上午": "morning",
    "早": "morning",
    "morning": "morning",
    "morgens": "morning",
    "früh": "morning",
    "vormittags": "morning",
    "下午": "afternoon",
    "afternoon": "afternoon",
    "nachmittags": "afternoon",
    "晚上": "evening",
    "傍晚": "evening",
    "晚": "evening",
    "evening": "evening",
    "night": "evening",
    "abends": "evening",
    "中午": "noon",
    "凌晨": "early",
}
PART = alt(PARTS)


def number(token: str) -> int:
    value = WORD_NUMBERS.get(token.lower())
    if value is None:
        value = zh_to_int(token)
    if value is None and re.fullmatch(r"[零〇一二两三四五六七八九十百千]+", token):
        digits = {char: i for i, char in enumerate("零一二三四五六七八九")}
        digits.update({"〇": 0, "两": 2})
        total, digit, last_unit = 0, 0, 10000
        for char in token:
            if char in digits:
                digit = digits[char]
            else:
                scale = {"十": 10, "百": 100, "千": 1000}[char]
                if scale >= last_unit:
                    raise ValueError("invalid numeral order")
                total += (digit or 1) * scale
                digit, last_unit = 0, scale
        value = total + digit
    if value is None:
        raise ValueError("unknown numeral")
    return value


def unit(token: str) -> str:
    low = token.lower()
    if low == "工作日" or low.startswith(("business", "working", "arbeit", "werktag")):
        return "business"
    if low in ("周", "星期", "礼拜") or low.startswith(("week", "woche")):
        return "week"
    if low in ("个月", "月") or low.startswith(("month", "monat")):
        return "month"
    if low == "年" or low.startswith(("year", "jahr")):
        return "year"
    return "day"


@dataclass
class Token:
    start: int
    end: int
    operations: list[Op]
    category: str


@dataclass
class Expression:
    start: int
    end: int
    operations: list[Op]


Builder = Callable[[re.Match[str]], list[Op]]
Rule = tuple[re.Pattern[str], str, Builder]
RULES: list[Rule] = []


def rule(pattern: str, category: str) -> Callable[[Builder], Builder]:
    def register(fn: Callable[[re.Match[str]], list[Op]]) -> Callable[[re.Match[str]], list[Op]]:
        RULES.append((re.compile(pattern, re.I), category, fn))
        return fn

    return register


@rule(r"(?<!\d)(?P<y>\d{4})[-/.年](?P<m>\d{1,2})[-/.月](?P<d>\d{1,2})[日号]?(?!\d)", "date")
@rule(rf"(?P<m>{NUM})月(?P<d>{NUM})[日号]", "date")
@rule(
    rf"(?<![a-z])(?P<mon>{alt(ALL_MONTHS)})\.?\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(?P<y>\d{{4}}))?(?!\d)", "date"
)
@rule(
    rf"(?<!\d)(?P<d>\d{{1,2}})(?:\.|st|nd|rd|th)?\s+(?:of\s+)?(?P<mon>{alt(ALL_MONTHS)})\.?(?:\s+(?P<y>\d{{4}}))?(?![a-z])",
    "date",
)
@rule(r"(?<![\d.])(?P<d>\d{1,2})\.\s?(?P<m>\d{1,2})\.(?P<y>\d{4}|\d{2})?(?!\d)", "date")
def literal(m: re.Match[str]) -> list[Op]:
    gd = m.groupdict()
    raw_year = gd.get("y")
    year = int(raw_year or 0)
    if raw_year and len(raw_year) == 2:
        year += 2000
    elif raw_year and year == 0:
        return [Op("invalid")]
    month = ALL_MONTHS[gd["mon"].lower()] if gd.get("mon") else number(gd["m"])
    return [Op("literal", parts=(year, month, number(gd["d"])))]


@rule(r"(?<![\d/])(?P<a>\d{1,2})/(?P<b>\d{1,2})(?:/(?P<y>\d{4}|\d{2}))?(?![\d/])", "date")
def slash(m: re.Match[str]) -> list[Op]:
    a, b = int(m["a"]), int(m["b"])
    year = int(m["y"] or 0)
    if m["y"] and len(m["y"]) == 2:
        year += 2000
    elif m["y"] and year == 0:
        return [Op("invalid")]
    ops = [Op("literal", parts=(year, b, a)) if a > 12 else Op("literal", parts=(year, a, b))]
    if a <= 12 and b <= 12 and a != b:
        ops.append(Op("note", unit="date_order_ambiguous", parts=(year, b, a)))
    return ops


@rule(r"大*后天|大*前天|今天|今日|明天|明日|昨天|昨日|(?P<short>明|今)(?P<part>早|晚)", "date")
@rule(
    r"\b(?:the day after tomorrow|the day before yesterday|tomorrow|today|tonight|yesterday|"
    r"übermorgen|vorgestern|morgen|heute|gestern)\b",
    "date",
)
def day(m: re.Match[str]) -> list[Op]:
    word = m[0].lower()
    if word.endswith(("后天", "前天")):
        count = word.count("大")
        ops = [Op("offset", (count + 2) * (-1 if word.endswith("前天") else 1), "day")]
        if count > 1:
            ops.append(Op("note", unit="exaggerated_modifier"))
        return ops
    days = {
        "今天": 0,
        "今日": 0,
        "明天": 1,
        "明日": 1,
        "昨天": -1,
        "昨日": -1,
        "today": 0,
        "tonight": 0,
        "tomorrow": 1,
        "yesterday": -1,
        "the day after tomorrow": 2,
        "the day before yesterday": -2,
        "heute": 0,
        "morgen": 1,
        "gestern": -1,
        "übermorgen": 2,
        "vorgestern": -2,
    }
    short = m.groupdict().get("short")
    if short:
        return [Op("offset", 1 if short == "明" else 0, "day"), Op("daypart", unit=PARTS[m["part"]])]
    return [Op("offset", days[word], "day")] + ([Op("daypart", unit="evening")] if word == "tonight" else [])


@rule(rf"(?P<direction>下+|上+|这|本)(?:个)?(?P<unit>周|星期|礼拜|月|年)(?:\s*(?P<wd>{WD})(?![a-z]))?", "period")
@rule(r"(?P<direction>明|今|去)年", "period")
@rule(
    rf"\b(?P<direction>next|last|this|nächste[nrs]?|letzte[nrs]?|diese[nrs]?)\s+(?:(?P<unit>week|month|year|Woche|Monat|Jahr)\b\s*)?(?P<wd>{WD})?\b",
    "period",
)
def period(m: re.Match[str]) -> list[Op]:
    gd = m.groupdict()
    direction = gd["direction"].lower()
    amount = len(direction) if direction.startswith("下") else -len(direction) if direction.startswith("上") else 0
    if direction in ("明", "next") or direction.startswith("näch"):
        amount = 1
    if direction in ("去", "last") or direction.startswith("letzt"):
        amount = -1
    u = unit(gd.get("unit") or ("week" if gd.get("wd") else "year"))
    if direction not in ("明", "今", "去") and not gd.get("unit") and not gd.get("wd"):
        return []
    ops = [Op("period", amount, u)]
    if gd.get("wd"):
        ops.append(Op("weekday", WEEKDAYS[gd["wd"].lower()]))
        if amount == 1 and (direction == "next" or direction.startswith("näch")):
            ops.append(Op("note", unit="next_weekday_ambiguous"))
    return ops


@rule(rf"(?P<n>{NUM})\s*(?:个)?(?P<unit>{UNIT})\s*(?P<mode>之后|以后|后|之前|以前|前|之内|以内|内)", "offset")
@rule(rf"\b(?P<mode>in|within|innerhalb von|innerhalb|binnen)\s+(?P<n>{NUM})\s+(?P<unit>{UNIT})\b", "offset")
@rule(rf"(?P<mode>后|前)(?P<n>{NUM})(?P<unit>天|日|周|个月|年)", "offset")
def offset(m: re.Match[str]) -> list[Op]:
    mode = m["mode"].lower()
    amount = number(m["n"]) * (-1 if mode in ("前", "之前", "以前") else 1)
    kind = "within" if mode in ("之内", "以内", "内", "within", "innerhalb von", "innerhalb", "binnen") else "offset"
    return [Op(kind, amount, unit(m["unit"]))]


@rule(r"下(?:一|个)?工作日|\bnext (?:business|working) day\b|\bnächste[rn]? (?:Arbeits|Werk)tag\b", "date")
def business(m: re.Match[str]) -> list[Op]:
    return [Op("offset", 1, "business")]


@rule(rf"(?:周|星期|礼拜)\s*(?P<wd>{WD})(?![a-z])|\b(?P<western>{alt(EN_WEEKDAYS)}|{alt(DE_WEEKDAYS)})\b", "weekday")
def weekday(m: re.Match[str]) -> list[Op]:
    return [Op("weekday", WEEKDAYS[(m["wd"] or m["western"]).lower()])]


@rule(rf"(?P<m>{NUM})月", "month")
def month(m: re.Match[str]) -> list[Op]:
    return [Op("month", number(m["m"]))]


@rule(
    r"月?(?P<edge>底|末|初|上旬|中旬|下旬)|\b(?P<western>end|beginning|start|middle|Anfang|Mitte|Ende)(?:\s+of)?\b",
    "edge",
)
def edge(m: re.Match[str]) -> list[Op]:
    word = (m["edge"] or m["western"]).lower()
    n = 1 if word in ("初", "上旬", "beginning", "start", "anfang") else 2 if word in ("中旬", "middle", "mitte") else 3
    return [Op("edge", n)]


@rule(r"周末|\bweekend\b|\bWochenende\b", "period")
def weekend(m: re.Match[str]) -> list[Op]:
    return [Op("weekend")]


@rule(r"这(?:两|几)天|这几日", "date")
def near_days(m: re.Match[str]) -> list[Op]:
    return [Op("within", 2 if "两" in m[0] else 3, "day"), Op("note", unit="approximate")]


@rule(rf"(?P<part>{PART})\s*(?P<h>{NUM})[点时](?:(?P<min>{NUM}|半|一刻|三刻)分?)?", "clock")
@rule(rf"(?<![\d第])(?P<h>{NUM})[点时](?:(?P<min>{NUM}|半|一刻|三刻)分?)?(?:钟)?", "clock")
@rule(r"(?<![\d:.])(?P<h>\d{1,2})[:：](?P<min>\d{2})(?:\s*(?P<ampm>a\.?m\.?|p\.?m\.?))?(?:\s*Uhr)?(?!\d)", "clock")
@rule(r"(?<![\d:.])(?P<h>\d{1,2})(?:\.(?P<min>\d{2}))?\s*(?P<ampm>a\.?m\.?|p\.?m\.?|Uhr)\b", "clock")
@rule(r"\b(?:um|at)\s+(?P<h>\d{1,2})(?![\d:])\b", "clock")
def clock(m: re.Match[str]) -> list[Op]:
    gd = m.groupdict()
    hour = number(gd["h"])
    raw = gd.get("min")
    fractions = {"半": 30, "一刻": 15, "三刻": 45}
    minute = fractions[raw] if raw in fractions else number(raw) if raw else 0
    ampm = (gd.get("ampm") or "").lower().replace(".", "")
    part = PARTS.get(gd.get("part") or "")
    if ampm in ("am", "pm"):
        if not 1 <= hour <= 12:
            return [Op("invalid")]
        hour = hour % 12 + (12 if ampm == "pm" else 0)
    if (part in ("afternoon", "evening") and hour < 12) or (part == "noon" and hour < 6):
        hour += 12
    return [Op("clock", parts=(hour, minute))]


@rule(rf"(?:{PART})(?![a-z])", "daypart")
def daypart(m: re.Match[str]) -> list[Op]:
    return [Op("daypart", unit=PARTS[m[0].lower()])]


@rule(r"\bmidnight\b|\bMitternacht\b|午夜|\bnoon\b|正午", "clock")
def named_clock(m: re.Match[str]) -> list[Op]:
    return [Op("clock", parts=(12 if m[0].lower() in ("noon", "正午") else 0, 0))]


def tokenize(text: str) -> list[Token]:
    found = []
    for pattern, category, build in RULES:
        for position in range(len(text)):
            match = pattern.match(text, position)
            if match is None:
                continue
            try:
                operations = build(match)
            except ValueError:
                operations = [Op("invalid")]
            if operations:
                found.append(Token(match.start(), match.end(), operations, category))
    # An invalid long literal still owns its span: February 30 cannot turn into a smaller valid date.
    found.sort(key=lambda t: (t.start, -(t.end - t.start)))
    result: list[Token] = []
    for token in found:
        if not result or token.start >= result[-1].end:
            result.append(token)
    return result


def expressions(text: str) -> list[Expression]:
    tokens = tokenize(text)
    result: list[Expression] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        ops = list(token.operations)
        end, category = token.end, token.category
        i += 1
        while i < len(tokens):
            nxt = tokens[i]
            gap = text[end : nxt.start]
            joined = bool(re.fullmatch(r"\s*(?:的|of|at|um|am|on)?\s*", gap, re.I))
            temporal_tail = nxt.category in ("clock", "daypart") and category not in ("clock",)
            clock_before_date = category == "clock" and nxt.category in ("date", "period", "weekday")
            selector = nxt.category in ("weekday", "edge", "month") and category in ("period", "offset", "month")
            recursive = gap.strip() == "的" and nxt.category in ("date", "offset", "period")
            prefix_edge = category == "edge" and nxt.category in ("period", "month")
            if not joined or not (temporal_tail or clock_before_date or selector or recursive or prefix_edge):
                break
            following = nxt.operations
            if text[nxt.start : nxt.end] == "末" and any(op.kind == "period" and op.unit == "week" for op in ops):
                following = [Op("weekend")]
            ops = following + ops if prefix_edge else ops + following
            end, category = nxt.end, nxt.category
            i += 1
        # Bare year/month mentions in task content are not deadlines without a selector or a cue.
        if token.category == "month" and len(ops) == 1:
            continue
        # Standalone 'start/end', '早/晚' inside ordinary words aren't date expressions.
        if token.category == "edge" and end == token.end and not re.search(r"月[底末初]", text[token.start : end]):
            continue
        if token.category == "daypart" and len(text[token.start : end]) == 1:
            continue
        result.append(Expression(token.start, end, ops))
    return result
