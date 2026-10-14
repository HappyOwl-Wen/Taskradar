"""Files imported while no OCR engine was installed are read again once OCR becomes available.

Seen with a real mailbox: screenshots and scanned attachments arrived before Tesseract was installed,
and identical images (a sender's logo in every mail) were OCR-ed once per copy.
"""

from __future__ import annotations

import datetime as dt
import io
import subprocess
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from taskradar.api.app import create_app
from taskradar.connectors.fake_gmail import FakeGmailClient
from taskradar.container import Container
from taskradar.db.models import Document, Source, Task, TaskSource
from taskradar.db.session import transaction
from taskradar.demo.mailbox import _message
from taskradar.domain.enums import SourceKind
from taskradar.parsing.ocr import OCRResult, OCRUnavailableError, TesseractEngine
from taskradar.security import secrets as sk
from taskradar.services.system import AutostartManager

from .conftest import Clock

SCREENSHOT_TEXT = "Rückmeldung Wintersemester\nBitte überweisen Sie den Semesterbeitrag bis zum 20.11.2026."


class SwitchableOCR:
    """An OCR engine double that can be 'installed' while the app is running."""

    name = "fake-ocr"

    def __init__(self, *, installed: bool = False) -> None:
        self.installed = installed
        self.calls = 0

    def available(self) -> bool:
        return self.installed

    def languages(self) -> list[str]:
        return ["chi_sim", "deu", "eng"] if self.installed else []

    def recognize(self, image: Image.Image) -> OCRResult:
        if not self.installed:
            raise OCRUnavailableError("not installed")
        self.calls += 1
        return OCRResult(text=SCREENSHOT_TEXT, confidence=0.93, engine=self.name, languages=self.languages())


def _png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (480, 160), "white").save(buf, format="PNG")
    return buf.getvalue()


def screenshot_mailbox(now: dt.datetime) -> tuple[list[dict[str, Any]], dict[tuple[str, str], bytes]]:
    """Two mails carrying the same screenshot; the mail text itself asks for nothing."""
    image = _png()
    messages = [
        _message(
            f"shot{i}",
            thread=f"t-shot{i}",
            sent=now - dt.timedelta(hours=3 - i),
            sender="Lena Fischer <lena.fischer@student.example>",
            subject="Screenshot aus dem Portal",
            body="Hallo,\n\nanbei der Screenshot.\n\nViele Grüße\nLena",
            attachments=[("portal.png", "image/png", f"att-shot{i}")],
        )
        for i in (1, 2)
    ]
    return messages, {(f"shot{i}", f"att-shot{i}"): image for i in (1, 2)}


def connect_gmail(c: Container) -> int:
    c.secrets.set(sk.GOOGLE_TOKEN_GMAIL, '{"token": "fake"}')
    with transaction(c.factory) as session:
        source = Source(kind=SourceKind.GMAIL.value, name="Gmail", account="student@gmail.example", status="ok")
        session.add(source)
        session.flush()
        return source.id


def documents(c: Container) -> list[Document]:
    with transaction(c.factory) as session:
        docs = session.scalars(select(Document).order_by(Document.id)).all()
        session.expunge_all()
        return list(docs)


def fee_tasks(c: Container) -> list[tuple[int, set[int | None]]]:
    with transaction(c.factory) as session:
        tasks = [t for t in session.scalars(select(Task)) if "Semesterbeitrag" in t.title]
        return [
            (t.id, set(session.scalars(select(TaskSource.document_id).where(TaskSource.task_id == t.id))))
            for t in tasks
        ]


@contextmanager
def api_client(c: Container) -> Iterator[TestClient]:
    app = create_app(c, extra_hosts={"testserver"}, autostart=AutostartManager(startup_dir=None))
    with TestClient(app) as client:
        client.headers.update({"X-TaskRadar-CSRF": client.get("/api/session").json()["csrf_token"]})
        yield client


def synced_container(make_container: Callable[..., Container], clock: Clock, ocr: SwitchableOCR) -> Container:
    messages, attachments = screenshot_mailbox(clock())
    client = FakeGmailClient(messages, attachments=attachments, clock=clock, email="student@gmail.example")
    c = make_container(ocr=ocr, gmail_client_factory=lambda _source: client)
    job = c.gmail.sync(connect_gmail(c))
    assert job["status"] == "succeeded", job
    return c


