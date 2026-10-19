"""Lightweight language identification for zh / de / en (no external models)."""

from __future__ import annotations

import re

_CJK = re.compile(r"[一-鿿]")
_LATIN_WORD = re.compile(r"[A-Za-zÄÖÜäöüß]+")

_DE_WORDS = {
    "und",
    "die",
    "der",
    "das",
    "bitte",
    "sie",
    "ihre",
    "ihr",
    "bis",
    "zum",
    "zur",
    "nicht",
    "mit",
    "für",
    "ist",
    "sind",
    "eine",
    "einen",
    "wir",
    "uns",
    "den",
    "dem",
    "des",
    "auf",
    "frist",
    "spätestens",
    "unterlagen",
    "sehr",
    "geehrte",
    "geehrter",
    "grüßen",
    "freundlichen",
    "termin",
}
_EN_WORDS = {
    "the",
    "and",
    "please",
    "your",
    "you",
    "by",
    "to",
    "of",
    "for",
    "is",
    "are",
    "we",
    "our",
    "with",
    "before",
    "deadline",
    "dear",
    "regards",
    "submit",
    "this",
    "that",
    "will",
    "have",
    "has",
}


def detect_language(text: str) -> str | None:
    """Return ``"zh"``, ``"de"``, ``"en"`` or ``None`` if undecidable."""
    if not text or not text.strip():
        return None
    sample = text[:5000]
    cjk = len(_CJK.findall(sample))
    words = [w.lower() for w in _LATIN_WORD.findall(sample)]
    if cjk >= 5 and cjk >= len(words) * 0.5:
        return "zh"
    if not words:
        return "zh" if cjk else None
    de = sum(1 for w in words if w in _DE_WORDS) + 2 * sum(1 for w in words if any(c in w for c in "äöüß"))
    en = sum(1 for w in words if w in _EN_WORDS)
    if de == 0 and en == 0:
        return "zh" if cjk else None
    return "de" if de > en else "en"
