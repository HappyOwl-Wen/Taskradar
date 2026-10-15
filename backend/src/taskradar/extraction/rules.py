"""Deterministic rule-based obligation extractor (zh / de / en).

This is the always-available baseline: it runs without any model access, is used as the
fallback when an LLM call fails, and pre-filters content before anything is sent to a cloud
model. It deliberately prefers precision: a sentence only becomes a task when it contains an
action verb *and* an obligation cue or a cued deadline.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from taskradar.domain.enums import (
    ActionType,
    Category,
    CompletionKind,
    ContentType,
    DueAnchor,
    Priority,
    RelationHint,
    TimeSemantics,
)
from taskradar.domain.schemas import (
    CandidateTask,
    CompletionSignal,
    DueInfo,
    Evidence,
    ExtractionInput,
    ExtractionResult,
)
from taskradar.extraction import lexicon as lx
from taskradar.extraction.dates import DateMention, choose_deadline, find_dates, mention_to_due
from taskradar.parsing.language import detect_language

RULES_VERSION = "rules-1.5"
RULES_CONFIDENCE_CAP = 0.85

_HARD_BREAK = re.compile(r"[^\n。！？!?；;]+[。！？!?；;]?")
_LATIN_BREAK = re.compile(r"(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9\"„(])")
_ABBREVIATIONS = re.compile(
    r"(?:\b(?:Nov|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Okt|Dez|Mrz|z|B|bzw|ca|Dr|Prof|Hr|Fr|St|Nr|Str|"
    r"e|g|i|vs|etc|usw|ggf|inkl|u|a|Mr|Mrs|Ms|No|Abs|Tel)\.|\b\d{1,2}\.)$"
)


@dataclass
class Segment:
    text: str
    start: int
    end: int
    page: int | None


_CJK_CLASS = f"{chr(0x4E00)}-{chr(0x9FFF)}{chr(0x3000)}-{chr(0x303F)}{chr(0xFF00)}-{chr(0xFFEF)}"
_CJK_CHAR = re.compile(f"[{_CJK_CLASS}]")
_CJK_GAP = re.compile(
    f"(?<=[{_CJK_CLASS}]) (?=[{_CJK_CLASS}A-Za-z0-9])|(?<=[A-Za-z0-9{_CJK_CLASS}]) (?=[{_CJK_CLASS}])"
)
_LIST_START = re.compile(r"^\s*(?:\d{1,2}[.、)）]\s|[-•*·▪●]\s|[（(]\d{1,2}[)）]|[一二三四五六七八九十]、)")
_HARD_LINE_END = tuple("。！？!?；;：:.")


# A line ending in one of these words cannot end a sentence (articles, prepositions, pronouns...).
_CONTINUATION_WORDS = {
    "die",
    "der",
    "das",
    "den",
    "dem",
    "des",
    "ein",
    "eine",
    "einen",
    "einem",
    "einer",
    "für",
    "von",
    "vom",
    "mit",
    "zu",
    "zum",
    "zur",
    "bis",
    "und",
    "oder",
    "in",
    "im",
    "an",
    "am",
    "auf",
    "bei",
    "beim",
    "nach",
    "über",
    "unter",
    "ihre",
    "ihren",
    "ihr",
    "ihrem",
    "ihrer",
    "sie",
    "sich",
    "the",
    "a",
    "of",
    "to",
    "for",
    "with",
    "and",
    "or",
    "your",
    "our",
    "by",
    "on",
    "at",
    "please",
    "bitte",
}


def _joinable(cur: str, nxt: str) -> bool:
    if not cur or not nxt.strip() or _LIST_START.match(nxt) or cur.endswith(_HARD_LINE_END):
        return False
    first = nxt.lstrip()[0]
    cjk = bool(_CJK_CHAR.search(cur[-1])) or bool(_CJK_CHAR.match(first))
    if cjk:
        return len(cur) >= 22 or cur.endswith(("，", "、", ","))
    last_word = cur.split()[-1].lower() if cur.split() else ""
    if last_word in _CONTINUATION_WORDS or cur.endswith((",", ";")):
        return True
    return len(cur) >= 38 and (first.islower() or first.isdigit() or first in "(")


def soften_wraps(text: str) -> str:
    """Replace soft line wraps (PDF / OCR / hard-wrapped mail) by spaces.

    Replacements have the same length, so character offsets stay valid for evidence. A single
    blank line between two halves of a wrapped sentence (common in OCR output) is bridged too.
    """
    lines = text.split("\n")
    seps = ["\n"] * (len(lines) - 1)
    for i in range(len(lines) - 1):
        cur = lines[i].rstrip()
        if _joinable(cur, lines[i + 1]):
            seps[i] = " "
        elif (
            not lines[i + 1].strip()
            and i + 2 < len(lines)
            and _joinable(cur, lines[i + 2])
            and (_CJK_CHAR.search(cur[-1:]) or lines[i + 2].lstrip()[:1].islower())
        ):
            seps[i] = " "
            lines[i + 1] = " " * len(lines[i + 1])
            seps[i + 1] = " "
    out: list[str] = []
    for i, line in enumerate(lines):
        out.append(line)
        if i < len(seps):
            out.append(seps[i])
    return "".join(out)


def display_quote(text: str) -> str:
    """Evidence shown to the user: drop the artificial spaces between CJK characters."""
    return _CJK_GAP.sub("", text)


def split_segments(inp: ExtractionInput, text: str | None = None) -> list[Segment]:
    """Split text into sentence-like segments while keeping character offsets."""
    segments: list[Segment] = []
    text = soften_wraps(inp.text) if text is None else text
    for m in _HARD_BREAK.finditer(text):
        chunk = m.group(0)
        base = m.start()
        pieces: list[tuple[int, int]] = []
        last = 0
        for b in _LATIN_BREAK.finditer(chunk):
            candidate = chunk[last : b.start()]
            if _ABBREVIATIONS.search(candidate.rstrip()):
                continue
            pieces.append((last, b.start()))
            last = b.end()
        pieces.append((last, len(chunk)))
        for s, e in pieces:
            piece = chunk[s:e]
            stripped = piece.strip()
            if len(stripped) < 2:
                continue
            offset = base + s + (len(piece) - len(piece.lstrip()))
            segments.append(Segment(stripped, offset, offset + len(stripped), inp.locate(offset)))
    return segments


def anchor_for(inp: ExtractionInput) -> tuple[dt.date, DueAnchor]:
    tz = ZoneInfo(inp.timezone)
    if inp.doc_date is not None:
        return inp.doc_date, DueAnchor.DOCUMENT_DATE
    if inp.sent_at is not None:
        return inp.sent_at.astimezone(tz).date(), DueAnchor.SOURCE_DATE
    return inp.received_at.astimezone(tz).date(), DueAnchor.IMPORT_TIME


# ---------------------------------------------------------------------------------------------
# Title construction
# ---------------------------------------------------------------------------------------------

DATE_PLACEHOLDER = chr(0xE000)  # private-use char, never in real text
_P = DATE_PLACEHOLDER
_DATE_PHRASE = re.compile(
    r"(?:"
    r"bis\s+(?:spätestens\s+)?(?:zum\s+|zur\s+|am\s+|den\s+)?"
    r"|spätestens\s+(?:am\s+|bis\s+(?:zum\s+)?|zum\s+)?"
    r"|(?:no later than|not later than|by|before|until|till|on|at the latest by)\s+(?:the\s+)?"
    r"|截止(?:日期|时间)?(?:为|是)?"
    r"|请于|请在|务必于|务必在|须于|需于|应于|[于在]"
    r")?\s*" + _P + r"+\s*(?:前|之前|以前|截止|为止)?",
    re.I,
)

_ZH_STOP = re.compile(
    r"[，,。；;！!？?\n：:（(、"
    + _P
    + r"]|至|到|给|于|前|之前|以前|以便|并且|并|以及|和|及|后|之后|时|截止|期限|延长|延期|推迟"
)
_ZH_LEADING = re.compile(r"^(?:好|一下|您的|你的|我们的|相关的?|有关的?|以下的?|所需的?|全部|所有|本人的?)+")
_EN_STOP = re.compile(
    r"\s+(?:by|before|until|till|no later than|not later than|via|through|to|at|on|within|in|so that|"
    r"because|if|and|or|using|from|as soon as|latest|online|here)\b|(?<!\d)[.,](?!\d)|[;:!?\n(" + _P + r"]"
)
_EN_LEADING = re.compile(r"^(?:your|the|a|an|our|all|any|this|these|us with|us|out|in)\s+", re.I)
_DE_CUT = re.compile(
    r"\s+(?:bei|beim|per|über|unter|innerhalb|binnen|ab|nach|via|online|in|im|an|am|auf|bis|spätestens)\b|"
    r"[.,;:!?\n(" + _P + r"]"
)
_DE_LEADING = re.compile(
    r"^(?:die|den|das|der|dem|Ihre|Ihren|Ihr|Ihrem|Ihrer|eine|einen|ein|uns|sich|bitte|noch|auch)\s+", re.I
)
_DE_MODAL = re.compile(r"^\s*(?:könnten|können|würden|wären|möchten)\s+Sie\s+(?:(?:mir|uns)\s+)?(?:bitte\s+)?", re.I)
_DE_SEPARABLE = {
    "reichen": "einreichen",
    "geben": "abgeben",
    "legen": "vorlegen",
    "laden": "hochladen",
    "melden": "anmelden",
    "füllen": "ausfüllen",
    "bringen": "mitbringen",
}
_DE_ZU = {
    "einzureichen": "einreichen",
    "abzugeben": "abgeben",
    "vorzulegen": "vorlegen",
    "hochzuladen": "hochladen",
    "anzumelden": "anmelden",
    "zurückzumelden": "zurückmelden",
    "nachzureichen": "nachreichen",
    "zuzusenden": "zusenden",
    "einzusenden": "einsenden",
    "auszufüllen": "ausfüllen",
    "mitzubringen": "mitbringen",
}


def mask_dates(text: str, spans: list[tuple[int, int]]) -> str:
    """Replace date expressions by a placeholder and drop the deadline phrase around them."""
    chars = list(text)
    for start, end in spans:
        for i in range(max(0, start), min(len(chars), end)):
            chars[i] = DATE_PLACEHOLDER
    masked = "".join(chars)
    masked = re.sub(DATE_PLACEHOLDER + "+", DATE_PLACEHOLDER, masked)
    return masked


def _strip_date_phrases(text: str) -> str:
    return re.sub(r"\s{2,}", " ", _DATE_PHRASE.sub(" ", text)).strip()


def remove_date_phrase(text: str, spans: list[tuple[int, int]]) -> str:
    """``text`` without the given date expressions and the deadline words around them ("bis", "by", "…前")."""
    return _strip_date_phrases(mask_dates(text, spans)).replace(DATE_PLACEHOLDER, "").strip()


_LIST_MARKER = re.compile(r"^\s*(?:\d{1,2}[.、)）]|[-•*·▪●]|[（(]\d{1,2}[)）]|[一二三四五六七八九十]、)\s*")


def _clip(text: str, limit: int) -> str:
    text = text.replace(DATE_PLACEHOLDER, "")
    text = _LIST_MARKER.sub("", text)
    text = re.sub(r"\s+([.,;:!?。，；：！？])", r"\1", re.sub(r"\s+", " ", text))
    text = text.strip(" -–—:：,，.")
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


_ZH_GENERIC_PREFIX = re.compile(r"(完成|办理|进行)[^，。；;,、\n]{0,8}$")


def _title_zh(seg: str, match: re.Match[str]) -> str | None:
    verb = match.group(0)
    # "完成本学期选课" / "完成学期注册": keep the generic verb and its object in front of the
    # specific action noun instead of producing "注册学期注册".
    prefix = _ZH_GENERIC_PREFIX.search(seg[: match.start()])
    phrase = seg[prefix.start() : match.end()] if prefix is not None else verb
    phrase = re.sub(r"(?:在|通过)\s*\S{0,20}?(?=完成|办理|进行)", "", phrase)
    rest = seg[match.end() :]
    cut = _ZH_STOP.search(rest)
    obj = rest[: cut.start()] if cut else rest
    obj = _ZH_LEADING.sub("", obj.strip())
    if len(obj) < 2:
        return _clip(phrase, 40) if prefix is not None else None
    return _clip(f"{phrase}{obj}", 40)


def _title_en(seg: str, match: re.Match[str], action: ActionType) -> str | None:
    verb = match.group(0).lower()
    if "due" in verb:
        return None
    rest = seg[match.end() :].lstrip()
    label = lx.ACTION_LABELS["en"][action]
    if action in (ActionType.REGISTER, ActionType.APPLY) and rest.lower().startswith("for "):
        rest = rest[4:]
        label = "Register for" if action == ActionType.REGISTER else "Apply for"
    elif verb in ("hand in", "turn in", "fill in", "fill out", "sign up"):
        label = verb.capitalize()
    elif action == ActionType.REPLY and rest.lower().startswith("to "):
        # "reply to confirm whether you will attend ..." -> use the purpose clause.
        purpose = re.split(r"[.;!?\n]", rest[3:], maxsplit=1)[0]
        return _clip(f"Reply: {purpose}", 80) if len(purpose) >= 3 else None
    coordinated = re.match(r"(?:and|or|&)\s+([a-z]+)\s+(.*)", rest, re.S)
    second = lx.detect_action(f"{coordinated.group(1)} {coordinated.group(2)}") if coordinated else None
    if coordinated and second is not None and second[1].start() == 0:
        # "sign and return the rental contract" -> "Sign and return rental contract"
        label = f"{label} and {coordinated.group(1)}"
        rest = coordinated.group(2)
    cut = _EN_STOP.search(" " + rest)
    obj = (" " + rest)[: cut.start()].strip() if cut else rest.strip()
    for _ in range(3):
        obj = _EN_LEADING.sub("", obj)
    if len(obj) < 3:
        return None
    return _clip(f"{label} {obj}", 80)


def _de_infinitive(verb_text: str) -> str:
    words = verb_text.lower().split()
    first = words[0]
    if first in _DE_ZU:
        return _DE_ZU[first]
    if first == "zu" and len(words) > 1:
        return words[1]
    if first in _DE_SEPARABLE and "sie" in words:
        return _DE_SEPARABLE[first]
    return first


def _title_de(seg: str, match: re.Match[str]) -> str | None:
    verb_text = match.group(0)
    infinitive = _de_infinitive(verb_text)
    after = seg[match.end() :]
    sie_inside = re.search(r"\bSie\b", verb_text)
    if sie_inside:
        # Separable verb spanning the object: "reichen Sie <obj> ein"
        obj = verb_text[sie_inside.end() :].strip()
        obj = re.sub(r"\s*\S+$", "", obj)
    elif re.match(r"\s+Sie\b", after):
        # Imperative: "überweisen Sie <obj> bis ..."
        obj = re.sub(r"^\s+Sie\b", "", after)
    else:
        # Infinitive at the clause end: "..., die Unterlagen bis zum 27.11. einzureichen."
        # (commas inside numbers such as "49,90" are not clause boundaries)
        before = re.split(r"(?<!\d),(?!\d)|\bdaran\b|:", seg[: match.start()])[-1]
        before = re.sub(r"^\s*bitte\b", "", before, flags=re.I)
        # Passive obligation "Die Rechnung ... ist bis ... zu begleichen" -> keep the subject phrase.
        before = re.sub(r"\s+(?:ist|sind|muss|müssen|wird|werden)\b.*$", "", before)
        before = _DE_MODAL.sub("", before)
        obj = before
    obj = _strip_date_phrases(obj)
    full = re.sub(r"^\s*sich\b", "", obj).strip()
    cut = _DE_CUT.search(" " + full)
    obj = (" " + full)[: cut.start()].strip() if cut else full
    for _ in range(3):
        obj = _DE_LEADING.sub("", obj)
    obj = obj.strip()
    if len(obj) < 3:
        # Reflexive / prepositional objects: "melden Sie sich in TUMonline zur Prüfung X an"
        prep = re.search(r"\b(?:für|zur|zum)\s+[^,.;:\n" + _P + r"]{3,60}", full)
        if prep is None:
            return None
        obj = prep.group(0).strip()
    obj = obj[0].upper() + obj[1:]
    return _clip(f"{obj} {infinitive}", 80)


def build_title(
    masked_seg: str, action: ActionType, lang: str, entities: list[str], context_title: str | None = None
) -> str:
    """Build a concise title from a segment whose date expressions were masked."""
    found = lx.detect_instructed_action(masked_seg)
    title: str | None = None
    if found is not None:
        _, match = found
        if lang == "zh":
            title = _title_zh(masked_seg, match)
        elif lang == "de":
            title = _title_de(masked_seg, match)
            if title:
                title = re.sub(r"\s+zu\s+(\w+)$", r" \1", title)  # "Miete zu überweisen" -> "Miete überweisen"
        else:
            stripped = _strip_date_phrases(masked_seg)
            found_en = lx.detect_instructed_action(stripped)
            if found_en is not None:
                title = _title_en(stripped, found_en[1], action)
    if title:
        return title
    label_lang = lang if lang in ("zh", "de", "en") else "en"
    for ent in entities:
        if ent in lx.ENTITY_LABELS:
            obj = lx.ENTITY_LABELS[ent][label_lang]
            verb = lx.ACTION_LABELS[label_lang][action]
            if label_lang == "zh":
                return obj if verb in obj else f"{verb}{obj}"
            if label_lang == "de":
                return f"{obj} {verb}"
            return f"{verb} {obj}"
    if action in (ActionType.REPLY, ActionType.CONFIRM) and context_title:
        verb = lx.ACTION_LABELS[label_lang][action]
        subject = re.sub(r"^(?:re|aw|wg|fw|fwd|回复|转发)\s*[:：]\s*", "", context_title.strip(), flags=re.I)
        return _clip(f"{verb.capitalize()}: {subject}", 80)
    return _clip(re.sub(r"^(?:also|und|and|另外|此外)[,，]?\s*", "", _strip_date_phrases(masked_seg), flags=re.I), 60)


# ---------------------------------------------------------------------------------------------
# Extractor
# ---------------------------------------------------------------------------------------------


def _marketing_score(inp: ExtractionInput, text: str) -> int:
    score = len(lx.MARKETING_STRONG.findall(text))
    labels = {label.upper() for label in inp.labels}
    if "CATEGORY_PROMOTIONS" in labels:
        score += 2
    if labels & {"CATEGORY_SOCIAL", "CATEGORY_FORUMS"}:
        score += 1
    if inp.is_bulk:
        score += 1
    if lx.NEWSLETTER_CUES.search(inp.title or ""):
        score += 1
    return score


def _priority(text: str, category: Category, action: ActionType) -> Priority:
    if lx.OPTIONAL_CUES.search(text):
        return Priority.LOW
    if lx.CONSEQUENCE_CUES.search(text):
        return Priority.HIGH
    if category in (Category.ADMINISTRATIVE, Category.FINANCIAL) and action in (
        ActionType.PAY,
        ActionType.SUBMIT,
        ActionType.RENEW,
        ActionType.APPLY,
        ActionType.UPLOAD,
    ):
        return Priority.HIGH
    return Priority.MEDIUM


def _mentions_in(mentions: list[DateMention], seg: Segment) -> list[DateMention]:
    return [m for m in mentions if seg.start <= m.start < seg.end]


# A negation right before the verb in the same clause: "Bitte nicht antworten", "Please do not reply",
# "请勿直接回复". "Don't forget to pay" / "Vergessen Sie nicht, … zu überweisen" are instructions all the same.
_NEGATION_BEFORE = re.compile(
    r"(?:\b(?:do\s+not|don['’]?t|never|no\s+need\s+to|not\s+necessary\s+to|nicht|kein(?:e[nmrs]?)?)\b"
    r"|请勿|切勿|勿|不要|不用|不必|无需|无须|别)"
    r"[^.!?。！？;；,，:：\n]{0,25}$",
    re.I,
)
_NEGATION_AFTER = re.compile(r"^\s*(?:Sie|du|ihr)\s+(?:bitte\s+)?nicht\b(?!\s+nur)", re.I)  # "antworten Sie nicht"
_NOT_A_NEGATION = re.compile(r"forget|vergessen|vergiss|忘", re.I)


def _negated_instruction(seg_text: str, match: re.Match[str]) -> bool:
    before = _NEGATION_BEFORE.search(seg_text[: match.start()])
    if before is not None and not _NOT_A_NEGATION.search(before.group(0)):
        return True
    return bool(_NEGATION_AFTER.match(seg_text[match.end() : match.end() + 30]))


# Titles that stop in the middle of a phrase ("Register for only") or are only template residue.
_DANGLING_END = re.compile(
    r"(?:\b(?:for|only|to|the|a|an|of|with|and|or|this|that|your|our|on|at|in|by|from|as|into|"
    r"für|nur|zu|der|die|das|den|dem|und|oder|mit|von|auf|an|bei|im|zur|zum|ein|eine)|[的和或及对给在与把被让向从为])$",
    re.I,
)


def _incomplete_title(title: str) -> bool:
    core = re.sub(r"[\s:：,，.。;；\-–—#*_=~]+$", "", title)
    return not core or _DANGLING_END.search(core) is not None


def _is_instruction(seg: Segment) -> bool:
    """An action verb together with an obligation cue ("please pay", "请缴纳"); a bare verb in a status
    line ("Payment status: 未支付") is not an instruction."""
    return lx.detect_action(seg.text) is not None and bool(lx.OBLIGATION_CUES.search(seg.text))


class RuleBasedExtractor:
    name = "rules"
    version = RULES_VERSION

    def extract(self, inp: ExtractionInput) -> ExtractionResult:
        text = soften_wraps(inp.text)  # same length as inp.text: offsets stay valid
        lang_doc = inp.language or detect_language(text) or "en"
        anchor, anchor_kind = anchor_for(inp)
        mentions = find_dates(text, anchor, tz=inp.timezone, lang=lang_doc)
        segments = split_segments(inp, text)
        marketing = _marketing_score(inp, text)
        doc_reminder = bool(lx.REMINDER_CUES.search(inp.title or "")) or bool(lx.REMINDER_CUES.search(text))
        doc_change = bool(lx.DEADLINE_CHANGE_CUES.search(text))
        trace: list[dict[str, object]] = [
            {"step": "rules.segment", "segments": len(segments), "dates": len(mentions), "language": lang_doc},
            {"step": "rules.anchor", "anchor": anchor.isoformat(), "anchor_kind": anchor_kind.value},
            {"step": "rules.marketing_score", "value": marketing},
        ]

        tasks: list[CandidateTask] = []
        signals: list[CompletionSignal] = []
        notes: list[str] = []
        context_entities = lx.detect_entities(inp.title or "")

        for idx, seg in enumerate(segments):
            seg_text = seg.text
            conditional_done = bool(lx.CONDITIONAL_DONE.search(seg_text))
            negated_done = bool(lx.NEGATED_DONE.search(seg_text))

            # ---- completion signals -------------------------------------------------------
            if not conditional_done and not negated_done:
                signal = self._completion_signal(seg, context_entities)
                if signal is not None:
                    signals.append(signal)
                    continue

            # ---- obligations ---------------------------------------------------------------
            if lx.BOILERPLATE.search(seg_text):
                continue  # "reply above this line", "this e-mail was sent automatically", …
            found = lx.detect_instructed_action(seg_text)
            if found is None:
                continue
            action, match = found
            if _negated_instruction(seg_text, match):
                continue  # "Bitte nicht antworten", "Please do not reply", "请勿回复"
            if (
                action in lx.GENERIC_ACTIONS
                and seg_text.rstrip().endswith((":", "："))
                and not _mentions_in(mentions, seg)
            ):
                continue  # list header such as "本周需要完成：" / "Please complete the following:"
            obligation = bool(lx.OBLIGATION_CUES.search(seg_text))
            seg_mentions = _mentions_in(mentions, seg)
            cued = [m for m in seg_mentions if m.deadline_cue]
            if not obligation and not cued and not negated_done:
                continue
            if conditional_done:
                continue  # "if you have already submitted, ignore this" is not an obligation
            if lx.THIRD_PARTY_CUES.search(seg_text[: max(0, match.start())]) and not obligation:
                continue

            lang = detect_language(seg_text) or lang_doc
            entities = lx.detect_entities(seg_text) or context_entities
            uncertainties: list[str] = []
            evidence = [
                Evidence(quote=display_quote(seg_text), page=seg.page, start=seg.start, end=seg.end, kind="action")
            ]

            chosen: DateMention | None = choose_deadline(seg_mentions)
            semantics = TimeSemantics.DEADLINE
            if chosen is None:
                chosen, ctx_seg, semantics = self._context_date(segments, idx, mentions)
                if chosen is not None and ctx_seg is not None:
                    evidence.append(
                        Evidence(
                            quote=display_quote(ctx_seg.text),
                            page=ctx_seg.page,
                            start=ctx_seg.start,
                            end=ctx_seg.end,
                            kind="deadline",
                        )
                    )
            elif not chosen.deadline_cue and lx.APPOINTMENT_CUES.search(seg_text):
                semantics = TimeSemantics.APPOINTMENT

            due = mention_to_due(chosen, anchor_kind=anchor_kind, semantics=semantics) if chosen else DueInfo()
            if chosen is not None and not chosen.deadline_cue and semantics == TimeSemantics.DEADLINE:
                uncertainties.append("date_without_deadline_cue")
            if due.ambiguous:
                uncertainties.append("date_ambiguous")
            if due.needs_confirmation and "relative_to_import_time" in due.notes:
                uncertainties.append("relative_date_without_source_date")
            if chosen is None:
                uncertainties.append("no_deadline_found")

            category = lx.detect_category(f"{inp.title or ''} {inp.sender or ''} {seg_text}", action)
            confidence = 0.25 + 0.25
            if obligation:
                confidence += 0.15
            if chosen is not None:
                confidence += 0.2 if chosen.deadline_cue or semantics == TimeSemantics.APPOINTMENT else 0.1
            if entities:
                confidence += 0.05
            if lx.ADDRESSEE_CUES.search(seg_text):
                confidence += 0.05
            if due.ambiguous:
                confidence -= 0.1
            if marketing >= 2:
                confidence -= 0.25
                uncertainties.append("marketing_context")
            page_conf = self._page_ocr_confidence(inp, seg.page)
            if page_conf is not None and page_conf < 0.6:
                confidence -= 0.1
                uncertainties.append("low_ocr_confidence")
            confidence = max(0.05, min(RULES_CONFIDENCE_CAP, round(confidence, 2)))

            relation = RelationHint.NEW
            if lx.CANCEL_TASK_CUES.search(seg_text):
                relation = RelationHint.CANCELLATION
            elif lx.DEADLINE_CHANGE_CUES.search(seg_text):
                relation = RelationHint.DEADLINE_CHANGE
            elif doc_reminder or negated_done or conditional_done:
                relation = RelationHint.REMINDER

            context = display_quote(" ".join(s.text for s in segments[max(0, idx - 1) : idx + 2]))
            title_line = f"{inp.title}\n" if inp.title else ""
            title = build_title(
                mask_dates(seg_text, [(m.start - seg.start, m.end - seg.start) for m in seg_mentions]),
                action,
                lang,
                entities,
                inp.title,
            )
            title = re.sub(r"\s*[#*_=~]{2,}\s*", " ", title).strip() or title  # template residue such as "-##"
            if _incomplete_title(title):
                uncertainties.append("title_incomplete")  # the full sentence stays in action_required
            tasks.append(
                CandidateTask(
                    title=title,
                    description=_clip(f"{title_line}{context}", 600),
                    category=category,
                    action_type=action,
                    action_required=_clip(display_quote(seg_text), 400),
                    due=due,
                    priority=_priority(context, category, action),
                    confidence=confidence,
                    evidence=evidence,
                    relation_hint=relation,
                    uncertainties=uncertainties,
                    entities=entities,
                )
            )

        if doc_change:
            for t in tasks:
                if t.relation_hint == RelationHint.REMINDER:
                    t.relation_hint = RelationHint.DEADLINE_CHANGE

        tasks = self._merge_within_document(tasks)
        signals = self._merge_signals(signals)
        if marketing >= 3:
            notes.append("suppressed_marketing_content")
            trace.append({"step": "rules.marketing_suppressed", "dropped_tasks": len(tasks)})
            tasks = []
            signals = []

        content_type = self._content_type(tasks, signals, marketing, doc_reminder, inp)
        trace.append(
            {
                "step": "rules.result",
                "tasks": len(tasks),
                "completion_signals": len(signals),
                "content_type": content_type.value,
            }
        )
        return ExtractionResult(
            content_type=content_type,
            is_actionable=bool(tasks),
            tasks=tasks,
            completion_signals=signals,
            extractor=f"{self.name}:{self.version}",
            notes=notes,
            trace=trace,
        )

    # -----------------------------------------------------------------------------------------

    @staticmethod
    def _page_ocr_confidence(inp: ExtractionInput, page: int | None) -> float | None:
        return None if page is None else inp.ocr_confidence.get(page)

    @staticmethod
    def _context_date(
        segments: list[Segment], idx: int, mentions: list[DateMention]
    ) -> tuple[DateMention | None, Segment | None, TimeSemantics]:
        # A following short "deadline line" (e.g. "Frist: 27.11.2026") without its own action.
        for j in range(idx + 1, min(len(segments), idx + 3)):
            seg = segments[j]
            if _is_instruction(seg):
                break
            cued = [m for m in _mentions_in(mentions, seg) if m.deadline_cue]
            if cued:
                return cued[0], seg, TimeSemantics.DEADLINE
        # A preceding appointment sentence ("Ihr Termin ist am 03.11. um 10:30 Uhr. Bitte bringen Sie ...").
        if idx > 0:
            prev = segments[idx - 1]
            prev_mentions = _mentions_in(mentions, prev)
            if prev_mentions and lx.APPOINTMENT_CUES.search(prev.text):
                return prev_mentions[0], prev, TimeSemantics.APPOINTMENT
        # A preceding deadline line without its own action, e.g. an invoice header
        # ("Due date: 10/28/2026" / "Fälligkeitsdatum: 28.10.2026" / "截止日期：…") above "Please pay ...".
        for j in range(idx - 1, max(-1, idx - 4), -1):
            seg = segments[j]
            if _is_instruction(seg):
                break  # an earlier instruction: its dates are its own
            cued = [m for m in _mentions_in(mentions, seg) if m.deadline_cue]
            if not cued:
                continue
            # A deadline line directly after an earlier instruction belongs to that instruction
            # (see the forward search above), not to this one.
            claimed = any(_is_instruction(segments[k]) for k in range(max(0, j - 2), j))
            return (None, None, TimeSemantics.DEADLINE) if claimed else (cued[0], seg, TimeSemantics.DEADLINE)
        return None, None, TimeSemantics.DEADLINE

    @staticmethod
    def _completion_signal(seg: Segment, context_entities: list[str]) -> CompletionSignal | None:
        for kind, pattern in lx.COMPLETION_PATTERNS:
            if not pattern.search(seg.text):
                continue
            uncertain = bool(lx.UNCERTAIN_CUES.search(seg.text))
            explicit = not uncertain and kind not in (CompletionKind.IN_REVIEW,)
            if kind == CompletionKind.IN_REVIEW:
                confidence = 0.5
            elif uncertain:
                confidence = 0.45
            elif kind == CompletionKind.CANCELLED:
                confidence = 0.7
            else:
                confidence = 0.85
            found = lx.detect_action(seg.text)
            entities = lx.detect_entities(seg.text) or context_entities
            if kind == CompletionKind.PAID or "tuition_fee" in entities:
                action = ActionType.PAY
            elif found is not None:
                action = found[0]
            elif kind == CompletionKind.RECEIVED:
                action = ActionType.SUBMIT
            else:
                action = ActionType.OTHER
            return CompletionSignal(
                subject=_clip(display_quote(seg.text), 300),
                kind=kind,
                evidence=Evidence(
                    quote=display_quote(seg.text), page=seg.page, start=seg.start, end=seg.end, kind="completion"
                ),
                confidence=confidence,
                explicit=explicit,
                entities=entities,
                action_type=action,
            )
        return None

    @staticmethod
    def _merge_signals(signals: list[CompletionSignal]) -> list[CompletionSignal]:
        """One signal per kind and message: the subject line ("Eingangsbestätigung") and the body
        sentence naming the object belong together."""
        merged: dict[CompletionKind, CompletionSignal] = {}
        for signal in signals:
            current = merged.get(signal.kind)
            if current is None:
                merged[signal.kind] = signal
                continue
            both_explicit = current.explicit and signal.explicit
            best = signal if len(signal.evidence.quote) > len(current.evidence.quote) else current
            merged[signal.kind] = best.model_copy(
                update={
                    "subject": _clip(f"{current.subject} {signal.subject}", 300),
                    "entities": list(dict.fromkeys([*current.entities, *signal.entities])),
                    "explicit": both_explicit,
                    "confidence": max(current.confidence, signal.confidence)
                    if both_explicit
                    else min(current.confidence, signal.confidence),
                    "action_type": current.action_type
                    if current.action_type != ActionType.OTHER
                    else signal.action_type,
                }
            )
        return list(merged.values())

    @staticmethod
    def _merge_within_document(tasks: list[CandidateTask]) -> list[CandidateTask]:
        merged: list[CandidateTask] = []
        for task in tasks:
            key_entities = {e for e in task.entities if lx.entity_weight(e) >= 0.6}
            twin = None
            for existing in merged:
                same_action = existing.action_type == task.action_type
                ex_entities = {e for e in existing.entities if lx.entity_weight(e) >= 0.6}
                same_object = bool(key_entities & ex_entities) or existing.title == task.title
                compatible_due = (
                    existing.due.date is None or task.due.date is None or existing.due.date == task.due.date
                )
                if same_action and same_object and compatible_due:
                    twin = existing
                    break
            if twin is None:
                merged.append(task)
                continue
            twin.evidence.extend(task.evidence)
            if twin.due.date is None and task.due.date is not None:
                twin.due = task.due
                twin.uncertainties = [u for u in twin.uncertainties if u != "no_deadline_found"]
            twin.confidence = min(RULES_CONFIDENCE_CAP, max(twin.confidence, task.confidence) + 0.05)
        return merged

    @staticmethod
    def _content_type(
        tasks: list[CandidateTask],
        signals: list[CompletionSignal],
        marketing: int,
        reminder: bool,
        inp: ExtractionInput,
    ) -> ContentType:
        if marketing >= 3:
            return ContentType.NEWSLETTER if lx.NEWSLETTER_CUES.search(inp.title or "") else ContentType.MARKETING
        if tasks:
            return ContentType.REMINDER if reminder else ContentType.OBLIGATION
        if signals:
            if all(s.kind == CompletionKind.IN_REVIEW for s in signals):
                return ContentType.STATUS_UPDATE
            return ContentType.COMPLETION_NOTICE
        return ContentType.INFORMATIONAL