def test_files_imported_without_ocr_are_read_again_once_it_is_installed(
    make_container: Callable[..., Container], clock: Clock
) -> None:
    ocr = SwitchableOCR(installed=False)
    c = synced_container(make_container, clock, ocr)
    first, second = documents(c)
    assert first.status == "processed" and "ocr_unavailable" in first.warnings
    assert second.status == "skipped" and f"duplicate_content_of:{first.id}" in second.warnings
    assert c.documents.ocr_backlog() == [first.id, second.id]
    assert fee_tasks(c) == []

    with api_client(c) as api:
        status = api.get("/api/system/status").json()["ocr"]
        assert status["available"] is False and status["backlog"] == 2
        refused = api.post("/api/documents/reprocess-ocr")
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "ocr_unavailable"

        ocr.installed = True
        response = api.post("/api/documents/reprocess-ocr", params={"wait": "true"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["accepted"] is True and body["count"] == 2
        job = body["job"]
        assert (job["kind"], job["status"]) == ("reprocess", "succeeded")
        assert (job["items_seen"], job["items_processed"], job["items_skipped"], job["items_failed"]) == (2, 1, 1, 0)
        assert job["tasks_created"] == 1
        assert ocr.calls == 1  # the identical second copy reuses the first result

        status = api.get("/api/system/status").json()["ocr"]
        assert status["backlog"] == 0 and status["reprocessing"] is False
        assert api.post("/api/documents/reprocess-ocr").json() == {"accepted": False, "count": 0, "job": None}

    first, second = documents(c)
    assert first.status == "processed" and first.extraction_method == "ocr"
    assert "ocr_unavailable" not in first.warnings
    assert second.status == "skipped" and second.warnings[-1] == f"duplicate_content_of:{first.id}"
    assert second.text_chars == first.text_chars > 0
    # One task, evidenced by both copies of the screenshot.
    [(_task_id, doc_ids)] = fee_tasks(c)
    assert {first.id, second.id} <= doc_ids


def test_backlog_is_read_by_one_job_at_a_time(make_container: Callable[..., Container], clock: Clock) -> None:
    ocr = SwitchableOCR(installed=False)
    c = synced_container(make_container, clock, ocr)
    ocr.installed = True
    with api_client(c) as api:
        _job_id, run = c.documents.start_ocr_backlog_job(c.jobs)  # e.g. a second browser tab clicked first
        assert api.get("/api/system/status").json()["ocr"]["reprocessing"] is True
        busy = api.post("/api/documents/reprocess-ocr")
        assert busy.status_code == 409 and busy.json()["error"]["code"] == "job_already_running"
        assert run()["status"] == "succeeded"
        status = api.get("/api/system/status").json()["ocr"]
        assert (status["backlog"], status["reprocessing"]) == (0, False)
    assert ocr.calls == 1


def test_identical_images_are_ocr_ed_only_once(make_container: Callable[..., Container], clock: Clock) -> None:
    ocr = SwitchableOCR(installed=True)
    c = synced_container(make_container, clock, ocr)
    first, second = documents(c)
    assert ocr.calls == 1
    assert first.status == "processed" and first.extraction_method == "ocr"
    assert second.status == "skipped" and second.extraction_method == "ocr"
    assert second.warnings == [f"duplicate_content_of:{first.id}"]
    with transaction(c.factory) as session:
        texts = [[p.text for p in session.get(Document, d.id).pages] for d in (first, second)]  # type: ignore[union-attr]
    assert texts[0] == texts[1] and "Semesterbeitrag" in texts[0][0]
    assert c.documents.ocr_backlog() == []
    [(_task_id, doc_ids)] = fee_tasks(c)
    assert {first.id, second.id} <= doc_ids


def test_tesseract_installed_while_running_is_found_without_restart(tmp_path: Path, monkeypatch: Any) -> None:
    exe = tmp_path / "tesseract.exe"
    now = [1000.0]

    def fake_run(args: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        assert args == [str(exe), "--list-langs"]
        return subprocess.CompletedProcess(args, 0, stdout="List of available languages (4):\nchi_sim\ndeu\neng\nosd\n")

    monkeypatch.setattr(subprocess, "run", fake_run)
    engine = TesseractEngine(exe, clock=lambda: now[0])
    assert engine.available() is False

    exe.write_bytes(b"")  # installed while TaskRadar is running
    now[0] += 5
    assert engine.available() is False  # not looked for again on every call
    now[0] += TesseractEngine.REDETECT_INTERVAL
    assert engine.available() is True
    assert engine.command == str(exe)
    assert engine.languages() == ["chi_sim", "deu", "eng"]
