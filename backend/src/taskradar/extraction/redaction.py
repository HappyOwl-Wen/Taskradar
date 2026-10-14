"""Data minimisation before content is sent to a cloud model.

Removes identifiers that are never needed to understand an obligation (IBANs, card numbers,
phone numbers, student / tax IDs, e-mail local parts) and truncates long inputs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b")
_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_PHONE = re.compile(r"(?<![\w.])(?:\+|00|0)\d[\d \-/().]{7,18}\d(?![\w.])")
_DATE_LIKE = re.compile(r"^\s*\d{1,4}[-./]\d{1,2}[-./]\d{1,4}\s*$")
_LABELLED_ID = re.compile(
    r"((?:Matrikel(?:nummer|nr\.?)?|Matriculation (?:number|no\.?)|Student ID|学号|Steuer-?ID|"
    r"Steueridentifikationsnummer|Tax ID|Passport (?:No\.?|number)|Reisepass(?:nummer)?|护照号(?:码)?|"
    r"Kundennummer|Customer (?:No\.?|number)|Versichertennummer|Aktenzeichen|Case (?:No\.?|number))\s*[:：#]?\s*)"
    r"([A-Z0-9][A-Z0-9\-/ ]{3,24}[A-Z0-9])",
    re.I,
)
_EMAIL = re.compile(r"\b([A-Za-z0-9._%+\-]+)@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b")


def _luhn_ok(number: str) -> bool:
    digits = [int(c) for c in number if c.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    checksum = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


@dataclass
class RedactionResult:
    text: str
    count: int
    truncated: bool


def redact_for_llm(text: str, *, max_chars: int = 12000, redact_identifiers: bool = True) -> RedactionResult:
    count = 0
    if redact_identifiers:
        def _sub(pattern: re.Pattern[str], repl: str, value: str) -> str:
            nonlocal count
            new, n = pattern.subn(repl, value)
            count += n
            return new

        text = _sub(_IBAN, "[IBAN]", text)
        text = _sub(_LABELLED_ID, r"\1[ID]", text)

        def _card(m: re.Match[str]) -> str:
            nonlocal count
            if _luhn_ok(m.group(0)):
                count += 1
                return "[CARD]"
            return m.group(0)

        text = _CARD.sub(_card, text)

        def _phone(m: re.Match[str]) -> str:
            nonlocal count
            value = m.group(0)
            if _DATE_LIKE.match(value) or sum(c.isdigit() for c in value) < 9:
                return value
            count += 1
            return "[PHONE]"

        text = _PHONE.sub(_phone, text)

        def _email(m: re.Match[str]) -> str:
            nonlocal count
            count += 1
            return f"[EMAIL]@{m.group(2)}"

        text = _EMAIL.sub(_email, text)

    truncated = False
    if len(text) > max_chars:
        head = int(max_chars * 0.8)
        tail = max_chars - head
        text = text[:head] + "\n[... content truncated ...]\n" + text[-tail:]
        truncated = True
    return RedactionResult(text=text, count=count, truncated=truncated)
