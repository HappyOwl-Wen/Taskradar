"""File type detection by magic bytes and safe filename handling.

Uploaded files are never trusted by extension or by the client-provided MIME type alone.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

MAX_FILENAME_LENGTH = 120

_WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

SUPPORTED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".eml"}


@dataclass(frozen=True)
class SniffedType:
    kind: str  # "pdf" | "image" | "email"
    mime_type: str
    extension: str


class UnsupportedFileError(ValueError):
    code = "unsupported_file_type"


def sniff_bytes(head: bytes, filename: str | None = None) -> SniffedType:
    """Identify a file from its first bytes. Raises :class:`UnsupportedFileError`."""
    if head.startswith(b"%PDF-") or b"%PDF-" in head[:1024]:
        return SniffedType("pdf", "application/pdf", ".pdf")
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return SniffedType("image", "image/png", ".png")
    if head.startswith(b"\xff\xd8\xff"):
        return SniffedType("image", "image/jpeg", ".jpg")
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return SniffedType("image", "image/webp", ".webp")
    if filename and Path(filename).suffix.lower() == ".eml" and _looks_like_rfc822(head):
        return SniffedType("email", "message/rfc822", ".eml")
    raise UnsupportedFileError("Unsupported or unrecognised file content")


def _looks_like_rfc822(head: bytes) -> bool:
    try:
        sample = head[:4096].decode("utf-8", errors="replace")
    except Exception:  # pragma: no cover
        return False
    header_names = ("from:", "subject:", "date:", "to:", "message-id:", "mime-version:", "received:")
    lines = [ln.lower() for ln in sample.splitlines()[:60]]
    return sum(1 for ln in lines if ln.startswith(header_names)) >= 2


def sanitize_filename(name: str | None, fallback: str = "file") -> str:
    """Return a display-safe file name: no path components, control chars or reserved names."""
    if not name:
        return fallback
    # Drop any path component, including Windows and POSIX separators and drive letters.
    name = name.replace("\\", "/").split("/")[-1]
    name = re.sub(r"^[A-Za-z]:", "", name)
    name = unicodedata.normalize("NFC", name)
    name = "".join(ch for ch in name if unicodedata.category(ch)[0] != "C")
    name = re.sub(r'[<>:"|?*]', "_", name)
    name = name.strip().strip(".").strip()
    if not name:
        return fallback
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    if stem.upper() in _WINDOWS_RESERVED or name.upper() in _WINDOWS_RESERVED:
        stem = f"_{stem}"
    ext = ext[:10]
    max_stem = MAX_FILENAME_LENGTH - (len(ext) + 1 if ext else 0)
    stem = stem[:max_stem] or fallback
    return f"{stem}.{ext}" if ext else stem


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()
