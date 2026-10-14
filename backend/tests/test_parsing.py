"""Document parsing (text PDF, scanned PDF, image OCR, broken files) and e-mail normalization."""

from __future__ import annotations

import base64
import datetime as dt
from pathlib import Path

import pymupdf
import pytest
from PIL import Image

from taskradar.parsing.documents import (
    CorruptedFileError,
    EmptyFileError,
    EncryptedFileError,
    FileTooLargeError,
    OCRFailedError,
    parse_document,
)
from taskradar.parsing.email_mime import gmail_web_link, parse_eml_bytes, parse_gmail_message, strip_quoted_text
from taskradar.parsing.filetypes import UnsupportedFileError, sanitize_filename, sniff_bytes
from taskradar.parsing.html_text import html_to_text
from taskradar.parsing.language import detect_language
from taskradar.parsing.ocr import NullOCREngine, OCRError, OCRResult, TesseractEngine, tidy_ocr_text

from .conftest import SAMPLES, requires_ocr

OCR = TesseractEngine()


# ---------------------------------------------------------------------------------------------
# PDFs and images
# ---------------------------------------------------------------------------------------------


def test_text_pdf_uses_text_layer_without_ocr() -> None:
    class ExplodingOCR(NullOCREngine):
        def available(self) -> bool:
            return True

        def recognize(self, image: Image.Image) -> OCRResult:  # pragma: no cover - must not be called
            raise AssertionError("OCR must not run for PDFs with a text layer")

    doc = parse_document(SAMPLES / "01_zh_enrollment_certificate_notice.pdf", "pdf", ExplodingOCR())
    assert doc.extraction_method == "text"
    assert doc.page_count == 1
    assert "2026年11月20日" in doc.text
    assert "Immatrikulationsbescheinigung" in doc.text
    assert doc.language == "zh"
    assert doc.doc_date == dt.date(2026, 10, 12)


@requires_ocr
def test_scanned_pdf_falls_back_to_ocr() -> None:
    doc = parse_document(SAMPLES / "05_zh_course_registration_scan.pdf", "pdf", OCR)
    assert doc.extraction_method == "ocr"
    assert doc.ocr_engine == "tesseract"
    assert "选课" in doc.text
    assert "2026" in doc.text and "11" in doc.text
    assert doc.pages[0].ocr_confidence is not None and doc.pages[0].ocr_confidence > 0.7


@requires_ocr
def test_german_screenshot_ocr() -> None:
    doc = parse_document(SAMPLES / "02_de_residence_permit_documents.png", "image", OCR)
    assert doc.extraction_method == "ocr"
    assert "27.11.2026" in doc.text
    assert "Aufenthaltstitel" in doc.text
    assert doc.language == "de"


@requires_ocr
def test_chinese_screenshot_ocr() -> None:
    doc = parse_document(SAMPLES / "04_zh_enrollment_certificate_reminder.png", "image", OCR)
    assert "提交在读证明" in doc.text
    assert doc.language == "zh"


def test_scanned_pdf_without_ocr_engine_reports_warning() -> None:
    doc = parse_document(SAMPLES / "05_zh_course_registration_scan.pdf", "pdf", NullOCREngine())
    assert doc.extraction_method == "none"
    assert "ocr_unavailable" in doc.warnings


def test_empty_file(tmp_path: Path) -> None:
    empty = tmp_path / "empty.pdf"
    empty.write_bytes(b"")
    with pytest.raises(EmptyFileError):
        parse_document(empty, "pdf", NullOCREngine())


def test_corrupted_pdf(tmp_path: Path) -> None:
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.7\n" + b"\x00garbage" * 200)
    with pytest.raises(CorruptedFileError):
        parse_document(broken, "pdf", NullOCREngine())


def test_truncated_pdf_is_handled(tmp_path: Path) -> None:
    data = (SAMPLES / "06_en_rental_contract.pdf").read_bytes()
    truncated = tmp_path / "truncated.pdf"
    truncated.write_bytes(data[: len(data) // 3])
    try:
        doc = parse_document(truncated, "pdf", NullOCREngine())
    except CorruptedFileError:
        return  # rejecting is fine
    assert doc.page_count >= 0  # PyMuPDF may repair; it must not crash


def test_encrypted_pdf(tmp_path: Path) -> None:
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "secret")
    path = tmp_path / "locked.pdf"
    doc.save(path, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="o", user_pw="u")
    with pytest.raises(EncryptedFileError):
        parse_document(path, "pdf", NullOCREngine())


def test_corrupted_image(tmp_path: Path) -> None:
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"\x89PNG\r\n\x1a\n" + b"not really a png" * 10)
    with pytest.raises(CorruptedFileError):
        parse_document(bad, "image", OCR)


