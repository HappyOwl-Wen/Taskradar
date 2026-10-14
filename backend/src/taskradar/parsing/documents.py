"""PDF and image text extraction.

Pipeline: identify -> direct text extraction (PDF text layer) -> OCR only where needed.
Original files are opened read-only and never modified, moved or deleted.
"""

from __future__ import annotations

import logging
import re
import warnings
from pathlib import Path

import pymupdf
from PIL import Image, UnidentifiedImageError

from taskradar.domain.schemas import PageText, ParsedDocument
from taskradar.parsing.language import detect_language
from taskradar.parsing.ocr import OCREngine, OCRError, OCRUnavailableError

log = logging.getLogger(__name__)

MAX_PDF_PAGES = 200
MIN_TEXT_CHARS_PER_PAGE = 25
OCR_RENDER_DPI = 300
MAX_IMAGE_PIXELS = 60_000_000


class DocumentParseError(RuntimeError):
    code = "parse_failed"


class EmptyFileError(DocumentParseError):
    code = "empty_file"


class CorruptedFileError(DocumentParseError):
    code = "corrupted_file"


class EncryptedFileError(DocumentParseError):
    code = "encrypted_file"


class FileTooLargeError(DocumentParseError):
    code = "file_too_large"


class OCRFailedError(DocumentParseError):
    code = "ocr_failed"


def parse_document(path: Path, kind: str, ocr: OCREngine) -> ParsedDocument:
    if not path.is_file():
        raise DocumentParseError(f"File not found: {path.name}")
    if path.stat().st_size == 0:
        raise EmptyFileError("The file is empty")
    if kind == "pdf":
        return parse_pdf(path, ocr)
    if kind == "image":
        return parse_image(path, ocr)
    raise DocumentParseError(f"Unsupported document kind: {kind}")


def _finalize(
    kind: str, pages: list[PageText], page_count: int, ocr_engine: str | None, warnings_: list[str]
) -> ParsedDocument:
    from taskradar.extraction.dates import detect_document_date

    methods = {p.method for p in pages if p.text.strip()}
    if not methods:
        method = "none"
    elif methods == {"text"}:
        method = "text"
    elif methods == {"ocr"}:
        method = "ocr"
    else:
        method = "mixed"
    full_text = "\n\n".join(p.text for p in pages if p.text.strip())
    return ParsedDocument(
        kind=kind,  # type: ignore[arg-type]
        pages=pages,
        page_count=page_count,
        extraction_method=method,  # type: ignore[arg-type]
        language=detect_language(full_text),
        doc_date=detect_document_date(full_text),
        ocr_engine=ocr_engine if "ocr" in methods else None,
        warnings=warnings_,
    )


def parse_pdf(path: Path, ocr: OCREngine) -> ParsedDocument:
    try:
        doc = pymupdf.open(path, filetype="pdf")
    except (pymupdf.FileDataError, RuntimeError, ValueError) as exc:
        raise CorruptedFileError(f"The PDF could not be opened: {exc}") from exc

    warnings_: list[str] = []
    pages: list[PageText] = []
    used_ocr = False
    try:
        if doc.needs_pass or doc.is_encrypted:
            raise EncryptedFileError("The PDF is password protected")
        page_count = doc.page_count
        if page_count == 0:
            raise CorruptedFileError("The PDF has no readable pages")
        if page_count > MAX_PDF_PAGES:
            warnings_.append(f"only_first_{MAX_PDF_PAGES}_pages_processed")
        ocr_ready = ocr.available()
        for index in range(min(page_count, MAX_PDF_PAGES)):
            try:
                page = doc.load_page(index)
                # Reading order; PyMuPDF separates blocks with blank lines - collapse them so that
                # sentences wrapped across lines can be re-joined by the extractor.
                text = re.sub(r"\n[ \t]*\n+", "\n", page.get_text("text", sort=True) or "")
            except (RuntimeError, ValueError) as exc:
                warnings_.append(f"page_{index + 1}_unreadable")
                log.warning("Failed to read PDF page %s: %s", index + 1, exc)
                pages.append(PageText(page=index + 1, text="", method="none"))
                continue
            if len(text.strip()) >= MIN_TEXT_CHARS_PER_PAGE:
                pages.append(PageText(page=index + 1, text=text.strip(), method="text"))
                continue
            if not ocr_ready:
                if "ocr_unavailable" not in warnings_:
                    warnings_.append("ocr_unavailable")
                pages.append(PageText(page=index + 1, text=text.strip(), method="text" if text.strip() else "none"))
                continue
            try:
                pix = page.get_pixmap(dpi=OCR_RENDER_DPI, colorspace=pymupdf.csGRAY, alpha=False)
                image = Image.frombytes("L", (pix.width, pix.height), pix.samples)
                result = ocr.recognize(image)
                used_ocr = True
                merged = result.text if len(result.text) >= len(text.strip()) else text.strip()
                pages.append(PageText(page=index + 1, text=merged, method="ocr", ocr_confidence=result.confidence))
            except OCRUnavailableError:
                warnings_.append("ocr_unavailable")
                pages.append(PageText(page=index + 1, text=text.strip(), method="none"))
            except OCRError as exc:
                warnings_.append(f"page_{index + 1}_ocr_failed")
                log.warning("OCR failed on page %s: %s", index + 1, exc)
                pages.append(PageText(page=index + 1, text=text.strip(), method="none"))
    finally:
        doc.close()
    return _finalize("pdf", pages, page_count, ocr.name if used_ocr else None, warnings_)


def parse_image(path: Path, ocr: OCREngine) -> ParsedDocument:
    previous_limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            try:
                with Image.open(path) as probe:
                    probe.verify()
                with Image.open(path) as img:
                    img.load()
                    image = img.copy()
            except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
                raise FileTooLargeError("The image is too large to process safely") from exc
            except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
                raise CorruptedFileError(f"The image could not be decoded: {exc}") from exc
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit

    if not ocr.available():
        return _finalize("image", [PageText(page=1, text="", method="none")], 1, None, ["ocr_unavailable"])
    try:
        result = ocr.recognize(image)
    except OCRUnavailableError:
        return _finalize("image", [PageText(page=1, text="", method="none")], 1, None, ["ocr_unavailable"])
    except OCRError as exc:
        raise OCRFailedError(f"OCR failed: {exc}") from exc
    page = PageText(page=1, text=result.text, method="ocr", ocr_confidence=result.confidence)
    return _finalize("image", [page], 1, result.engine, [])
