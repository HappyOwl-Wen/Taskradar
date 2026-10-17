"""The packaged program (TaskRadar.exe): autostart starts the exe itself, and .env is read next to it."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from taskradar.__main__ import _load_env_files
from taskradar.services.system import MARKER, AutostartManager


def test_autostart_from_source_starts_the_module_without_a_window(tmp_path: Path) -> None:
    python = tmp_path / "python.exe"
    python.write_bytes(b"")
    (tmp_path / "pythonw.exe").write_bytes(b"")
    manager = AutostartManager(startup_dir=tmp_path / "Startup", python_exe=str(python))
    manager.enable()
    assert manager.path is not None
    content = manager.path.read_text(encoding="utf-8")
    assert MARKER in content
    assert f'start "" "{tmp_path / "pythonw.exe"}" -m taskradar --no-browser' in content


def test_autostart_of_the_exe_starts_it_minimised_and_never_passes_module_arguments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    exe = tmp_path / "TaskRadar" / "TaskRadar.exe"
    manager = AutostartManager(startup_dir=tmp_path / "Startup", python_exe=str(exe))
    manager.enable()
    assert manager.path is not None
    content = manager.path.read_text(encoding="utf-8")
    assert f'start "" /min "{exe}" --no-browser' in content
    assert "-m taskradar" not in content
    assert manager.enabled()
    manager.disable()
    assert not manager.path.exists()


def test_the_exe_reads_env_next_to_itself(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    exe_dir = tmp_path / "TaskRadar"
    exe_dir.mkdir()
    (exe_dir / ".env").write_text("TASKRADAR_PACKAGED_TEST=beside-exe\n", encoding="utf-8")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe_dir / "TaskRadar.exe"))
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TASKRADAR_PACKAGED_TEST", raising=False)
    try:
        _load_env_files()
        assert os.environ.get("TASKRADAR_PACKAGED_TEST") == "beside-exe"
    finally:
        os.environ.pop("TASKRADAR_PACKAGED_TEST", None)