def test_decompression_bomb_is_rejected(tmp_path: Path) -> None:
    bomb = tmp_path / "bomb.png"
    Image.new("1", (10_000, 10_000)).save(bomb)  # 100 megapixels, tiny file
    with pytest.raises(FileTooLargeError):
        parse_document(bomb, "image", OCR)


def test_ocr_failure_is_reported(tmp_path: Path) -> None:
    class FailingOCR(NullOCREngine):
        def available(self) -> bool:
            return True

        def recognize(self, image: Image.Image) -> OCRResult:
            raise OCRError("engine crashed")

    img = tmp_path / "x.png"
    Image.new("RGB", (200, 100), "white").save(img)
    with pytest.raises(OCRFailedError):
        parse_document(img, "image", FailingOCR())
    # In a PDF a failing OCR page is recorded as a warning instead of failing the whole file.
    doc = parse_document(SAMPLES / "05_zh_course_registration_scan.pdf", "pdf", FailingOCR())
    assert "page_1_ocr_failed" in doc.warnings


def test_ocr_text_tidying() -> None:
    assert tidy_ocr_text("请 于 11 月 20 日 前 提 交 。") == "请于 11 月 20 日前提交。"


@pytest.mark.parametrize(
    ("text", "lang"),
    [
        ("请于2026年11月20日前提交在读证明。", "zh"),
        ("Bitte reichen Sie die Unterlagen bis zum 27.11.2026 ein.", "de"),
        ("Please submit your enrollment certificate by Friday.", "en"),
        ("", None),
    ],
)
def test_language_detection(text: str, lang: str | None) -> None:
    assert detect_language(text) == lang


# ---------------------------------------------------------------------------------------------
# File types & names
# ---------------------------------------------------------------------------------------------


def test_magic_sniffing() -> None:
    assert sniff_bytes(b"%PDF-1.7 ...").kind == "pdf"
    assert sniff_bytes(b"\x89PNG\r\n\x1a\n....").mime_type == "image/png"
    assert sniff_bytes(b"\xff\xd8\xff\xe0....").mime_type == "image/jpeg"
    assert sniff_bytes(b"RIFF\x00\x00\x00\x00WEBPVP8 ").mime_type == "image/webp"
    with pytest.raises(UnsupportedFileError):
        sniff_bytes(b"MZ\x90\x00 executable", "invoice.pdf")  # extension is not trusted
    with pytest.raises(UnsupportedFileError):
        sniff_bytes(b"<script>alert(1)</script>", "page.html")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("..\\..\\Windows\\System32\\evil.pdf", "evil.pdf"),
        ("../../etc/passwd", "passwd"),
        ("C:\\Users\\me\\Desktop\\Rechnung.pdf", "Rechnung.pdf"),
        ("CON.pdf", "_CON.pdf"),
        ("nul", "_nul"),
        ("a\x00b\x1fc.png", "abc.png"),
        ('in<va>lid:"name"?.png', "in_va_lid__name__.png"),
        ("...", "file"),
        (None, "file"),
    ],
)
def test_filename_sanitization(raw: str | None, expected: str) -> None:
    assert sanitize_filename(raw) == expected


def test_long_filenames_are_truncated() -> None:
    name = sanitize_filename("x" * 500 + ".pdf")
    assert len(name) <= 120 and name.endswith(".pdf")


# ---------------------------------------------------------------------------------------------
# E-mail
# ---------------------------------------------------------------------------------------------


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode().rstrip("=")


