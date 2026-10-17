# PyInstaller spec for TaskRadar-Setup-<version>.exe: one file that installs TaskRadar for the current user.
# Built by scripts\build-exe.ps1 after TaskRadar.exe; it packs the program archive (the zipped folder build) and
# the small installer window. Nothing of the server is needed here, so it stays out (much smaller setup program).

import os
from pathlib import Path

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
PAYLOAD = Path(os.environ.get("TASKRADAR_PAYLOAD", ROOT / "build" / "payload" / "TaskRadar.zip"))
if not PAYLOAD.is_file():
    raise SystemExit(f"The program archive is missing ({PAYLOAD}). Run scripts\\build-exe.ps1.")

version = next(
    line.split('"')[1] for line in (PKG / "__init__.py").read_text(encoding="utf-8").splitlines() if line.startswith("__version__")
)

a = Analysis(  # noqa: F821
    [str(ROOT / "packaging" / "installer.py")],
    pathex=[str(ROOT / "backend" / "src")],
    datas=[
        (str(PAYLOAD), "payload"),
        (str(ROOT / "packaging" / "installer.html"), "."),
        (str(PKG / "desktop" / "taskradar.ico"), "taskradar/desktop"),
    ],
    hiddenimports=["webview.platforms.winforms", "webview.platforms.edgechromium", "clr"],
    excludes=[
        # The installer only unpacks files and creates shortcuts; the app's server stays out.
        "taskradar.__main__",
        "taskradar.api",
        "taskradar.container",
        "taskradar.db",
        "taskradar.desktop.shell",
        "taskradar.desktop.server",
        "fastapi",
        "starlette",
        "uvicorn",
        "sqlalchemy",
        "alembic",
        "pydantic",
        "fitz",
        "pymupdf",
        "PIL",
        "pytesseract",
        "bs4",
        "googleapiclient",
        "google",
        "openai",
        "httpx",
        "keyring",
        "apscheduler",
        "numpy",
        "tkinter",
        "pytest",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "gi",
    ],
    noarchive=False,
)
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
                        StringStruct("FileDescription", "TaskRadar Setup"),
                        StringStruct("FileVersion", version),
                        StringStruct("InternalName", "TaskRadar-Setup"),
                        StringStruct("LegalCopyright", "MIT License"),
                        StringStruct("OriginalFilename", f"TaskRadar-Setup-{version}.exe"),
                        StringStruct("ProductName", "TaskRadar"),
                        StringStruct("ProductVersion", version),
                    ],
                )
            ]
        ),
        VarFileInfo([VarStruct("Translation", [0x0409, 1200])]),
    ],
)

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=f"TaskRadar-Setup-{version}",
    icon=str(ROOT / "packaging" / "taskradar.ico"),
    version=version_info,
    console=False,
    upx=False,
    debug=False,
    strip=False,
)
