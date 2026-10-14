"""Text normalisation and similarity measures that work across zh / de / en."""

from __future__ import annotations

import re
import unicodedata

from taskradar.domain.enums import ActionType
from taskradar.extraction import lexicon as lx

_CJK_RUN = re.compile(f"[{chr(0x4E00)}-{chr(0x9FFF)}]+")
_LATIN_WORD = re.compile(r"[a-zäöüß0-9]+")
_NON_WORD = re.compile(r"[\W_]+", re.UNICODE)

STOPWORDS = {
    # en
    "the", "a", "an", "your", "you", "our", "to", "of", "for", "by", "and", "or", "please", "in", "on", "at",
    "with", "is", "are", "be", "this", "that", "kindly",
    # de
    "die", "der", "das", "den", "dem", "des", "und", "oder", "bitte", "ihre", "ihren", "ihr", "ihrem", "sie",
    "für", "bis", "zum", "zur", "von", "mit", "im", "in", "an", "am", "auf", "ein", "eine", "einen",
    # zh (single characters are covered by bigrams; these are common function words)
    "请", "您", "的", "于", "前", "在", "和", "及",
}

# Actions that are interchangeable when the object is the same.
_COMPATIBLE: list[set[ActionType]] = [
    {ActionType.SUBMIT, ActionType.UPLOAD, ActionType.SIGN, ActionType.PREPARE},
    {ActionType.REGISTER, ActionType.APPLY, ActionType.BOOK},
    {ActionType.REPLY, ActionType.CONFIRM},
    {ActionType.PAY},
    {ActionType.RENEW, ActionType.APPLY},
    {ActionType.ATTEND, ActionType.BRING},
]


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = _NON_WORD.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def shingles(text: str) -> set[str]:
    """CJK character bigrams + Latin word tokens + trigrams of long words (compound/plural tolerant)."""
    norm = normalize(text)
    result: set[str] = set()
    for run in _CJK_RUN.findall(norm):
        if len(run) == 1:
            result.add(run)
        for i in range(len(run) - 1):
            result.add(run[i : i + 2])
    for word in _LATIN_WORD.findall(norm):
        if word in STOPWORDS or len(word) < 2:
            continue
        result.add(word)
        if len(word) >= 7:
            for i in range(len(word) - 2):
                result.add("#" + word[i : i + 3])
    return result


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def text_similarity(a: str, b: str) -> float:
    sa, sb = shingles(a), shingles(b)
    if not sa or not sb:
        return 0.0
    # Containment is more robust than Jaccard when one text is a short title and the other a sentence.
    overlap = len(sa & sb)
    return max(overlap / len(sa | sb), 0.85 * overlap / min(len(sa), len(sb)))


def action_similarity(a: ActionType, b: ActionType) -> float:
    if a == b:
        return 1.0
    if {a, b} & {ActionType.OTHER, ActionType.PREPARE}:
        # Generic verbs ("complete", "完成", "erledigen") are compatible with anything.
        return 0.5
    for group in _COMPATIBLE:
        if a in group and b in group:
            return 0.7
    return 0.0


_GENERIC_CJK_TERMS = (
    "截止日期", "截止时间", "截止", "提交", "通知", "提醒", "请于", "请在", "之前", "以前", "时间", "日期", "同学",
    "各位", "您的", "我们", "已经", "收到", "完成", "需要", "办理", "注册",
)
_GENERIC_LATIN = {
    "please", "submit", "deadline", "reminder", "friendly", "required", "action", "document", "documents",
    "erinnerung", "unterlagen", "bitte", "termin", "appointment", "einreichen", "regards", "grüßen",
    "freundlichen", "geehrte", "geehrter", "received", "erhalten", "information", "informationen",
}
_NUMBER = re.compile(r"(?<![\d.,/])\d{3,}(?![\d.,/])")


def _cjk_core(text: str) -> list[str]:
    runs = _CJK_RUN.findall(normalize(text))
    cleaned: list[str] = []
    for run in runs:
        for term in _GENERIC_CJK_TERMS:
            run = run.replace(term, "|")
        cleaned.extend(part for part in run.split("|") if len(part) >= 2)
    return cleaned


def _longest_common_run(a: list[str], b: list[str]) -> int:
    from difflib import SequenceMatcher

    best = 0
    for ra in a:
        for rb in b:
            match = SequenceMatcher(None, ra, rb, autojunk=False).find_longest_match(0, len(ra), 0, len(rb))
            best = max(best, match.size)
    return best


def object_overlap(a: str, b: str) -> float:
    """Evidence that two texts name the same *specific* object: a shared multi-character CJK term
    ("实验报告"), a shared uncommon word ("Lernvereinbarung", "agreement(s)") or a shared reference
    number such as an invoice number. Generic words never count."""
    score = 0.0
    common_cjk = _longest_common_run(_cjk_core(a), _cjk_core(b))
    if common_cjk >= 4:
        score = 0.8
    elif common_cjk >= 3:
        score = 0.6
    words_a = {w for w in _LATIN_WORD.findall(normalize(a)) if len(w) >= 6 and not w.isdigit()
               and w not in STOPWORDS and w not in _GENERIC_LATIN}
    words_b = {w for w in _LATIN_WORD.findall(normalize(b)) if len(w) >= 6 and not w.isdigit()
               and w not in STOPWORDS and w not in _GENERIC_LATIN}
    shared = {wa for wa in words_a for wb in words_b if wa == wb or (len(wa) >= 7 and wa[:7] == wb[:7])}
    if shared:
        score = max(score, 0.8 if len(shared) >= 2 else 0.6)
    numbers_a = {n for n in _NUMBER.findall(a) if not (len(n) == 4 and n.startswith(("19", "20")))}
    numbers_b = {n for n in _NUMBER.findall(b) if not (len(n) == 4 and n.startswith(("19", "20")))}
    if numbers_a & numbers_b:
        score = max(score, 0.8)
    return score


def entity_similarity(a: list[str], b: list[str]) -> float | None:
    """Weighted Jaccard over canonical *specific* entities. None when either side has none
    (generic entities such as "documents" or "appointment" never identify an obligation)."""
    strong_a = {e for e in a if lx.entity_weight(e) >= 0.6}
    strong_b = {e for e in b if lx.entity_weight(e) >= 0.6}
    if not strong_a or not strong_b:
        return None
    inter = sum(lx.entity_weight(e) for e in strong_a & strong_b)
    union = sum(lx.entity_weight(e) for e in strong_a | strong_b)
    return inter / union if union else 0.0


def fingerprint(action: ActionType, entities: list[str], title: str) -> str:
    strong = sorted(e for e in entities if lx.entity_weight(e) >= 0.6)
    key = ",".join(strong) if strong else normalize(title)[:60]
    return f"{action.value}|{key}"[:255]
