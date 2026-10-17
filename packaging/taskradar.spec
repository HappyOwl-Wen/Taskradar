# PyInstaller spec for TaskRadar.exe, the desktop app. Build it with scripts\build-exe.ps1, which builds the web UI
# first and then the installer (packaging/installer.spec) around the result.
#
# The result runs without Python or Node.js: the backend, the built web UI, the window (pywebview on the Microsoft
# Edge WebView2 runtime that is part of Windows 11), the database migrations and the synthetic demo files are
# inside. Data stays in %LOCALAPPDATA%\TaskRadar (as when running from source); nothing personal is packed.
# TASKRADAR_ONEFILE=1 makes one self-unpacking TaskRadar.exe instead of a folder.

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules, copy_metadata
from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo,
    StringFileInfo,
    StringStruct,
    StringTable,
    VarFileInfo,
    VarStruct,
    VSVersionInfo,
)

ROOT = Path(SPECPATH).parent  # noqa: F821 - provided by PyInstaller
PKG = ROOT / "backend" / "src" / "taskradar"
ONEFILE = os.environ.get("TASKRADAR_ONEFILE") == "1"

if not (PKG / "static" / "index.html").is_file():
    raise SystemExit("The web UI is not built (backend/src/taskradar/static). Run scripts\\build-exe.ps1.")

version = next(
    line.split('"')[1] for line in (PKG / "__init__.py").read_text(encoding="utf-8").splitlines() if line.startswith("__version__")
)

# Files the program reads from disk next to its modules (found through __file__, as from source).
datas = [
    (str(PKG / "static"), "taskradar/static"),
    (str(PKG / "migrations" / "env.py"), "taskradar/migrations"),
    (str(PKG / "migrations" / "script.py.mako"), "taskradar/migrations"),
    *[(str(p), "taskradar/migrations/versions") for p in sorted((PKG / "migrations" / "versions").glob("*.py"))],
    *[(str(p), "taskradar/demo/samples") for p in sorted((PKG / "demo" / "samples").iterdir()) if p.is_file()],
    (str(PKG / "demo" / "eval_dataset.json"), "taskradar/demo"),
    (str(PKG / "demo" / "eval_holdout.json"), "taskradar/demo"),
    # The window's icon (title bar, Alt+Tab).
    (str(PKG / "desktop" / "taskradar.ico"), "taskradar/desktop"),
    # Entry points: APScheduler finds its triggers and executors, keyring its Windows backend, through them.
    *copy_metadata("apscheduler"),
    *copy_metadata("keyring"),
]

hiddenimports = [
    "taskradar",
    # Everything of the app (Alembic's env.py imports the models by name); the migration scripts themselves are
    # files that Alembic loads from disk (see datas).
    *collect_submodules("taskradar", filter=lambda name: ".migrations" not in name),
    *collect_submodules("uvicorn"),
    *collect_submodules("apscheduler.triggers"),
    *collect_submodules("apscheduler.executors"),
    *collect_submodules("apscheduler.jobstores"),
    "keyring.backends.Windows",
    "sqlalchemy.dialects.sqlite",
    # The window: pywebview's Windows platform (WinForms + WebView2 through pythonnet); pywebview's own PyInstaller
    # hook adds its scripts and the WebView2 DLLs.
    "webview.platforms.winforms",
    "webview.platforms.edgechromium",
    "clr",
]

a = Analysis(  # noqa: F821
    [str(ROOT / "packaging" / "launcher.py")],
    pathex=[str(ROOT / "backend" / "src")],
    binaries=collect_dynamic_libs("pymupdf"),
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "_pytest", "mypy", "ruff", "IPython", "PyQt5", "PyQt6", "PySide2", "PySide6", "gi"],
    noarchive=False,
)

# Google's discovery documents: only Gmail and Calendar are used (static discovery); the other ~500 files are
# about 100 MB.
KEEP_DISCOVERY = {"gmail.v1.json", "calendar.v3.json"}
a.datas = [
    entry
    for entry in a.datas
    if "discovery_cache" not in entry[0].replace("\\", "/") or Path(entry[0]).name in KEEP_DISCOVERY
]

pyz = PYZ(a.pure)  # noqa: F821

numbers = tuple(int(part) for part in version.split(".")) + (0,) * (4 - len(version.split(".")))
version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=numbers, prodvers=numbers),
    kids=[
        StringFileInfo(
            [
                StringTable(
                    "040904B0",
                    [
                        StringStruct("CompanyName", "TaskRadar contributors"),
                        StringStruct("FileDescription", "TaskRadar - personal obligation radar"),
                        StringStruct("FileVersion", version),
                        StringStruct("InternalName", "TaskRadar"),
                        StringStruct("LegalCopyright", "MIT License"),
                        StringStruct("OriginalFilename", "TaskRadar.exe"),
                        StringStruct("ProductName", "TaskRadar"),
                        StringStruct("ProductVersion", version),
                    ],
                )
            ]
        ),
        VarFileInfo([VarStruct("Translation", [0x0409, 1200])]),
    ],
)

exe_options = dict(
    name="TaskRadar",
    icon=str(ROOT / "packaging" / "taskradar.ico"),
    version=version_info,
    console=False,  # a windowed program: the TaskRadar window shows that it runs; closing it stops TaskRadar
    upx=False,  # compressed executables are flagged by virus scanners more often
    debug=False,
    strip=False,
)

if ONEFILE:
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], **exe_options)  # noqa: F821
else:
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, **exe_options)  # noqa: F821
    coll = COLLECT(exe, a.binaries, a.datas, name="TaskRadar", upx=False)  # noqa: F821
