"""Convert untrusted HTML (email bodies) into plain text. HTML is never rendered in the UI."""

from __future__ import annotations

import re
import warnings

from bs4 import BeautifulSoup, MarkupResemblesLocatorWarning

_NBSP = chr(0x00A0)
_ZWSP = chr(0x200B)

_BLOCK_TAGS = {
    "p",
    "div",
    "br",
    "tr",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "section",
    "article",
    "header",
    "footer",
    "blockquote",
    "ul",
    "ol",
    "hr",
    "pre",
}
_DROP_TAGS = ["script", "style", "head", "title", "noscript", "template", "svg", "iframe", "object"]


def html_to_text(html: str) -> str:
    if not html:
        return ""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", MarkupResemblesLocatorWarning)
        soup = BeautifulSoup(html, "html.parser")
    for tag in soup(_DROP_TAGS):
        tag.decompose()
    # Hidden preheader text is a classic place for invisible marketing (or injection) content.
    for tag in soup.find_all(style=re.compile(r"display\s*:\s*none", re.I)):
        tag.decompose()
    for tag in soup.find_all(True):
        if tag.name == "br":
            tag.replace_with("\n")
        elif tag.name in _BLOCK_TAGS:
            tag.insert_before("\n")
            tag.insert_after("\n")
        elif tag.name == "td":
            tag.insert_after(" ")
    text = soup.get_text()
    return normalize_whitespace(text)


def normalize_whitespace(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace(_NBSP, " ").replace(_ZWSP, "")
    lines = [re.sub(r"[ \t\f\v]+", " ", line).strip() for line in text.split("\n")]
    out: list[str] = []
    blank = 0
    for line in lines:
        if not line:
            blank += 1
            if blank <= 1:
                out.append("")
        else:
            blank = 0
            out.append(line)
    return "\n".join(out).strip()
