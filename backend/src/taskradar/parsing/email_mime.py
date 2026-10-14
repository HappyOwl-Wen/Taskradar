"""Email normalization for Gmail API message resources and RFC 822 (.eml) files.

Handles multipart MIME trees, charset decoding, HTML-only bodies, quoted-reply trimming and
attachment discovery. The output (:class:`NormalizedMessage`) is source-agnostic.
"""

from __future__ import annotations

import base64
import datetime as dt
import email
import email.policy
import email.utils
import hashlib
import re
from collections.abc import Iterable
from typing import Any
from urllib.parse import quote

from taskradar.domain.schemas import AttachmentRef, NormalizedMessage
from taskradar.parsing.html_text import html_to_text, normalize_whitespace

ATTACHMENT_MIME_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/webp"}
_MAX_BODY_CHARS = 60_000

_QUOTE_HEADERS = [
    re.compile(r"^On .{3,200} wrote:\s*$", re.I),
    re.compile(r"^Am .{3,200} schrieb .{0,200}:\s*$", re.I),
    re.compile(r"^在.{3,200}写道[:：]\s*$"),
    re.compile(r"^-{2,}\s*(Original Message|Ursprüngliche Nachricht|原始邮件|Forwarded message|Weitergeleitete Nachricht)\s*-{2,}", re.I),
    re.compile(r"^_{10,}\s*$"),
]
_OUTLOOK_FROM = re.compile(r"^(From|Von|发件人)\s*[:：]", re.I)
_OUTLOOK_NEXT = re.compile(r"^(Sent|Date|Gesendet|Datum|发送时间|日期|To|An|收件人)\s*[:：]", re.I)


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _header_map(headers: Iterable[dict[str, str]] | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for h in headers or []:
        name = (h.get("name") or "").lower()
        if name and name not in result:
            result[name] = h.get("value") or ""
    return result


def _charset_from_headers(headers: dict[str, str]) -> str:
    ctype = headers.get("content-type", "")
    match = re.search(r'charset="?([A-Za-z0-9_\-:.]+)"?', ctype, re.I)
    return match.group(1) if match else "utf-8"


def _decode_bytes(raw: bytes, charset: str) -> str:
    for cs in (charset, "utf-8", "latin-1"):
        try:
            return raw.decode(cs)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")  # pragma: no cover


def strip_quoted_text(text: str) -> str:
    """Remove quoted previous messages (replies/forwards) to avoid re-extracting old content."""
    lines = text.split("\n")
    cut = len(lines)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if any(p.match(stripped) for p in _QUOTE_HEADERS):
            cut = i
            break
        if _OUTLOOK_FROM.match(stripped) and i + 1 < len(lines) and _OUTLOOK_NEXT.match(lines[i + 1].strip()):
            cut = i
            break
    kept = [ln for ln in lines[:cut] if not ln.lstrip().startswith(">")]
    result = "\n".join(kept).strip()
    # Never strip everything: a pure forward still carries the content we need.
    return result if len(result) >= 2 else text


def sender_domain(sender: str) -> str | None:
    _, addr = email.utils.parseaddr(sender)
    if "@" in addr:
        return addr.rsplit("@", 1)[1].lower()
    return None


def _is_bulk(headers: dict[str, str]) -> bool:
    if headers.get("list-unsubscribe") or headers.get("list-id"):
        return True
    if headers.get("precedence", "").lower() in {"bulk", "list", "junk"}:
        return True
    return False


def gmail_web_link(message_id: str, account: str | None = None) -> str:
    if account:
        return f"https://mail.google.com/mail/?authuser={quote(account)}#all/{message_id}"
    return f"https://mail.google.com/mail/u/0/#all/{message_id}"


# ---------------------------------------------------------------------------------------------
# Gmail API format=full
# ---------------------------------------------------------------------------------------------


def _walk_gmail_parts(part: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield part
    for child in part.get("parts") or []:
        yield from _walk_gmail_parts(child)


def parse_gmail_message(resource: dict[str, Any]) -> NormalizedMessage:
    payload = resource.get("payload") or {}
    headers = _header_map(payload.get("headers"))

    plain: list[str] = []
    html: list[str] = []
    attachments: list[AttachmentRef] = []
    for part in _walk_gmail_parts(payload):
        mime = (part.get("mimeType") or "").lower()
        filename = part.get("filename") or ""
        body = part.get("body") or {}
        part_headers = _header_map(part.get("headers"))
        disposition = part_headers.get("content-disposition", "").lower()
        if filename or body.get("attachmentId") or disposition.startswith("attachment"):
            if mime in ATTACHMENT_MIME_TYPES and filename:
                inline = _b64url_decode(body["data"]) if body.get("data") else None
                attachments.append(
                    AttachmentRef(
                        filename=filename,
                        mime_type=mime,
                        size=int(body.get("size") or 0),
                        attachment_id=body.get("attachmentId"),
                        inline_data=inline,
                    )
                )
            continue
        data = body.get("data")
        if not data:
            continue
        text = _decode_bytes(_b64url_decode(data), _charset_from_headers(part_headers or headers))
        if mime == "text/plain":
            plain.append(text)
        elif mime == "text/html":
            html.append(text)

    if plain and any(p.strip() for p in plain):
        body_text = normalize_whitespace("\n\n".join(plain))
    elif html:
        body_text = html_to_text("\n".join(html))
    else:
        body_text = normalize_whitespace(resource.get("snippet") or "")
    body_text = strip_quoted_text(body_text)[:_MAX_BODY_CHARS]

    sent_at: dt.datetime | None = None
    internal = resource.get("internalDate")
    if internal:
        sent_at = dt.datetime.fromtimestamp(int(internal) / 1000, tz=dt.UTC)
    elif headers.get("date"):
        sent_at = _parse_date_header(headers["date"])

    sender = headers.get("from", "")
    return NormalizedMessage(
        external_id=str(resource.get("id")),
        thread_id=resource.get("threadId"),
        history_id=str(resource["historyId"]) if resource.get("historyId") else None,
        rfc822_message_id=headers.get("message-id"),
        subject=headers.get("subject", "").strip(),
        sender=sender,
        sender_domain=sender_domain(sender),
        recipients=headers.get("to", ""),
        sent_at=sent_at,
        snippet=resource.get("snippet") or "",
        body_text=body_text,
        labels=list(resource.get("labelIds") or []),
        is_bulk=_is_bulk(headers),
        attachments=attachments,
    )


def _parse_date_header(value: str) -> dt.datetime | None:
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


# ---------------------------------------------------------------------------------------------
# RFC 822 (.eml upload)
# ---------------------------------------------------------------------------------------------


def parse_eml_bytes(data: bytes, max_attachment_bytes: int = 15 * 1024 * 1024) -> NormalizedMessage:
    msg = email.message_from_bytes(data, policy=email.policy.default)
    headers = {k.lower(): str(v) for k, v in msg.items()}

    body_text = ""
    body = msg.get_body(preferencelist=("plain", "html"))  # type: ignore[attr-defined]
    if body is not None:
        content = body.get_content()
        if body.get_content_type() == "text/html":
            body_text = html_to_text(content)
        else:
            body_text = normalize_whitespace(content)
    body_text = strip_quoted_text(body_text)[:_MAX_BODY_CHARS]

    attachments: list[AttachmentRef] = []
    for part in msg.iter_attachments():  # type: ignore[attr-defined]
        ctype = part.get_content_type()
        filename = part.get_filename() or ""
        if ctype not in ATTACHMENT_MIME_TYPES or not filename:
            continue
        payload = part.get_payload(decode=True) or b""
        if len(payload) > max_attachment_bytes:
            continue
        attachments.append(
            AttachmentRef(filename=filename, mime_type=ctype, size=len(payload), inline_data=payload)
        )

    message_id = headers.get("message-id") or ""
    external_id = message_id.strip("<>") or hashlib.sha256(data).hexdigest()
    sender = headers.get("from", "")
    return NormalizedMessage(
        external_id=external_id,
        thread_id=None,
        rfc822_message_id=message_id or None,
        subject=headers.get("subject", "").strip(),
        sender=sender,
        sender_domain=sender_domain(sender),
        recipients=headers.get("to", ""),
        sent_at=_parse_date_header(headers["date"]) if headers.get("date") else None,
        snippet=body_text[:200],
        body_text=body_text,
        labels=[],
        is_bulk=_is_bulk(headers),
        attachments=attachments,
    )


def message_content_hash(msg: NormalizedMessage) -> str:
    digest = hashlib.sha256()
    for piece in (msg.subject, msg.sender, msg.body_text, ",".join(a.filename for a in msg.attachments)):
        digest.update(piece.encode("utf-8", errors="replace"))
        digest.update(b"\x00")
    return digest.hexdigest()
