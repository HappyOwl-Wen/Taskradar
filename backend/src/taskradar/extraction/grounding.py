"""Evidence grounding: verify that quotes returned by a model really occur in the source."""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

from taskradar.domain.schemas import Evidence, ExtractionInput

_WS = re.compile(r"\s+")


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'")
    return _WS.sub(" ", text).strip()


def locate_quote(quote: str, source: str) -> tuple[int, int] | None:
    """Return (start, end) offsets of ``quote`` in ``source`` or None.

    Exact (whitespace/case-insensitive) matches are preferred; a fuzzy match is accepted only
    when >= 90% of the quote is matched contiguously, which tolerates OCR noise and the model
    normalising punctuation, but rejects invented text.
    """
    if not quote or not quote.strip():
        return None
    q = _norm(quote)
    if len(q) < 4:
        return None
    # Build a normalised copy of the source with an index map back to original offsets.
    norm_chars: list[str] = []
    index_map: list[int] = []
    prev_space = False
    for i, ch in enumerate(source):
        c = unicodedata.normalize("NFKC", ch).lower()
        c = c.replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'")
        if c.isspace():
            if prev_space or not norm_chars:
                continue
            c = " "
            prev_space = True
        else:
            prev_space = False
        for sub in c:
            norm_chars.append(sub)
            index_map.append(i)
    norm_source = "".join(norm_chars)
    pos = norm_source.find(q)
    if pos != -1:
        return index_map[pos], index_map[min(pos + len(q) - 1, len(index_map) - 1)] + 1
    matcher = SequenceMatcher(None, norm_source, q, autojunk=False)
    match = matcher.find_longest_match(0, len(norm_source), 0, len(q))
    if match.size >= max(8, int(len(q) * 0.9)):
        start = index_map[match.a]
        end = index_map[min(match.a + match.size - 1, len(index_map) - 1)] + 1
        return start, end
    return None


def ground_evidence(quotes: list[str], inp: ExtractionInput, kind: str = "action") -> list[Evidence]:
    evidence: list[Evidence] = []
    for quote in quotes:
        quote = quote.strip()[:500]
        if not quote:
            continue
        span = locate_quote(quote, inp.text)
        if span is None:
            evidence.append(Evidence(quote=quote, verified=False, kind=kind))  # type: ignore[arg-type]
        else:
            start, end = span
            evidence.append(
                Evidence(
                    quote=inp.text[start:end],
                    page=inp.locate(start),
                    start=start,
                    end=end,
                    verified=True,
                    kind=kind,  # type: ignore[arg-type]
                )
            )
    return evidence


INJECTION_PATTERNS = re.compile(
    r"ignore (?:all |any )?(?:previous|prior|above) (?:instructions|prompts)|disregard (?:all |the )?(?:previous|above)|"
    r"system prompt|you are now|act as (?:an? )?(?:assistant|ai|admin)|"
    r"忽略(?:之前|以上|所有)的?(?:指令|指示|提示)|你现在是|系统提示|"
    r"ignoriere (?:alle )?(?:vorherigen|bisherigen) (?:Anweisungen|Instruktionen)|"
    r"(?:rm -rf|powershell -|cmd\.exe|curl .{0,40}\|\s*(?:sh|bash))",
    re.I,
)


def looks_like_prompt_injection(text: str) -> bool:
    return bool(INJECTION_PATTERNS.search(text))