def test_gmail_multipart_message_prefers_plain_text_and_finds_attachments() -> None:
    resource = {
        "id": "m1",
        "threadId": "t1",
        "historyId": "77",
        "internalDate": "1792000000000",
        "labelIds": ["INBOX", "UNREAD"],
        "snippet": "Hello",
        "payload": {
            "mimeType": "multipart/mixed",
            "headers": [
                {"name": "From", "value": "Office <office@uni.example>"},
                {"name": "Subject", "value": "Unterlagen"},
                {"name": "List-Unsubscribe", "value": "<mailto:x@y>"},
            ],
            "parts": [
                {
                    "mimeType": "multipart/alternative",
                    "parts": [
                        {
                            "mimeType": "text/plain",
                            "headers": [{"name": "Content-Type", "value": "text/plain; charset=utf-8"}],
                            "body": {"data": _b64("Bitte reichen Sie die Unterlagen ein.")},
                        },
                        {"mimeType": "text/html", "body": {"data": _b64("<p>HTML version</p>")}},
                    ],
                },
                {"mimeType": "application/pdf", "filename": "form.pdf", "body": {"attachmentId": "a1", "size": 1234}},
                {"mimeType": "application/x-msdownload", "filename": "virus.exe", "body": {"attachmentId": "a2"}},
            ],
        },
    }
    msg = parse_gmail_message(resource)
    assert msg.body_text == "Bitte reichen Sie die Unterlagen ein."
    assert msg.sender_domain == "uni.example"
    assert msg.is_bulk
    assert [a.filename for a in msg.attachments] == ["form.pdf"]  # executables are ignored
    assert msg.sent_at == dt.datetime.fromtimestamp(1792000000, tz=dt.UTC)
    assert "UNREAD" in msg.labels  # kept as metadata only - unread != not done


def test_gmail_html_only_message_and_charset() -> None:
    html = (
        "<html><body><style>.x{}</style><p>Sehr geehrte Frau Wang,<br>bitte zahlen Sie bis 30.10.2026.</p>"
        "<div style='display:none'>hidden tracking text</div></body></html>"
    )
    resource = {
        "id": "m2",
        "threadId": "t2",
        "internalDate": "1792000000000",
        "payload": {
            "mimeType": "text/html",
            "headers": [{"name": "Subject", "value": "Zahlung"}],
            "body": {"data": base64.urlsafe_b64encode(html.encode("latin-1")).decode()},
        },
    }
    resource["payload"]["headers"].append({"name": "Content-Type", "value": 'text/html; charset="iso-8859-1"'})
    msg = parse_gmail_message(resource)
    assert "bitte zahlen Sie bis 30.10.2026." in msg.body_text
    assert "hidden tracking" not in msg.body_text
    assert ".x{}" not in msg.body_text


def test_quoted_replies_are_removed() -> None:
    text = "Thanks, received.\n\nOn Mon, 12 Oct 2026 at 10:00, Office <o@x> wrote:\n> Please submit the form by Friday."
    assert strip_quoted_text(text) == "Thanks, received."
    zh = "好的，已收到。\n\n在 2026年10月12日 写道：\n> 请提交材料"
    assert strip_quoted_text(zh) == "好的，已收到。"


def test_eml_parsing_with_attachment() -> None:
    raw = (
        "From: Landlord <landlord@home.example>\r\nTo: me@example.com\r\nSubject: Mietvertrag\r\n"
        "Date: Tue, 13 Oct 2026 09:00:00 +0200\r\nMessage-ID: <abc@home.example>\r\nMIME-Version: 1.0\r\n"
        'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'
        "Bitte unterschreiben Sie den Vertrag bis 20.10.2026.\r\n--b\r\nContent-Type: application/pdf\r\n"
        'Content-Disposition: attachment; filename="vertrag.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n'
        + base64.b64encode(b"%PDF-1.4 fake").decode()
        + "\r\n--b--\r\n"
    ).encode()
    msg = parse_eml_bytes(raw)
    assert msg.external_id == "abc@home.example"
    assert msg.subject == "Mietvertrag"
    assert msg.sent_at == dt.datetime(2026, 10, 13, 7, 0, tzinfo=dt.UTC)
    assert "unterschreiben" in msg.body_text
    assert msg.attachments[0].filename == "vertrag.pdf"
    assert msg.attachments[0].inline_data == b"%PDF-1.4 fake"


def test_html_to_text_drops_scripts() -> None:
    assert html_to_text("<script>steal()</script><p>Hello</p>") == "Hello"


def test_gmail_link_uses_account() -> None:
    assert gmail_web_link("abc", "me@gmail.com") == "https://mail.google.com/mail/?authuser=me%40gmail.com#all/abc"
