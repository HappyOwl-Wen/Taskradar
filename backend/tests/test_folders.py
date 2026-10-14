"""Watched folders: explicit folders only, incremental scans, originals are never modified."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

import pytest
from sqlalchemy import select

from taskradar.container import Container
from taskradar.db.models import Document, Task
from taskradar.db.session import transaction
from taskradar.security.permissions import PermissionDenied

from .conftest import SAMPLES

NOTICE = "01_zh_enrollment_certificate_notice.pdf"
CONTRACT = "06_en_rental_contract.pdf"


def settled(path: Path) -> Path:
    """Pretend the file was written a minute ago (files still being written are skipped)."""
    past = time.time() - 60
    os.utime(path, (past, past))
    return path


def copy_sample(name: str, folder: Path, target: str | None = None) -> Path:
    return settled(Path(shutil.copyfile(SAMPLES / name, folder / (target or name))))


def documents(c: Container) -> list[Document]:
    with transaction(c.factory) as session:
        return list(session.scalars(select(Document).order_by(Document.id)))


def task_titles(c: Container) -> list[str]:
    with transaction(c.factory) as session:
        return sorted(t.title for t in session.scalars(select(Task)))


@pytest.fixture
def watched(tmp_path: Path) -> Path:
    folder = tmp_path / "Uni-Post"
    folder.mkdir()
    return folder


def test_scan_imports_new_files_in_place_without_touching_them(container: Container, watched: Path) -> None:
    pdf = copy_sample(NOTICE, watched)
    contract = copy_sample(CONTRACT, watched)
    before = {p: (p.read_bytes(), p.stat().st_mtime) for p in (pdf, contract)}
    source = container.folders.add_folder(str(watched))

    job = container.folders.scan(source.id)

    assert job["status"] == "succeeded"
    assert job["items_processed"] == 2 and job["tasks_created"] == 2
    assert len(task_titles(container)) == 2
    docs = documents(container)
    assert {d.original_path for d in docs} == {str(pdf.resolve()), str(contract.resolve())}
    assert all(d.stored_path is None for d in docs)  # read in place, never copied or moved
    for path, (data, mtime) in before.items():
        assert path.read_bytes() == data and path.stat().st_mtime == mtime


def test_unchanged_files_are_skipped_on_the_next_scan(container: Container, watched: Path) -> None:
    copy_sample(NOTICE, watched)
    source = container.folders.add_folder(str(watched))
    container.folders.scan(source.id)

    again = container.folders.scan(source.id)

    assert again["items_processed"] == 0 and again["items_skipped"] == 1
    assert len(documents(container)) == 1 and len(task_titles(container)) == 1


def test_files_still_being_written_wait_for_the_next_scan(container: Container, watched: Path) -> None:
    fresh = Path(shutil.copyfile(SAMPLES / NOTICE, watched / NOTICE))  # mtime = now
    source = container.folders.add_folder(str(watched))

    first = container.folders.scan(source.id)
    assert first["items_skipped"] == 1 and documents(container) == []

    settled(fresh)
    second = container.folders.scan(source.id)
    assert second["items_processed"] == 1 and len(task_titles(container)) == 1


def test_changed_file_is_reanalysed(container: Container, watched: Path) -> None:
    path = copy_sample(NOTICE, watched, "letter.pdf")
    source = container.folders.add_folder(str(watched))
    container.folders.scan(source.id)
    [doc] = documents(container)

    shutil.copyfile(SAMPLES / CONTRACT, path)  # the user saved a different letter under the same name
    settled(path)
    job = container.folders.scan(source.id)

    assert job["items_processed"] == 1
    [updated] = documents(container)
    assert updated.id == doc.id and updated.sha256 != doc.sha256
    assert len(task_titles(container)) == 2  # the new content produced its own task


def test_temporary_and_unsupported_files_are_ignored(container: Container, watched: Path) -> None:
    settled(Path(shutil.copyfile(SAMPLES / NOTICE, watched / "~$draft.pdf")))
    settled(Path(shutil.copyfile(SAMPLES / NOTICE, watched / "download.pdf.crdownload")))
    (watched / "notes.txt").write_text("Bitte bis morgen bezahlen", encoding="utf-8")
    settled(watched / "notes.txt")
    source = container.folders.add_folder(str(watched))

    container.folders.scan(source.id)

    assert documents(container) == []


def test_subfolders_only_when_recursive(container: Container, watched: Path) -> None:
    sub = watched / "2026"
    sub.mkdir()
    copy_sample(NOTICE, sub)
    flat = container.folders.add_folder(str(watched))
    container.folders.scan(flat.id)
    assert documents(container) == []

    container.folders.remove_folder(flat.id)
    deep = container.folders.add_folder(str(watched), recursive=True)
    container.folders.scan(deep.id)
    assert len(documents(container)) == 1


def test_removing_a_folder_keeps_tasks_and_files(container: Container, watched: Path) -> None:
    pdf = copy_sample(NOTICE, watched)
    source = container.folders.add_folder(str(watched))
    container.folders.scan(source.id)

    container.folders.remove_folder(source.id)

    assert pdf.exists()
    assert len(task_titles(container)) == 1


def test_missing_folder_is_reported_not_crashed(container: Container, watched: Path) -> None:
    source = container.folders.add_folder(str(watched))
    watched.rmdir()

    job = container.folders.scan(source.id)

    assert job["status"] == "failed"
    assert job["details"]["error"] == "folder_missing"


def test_only_explicit_safe_folders_can_be_watched(container: Container) -> None:
    with pytest.raises(PermissionDenied) as exc:
        container.folders.add_folder(str(container.config.data_dir))
    assert exc.value.code == "folder_is_app_data"
