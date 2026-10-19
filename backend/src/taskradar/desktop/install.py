"""Installing TaskRadar for the current user, and removing it again (no administrator rights needed).

* The program goes to ``%LOCALAPPDATA%\\Programs\\TaskRadar`` (the per-user program folder of Windows).
* A Start menu entry and, if wanted, a desktop shortcut start it; Settings -> Apps lists it with an uninstall entry.
* The data (``%LOCALAPPDATA%\\TaskRadar``: database, imported files, logs) is never touched: updating keeps it,
  uninstalling keeps it. Deleting it is a separate, explicit step in the app (Settings -> Data and privacy).

What an installation created is written to ``install.json`` in the program folder; uninstalling removes exactly
that and nothing else (a shortcut is only deleted if it still points into the program folder). The installer
refuses to write into an existing folder that it did not create. Used by the setup program
(packaging/installer.py) and by ``TaskRadar.exe uninstall``.
"""

from __future__ import annotations

import contextlib
import ctypes
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from taskradar.desktop import win32
from taskradar.notify import windows as notifications

APP_NAME = "TaskRadar"
EXE_NAME = "TaskRadar.exe"
MANIFEST = "install.json"
PUBLISHER = "TaskRadar contributors"
UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\TaskRadar"
DESCRIPTION = {"zh-CN": "个人待办雷达", "en": "Personal obligation radar"}

FOLDERID_USER_PROGRAM_FILES = "{5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}"
FOLDERID_PROGRAMS = "{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}"
FOLDERID_DESKTOP = "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}"
FOLDERID_STARTUP = "{B97D20BB-F46A-4C97-BA10-5E3608430854}"


class InstallError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class InstallPaths:
    program_dir: Path
    start_menu_dir: Path
    desktop_dir: Path
    startup_dir: Path | None
    registry_key: str = UNINSTALL_KEY
    notification_key: str = notifications.REGISTRY_KEY  # written by TaskRadar itself on its first start

    @property
    def exe(self) -> Path:
        return self.program_dir / EXE_NAME


def default_paths() -> InstallPaths:
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    roaming = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    programs = known_folder(FOLDERID_USER_PROGRAM_FILES) or local / "Programs"
    start_menu = known_folder(FOLDERID_PROGRAMS) or roaming / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    desktop = known_folder(FOLDERID_DESKTOP) or Path.home() / "Desktop"
    startup = known_folder(FOLDERID_STARTUP) or start_menu / "Startup"
    return InstallPaths(programs / APP_NAME, start_menu, desktop, startup)


# -- Windows shell: known folders and shortcuts (COM through ctypes) ------------------------------------------


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    def __init__(self, text: str) -> None:
        super().__init__()
        if sys.platform != "win32":
            raise OSError("Windows only")
        ctypes.oledll.ole32.CLSIDFromString(ctypes.c_wchar_p(text), ctypes.byref(self))


def known_folder(folder_id: str) -> Path | None:
    if sys.platform != "win32":
        return None
    path = ctypes.c_wchar_p()
    try:
        ctypes.oledll.shell32.SHGetKnownFolderPath(ctypes.byref(_GUID(folder_id)), 0, None, ctypes.byref(path))
    except OSError:
        return None
    try:
        return Path(path.value) if path.value else None
    finally:
        ctypes.windll.ole32.CoTaskMemFree(ctypes.cast(path, ctypes.c_void_p))


CLSID_SHELL_LINK = "{00021401-0000-0000-C000-000000000046}"
IID_ISHELL_LINK_W = "{000214F9-0000-0000-C000-000000000046}"
IID_IPERSIST_FILE = "{0000010B-0000-0000-C000-000000000046}"
IID_IPROPERTY_STORE = "{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}"
# System.AppUserModel.ID: the app a Start menu entry stands for. Windows shows an app's notifications as banners
# (not only in the notification centre) when a Start menu entry carries its ID.
PKEY_APP_USER_MODEL_ID = ("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}", 5)
VT_LPWSTR = 31


class _PropertyKey(ctypes.Structure):
    _fields_ = [("fmtid", _GUID), ("pid", ctypes.c_uint32)]


class _PropVariant(ctypes.Structure):
    # The header and the first pointer of the union; the padding gives the 24 bytes of a PROPVARIANT.
    _fields_ = [
        ("vt", ctypes.c_ushort),
        ("reserved1", ctypes.c_ushort),
        ("reserved2", ctypes.c_ushort),
        ("reserved3", ctypes.c_ushort),
        ("value", ctypes.c_wchar_p),
        ("padding", ctypes.c_void_p),
    ]


def _method(obj: ctypes.c_void_p, index: int, *argtypes: Any) -> Callable[..., Any]:
    if sys.platform != "win32":
        raise OSError("Windows only")
    vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    prototype = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, *argtypes)
    function = prototype(vtable[index])
    return lambda *args: function(obj, *args)


def _release(obj: ctypes.c_void_p) -> None:
    if sys.platform != "win32":
        raise OSError("Windows only")
    vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtable[2])(obj)


@contextlib.contextmanager
def _shell_link() -> Iterator[tuple[ctypes.c_void_p, ctypes.c_void_p]]:
    """An IShellLinkW with its IPersistFile, in an initialised COM apartment."""
    if sys.platform != "win32":
        raise OSError("Windows only")
    ole32 = ctypes.windll.ole32
    ole32.CoInitializeEx.restype = ctypes.c_long
    initialised = ole32.CoInitializeEx(None, 0x2) in (0, 1)  # apartment-threaded; S_FALSE: already initialised
    link, persist = ctypes.c_void_p(), ctypes.c_void_p()
    try:
        ctypes.oledll.ole32.CoCreateInstance(
            ctypes.byref(_GUID(CLSID_SHELL_LINK)), None, 1, ctypes.byref(_GUID(IID_ISHELL_LINK_W)), ctypes.byref(link)
        )
        _method(link, 0, ctypes.c_void_p, ctypes.c_void_p)(
            ctypes.byref(_GUID(IID_IPERSIST_FILE)), ctypes.byref(persist)
        )
        yield link, persist
    finally:
        if persist:
            _release(persist)
        if link:
            _release(link)
        if initialised:
            ole32.CoUninitialize()


def create_shortcut(
    path: Path,
    target: Path,
    *,
    description: str = "",
    arguments: str = "",
    app_id: str | None = None,
    icon: Path | None = None,
) -> None:
    from ctypes import wintypes

    with _shell_link() as (link, persist):
        _method(link, 20, wintypes.LPCWSTR)(str(target))  # SetPath
        _method(link, 11, wintypes.LPCWSTR)(arguments)  # SetArguments
        _method(link, 9, wintypes.LPCWSTR)(str(target.parent))  # SetWorkingDirectory
        _method(link, 7, wintypes.LPCWSTR)(description)  # SetDescription
        _method(link, 17, wintypes.LPCWSTR, ctypes.c_int)(str(icon or target), 0)  # SetIconLocation
        if app_id:
            _set_app_id(link, app_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        _method(persist, 6, wintypes.LPCWSTR, wintypes.BOOL)(str(path), True)  # IPersistFile::Save


def set_shortcut_app_id(path: Path, app_id: str) -> None:
    """Give an existing shortcut an app ID, keeping everything else (target, icon, arguments)."""
    from ctypes import wintypes

    with _shell_link() as (link, persist):
        _method(persist, 5, wintypes.LPCWSTR, wintypes.DWORD)(str(path), 2)  # IPersistFile::Load, read/write
        _set_app_id(link, app_id)
        _method(persist, 6, wintypes.LPCWSTR, wintypes.BOOL)(str(path), True)  # IPersistFile::Save


def _set_app_id(link: ctypes.c_void_p, app_id: str) -> None:
    store = ctypes.c_void_p()
    _method(link, 0, ctypes.c_void_p, ctypes.c_void_p)(ctypes.byref(_GUID(IID_IPROPERTY_STORE)), ctypes.byref(store))
    try:
        key = _PropertyKey(_GUID(PKEY_APP_USER_MODEL_ID[0]), PKEY_APP_USER_MODEL_ID[1])
        value = _PropVariant(vt=VT_LPWSTR, value=app_id)
        _method(store, 6, ctypes.c_void_p, ctypes.c_void_p)(ctypes.byref(key), ctypes.byref(value))  # SetValue
        _method(store, 7)()  # Commit
    finally:
        _release(store)


def shortcut_app_id(path: Path) -> str | None:
    """The System.AppUserModel.ID of a shortcut (None without one)."""
    from ctypes import wintypes

    if sys.platform != "win32" or not path.is_file():
        return None
    try:
        with _shell_link() as (link, persist):
            _method(persist, 5, wintypes.LPCWSTR, wintypes.DWORD)(str(path), 0)  # IPersistFile::Load, read only
            store = ctypes.c_void_p()
            _method(link, 0, ctypes.c_void_p, ctypes.c_void_p)(
                ctypes.byref(_GUID(IID_IPROPERTY_STORE)), ctypes.byref(store)
            )
            try:
                key = _PropertyKey(_GUID(PKEY_APP_USER_MODEL_ID[0]), PKEY_APP_USER_MODEL_ID[1])
                value = _PropVariant()
                _method(store, 5, ctypes.c_void_p, ctypes.c_void_p)(ctypes.byref(key), ctypes.byref(value))  # GetValue
                text = value.value if value.vt == VT_LPWSTR else None
                if value.vt:
                    ctypes.windll.ole32.PropVariantClear(ctypes.byref(value))
                return text
            finally:
                _release(store)
    except OSError:
        return None


def shortcut_target(path: Path) -> str | None:
    from ctypes import wintypes

    if not path.is_file():
        return None
    try:
        with _shell_link() as (link, persist):
            _method(persist, 5, wintypes.LPCWSTR, wintypes.DWORD)(str(path), 0)  # IPersistFile::Load, read only
            buffer = ctypes.create_unicode_buffer(32768)
            _method(link, 3, wintypes.LPWSTR, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)(
                buffer,
                len(buffer),
                None,
                0x4,  # GetPath, SLGP_RAWPATH
            )
            return buffer.value or None
    except OSError:
        return None


def _inside(path: str | Path | None, folder: Path) -> bool:
    if not path:
        return False
    try:
        return Path(path).resolve().is_relative_to(folder.resolve())
    except (OSError, ValueError):
        return False


# -- registry: the entry in Settings -> Apps --------------------------------------------------------------------


def register(paths: InstallPaths, *, version: str, size_kb: int) -> None:
    if sys.platform != "win32":
        raise OSError("Windows only")
    import winreg

    exe = str(paths.exe)
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, paths.registry_key, 0, winreg.KEY_WRITE) as key:
        for name, value in (
            ("DisplayName", APP_NAME),
            ("DisplayVersion", version),
            ("Publisher", PUBLISHER),
            ("DisplayIcon", f"{exe},0"),
            ("InstallLocation", str(paths.program_dir)),
            ("UninstallString", f'"{exe}" uninstall'),
            ("QuietUninstallString", f'"{exe}" uninstall --quiet'),
            ("InstallDate", dt.date.today().strftime("%Y%m%d")),
        ):
            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
        for name, number in (("NoModify", 1), ("NoRepair", 1), ("EstimatedSize", size_kb)):
            winreg.SetValueEx(key, name, 0, winreg.REG_DWORD, number)


def registered(registry_key: str = UNINSTALL_KEY) -> dict[str, Any] | None:
    if sys.platform != "win32":
        return None
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, registry_key) as key:
            values: dict[str, Any] = {}
            for name in ("DisplayVersion", "InstallLocation"):
                with contextlib.suppress(OSError):
                    values[name] = winreg.QueryValueEx(key, name)[0]
            return values
    except OSError:
        return None


def unregister(paths: InstallPaths) -> bool:
    if sys.platform != "win32":
        return False
    import winreg

    entry = registered(paths.registry_key)
    if entry is None or not _same_folder(entry.get("InstallLocation"), paths.program_dir):
        return False  # not ours (another installation lives elsewhere): leave it
    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, paths.registry_key)
    return True


def _same_folder(a: object, b: Path) -> bool:
    try:
        return bool(a) and Path(str(a)).resolve() == b.resolve()
    except OSError:
        return False


# -- installing -------------------------------------------------------------------------------------------------


def _members(archive: zipfile.ZipFile) -> list[tuple[zipfile.ZipInfo, PurePosixPath]]:
    """The files of the program folder in the archive, without its top folder; refuses unsafe paths."""
    entries = []
    for info in archive.infolist():
        parts = PurePosixPath(info.filename).parts
        if not parts or info.filename.startswith(("/", "\\")) or ".." in parts or ":" in info.filename:
            raise InstallError("bad_payload", f"Unsafe path in the program archive: {info.filename!r}")
        if info.is_dir() or len(parts) < 2:
            continue
        entries.append((info, PurePosixPath(*parts[1:])))
    if not any(relative == PurePosixPath(EXE_NAME) for _, relative in entries):
        raise InstallError("bad_payload", f"{EXE_NAME} is missing from the program archive")
    return entries


def _remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, ignore_errors=False)


def install(
    payload: Path,
    paths: InstallPaths,
    *,
    version: str,
    desktop_shortcut: bool = True,
    language: str = "zh-CN",
    progress: Callable[[int, int], None] | None = None,
) -> Path:
    """Unpack next to the program folder, then swap it in, so that a failed update leaves the old one working."""
    target = paths.program_dir
    if target.exists() and any(target.iterdir()) and not (target / MANIFEST).is_file():
        raise InstallError("not_ours", f"{target} exists and was not created by the TaskRadar installer")
    staging = target.with_name(target.name + ".new")
    previous = target.with_name(target.name + ".old")
    for leftover in (staging, previous):  # from an interrupted earlier run; both are ours by name
        with contextlib.suppress(FileNotFoundError):
            _remove_tree(leftover)

    with zipfile.ZipFile(payload) as archive:
        entries = _members(archive)
        total, size = len(entries), 0
        for done, (info, relative) in enumerate(entries, start=1):
            destination = staging.joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, open(destination, "wb") as sink:
                shutil.copyfileobj(source, sink, 1024 * 1024)
            size += info.file_size
            if progress is not None:
                progress(done, total)

    shortcuts: dict[str, str | None] = {"start_menu": str(paths.start_menu_dir / f"{APP_NAME}.lnk"), "desktop": None}
    if desktop_shortcut:
        shortcuts["desktop"] = str(paths.desktop_dir / f"{APP_NAME}.lnk")
    manifest = {
        "version": version,
        "installed": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "shortcuts": shortcuts,
        "registry_key": paths.registry_key,
    }
    (staging / MANIFEST).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if target.exists():
        try:
            os.replace(target, previous)
        except OSError as exc:  # a file of the old version is open: TaskRadar is running
            shutil.rmtree(staging, ignore_errors=True)
            raise InstallError("in_use", "TaskRadar is running; close it and try again") from exc
    os.replace(staging, target)
    shutil.rmtree(previous, ignore_errors=True)

    description = DESCRIPTION["en" if language == "en" else "zh-CN"]
    # The app ID makes the entry stand for TaskRadar's window and notifications: Windows shows an app's notifications
    # as banners (not only in the notification centre) when a Start menu entry carries its ID.
    create_shortcut(Path(str(shortcuts["start_menu"])), paths.exe, description=description, app_id=notifications.APP_ID)
    old_desktop = paths.desktop_dir / f"{APP_NAME}.lnk"
    if desktop_shortcut:
        create_shortcut(old_desktop, paths.exe, description=description, app_id=notifications.APP_ID)
    elif _inside(shortcut_target(old_desktop), target):
        old_desktop.unlink()  # an update without the desktop shortcut removes the one an earlier install made
    register(paths, version=version, size_kb=size // 1024)
    return paths.exe


# -- uninstalling -----------------------------------------------------------------------------------------------


def read_manifest(program_dir: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((program_dir / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def paths_for(program_dir: Path, manifest: dict[str, Any]) -> InstallPaths:
    defaults = default_paths()
    shortcuts = manifest.get("shortcuts") or {}
    start_menu = Path(shortcuts["start_menu"]).parent if shortcuts.get("start_menu") else defaults.start_menu_dir
    desktop = Path(shortcuts["desktop"]).parent if shortcuts.get("desktop") else defaults.desktop_dir
    return InstallPaths(
        program_dir=program_dir,
        start_menu_dir=start_menu,
        desktop_dir=desktop,
        startup_dir=defaults.startup_dir,
        registry_key=str(manifest.get("registry_key") or UNINSTALL_KEY),
    )


def remove_integration(paths: InstallPaths) -> list[str]:
    """Shortcuts, the Apps entry, our autostart entry and our notification identity; returns what was removed."""
    from taskradar.services.system import AutostartManager

    removed = []
    for shortcut in (paths.start_menu_dir / f"{APP_NAME}.lnk", paths.desktop_dir / f"{APP_NAME}.lnk"):
        if _inside(shortcut_target(shortcut), paths.program_dir):
            shortcut.unlink()
            removed.append(str(shortcut))
    if unregister(paths):
        removed.append(paths.registry_key)
    if notifications.unregister(key=paths.notification_key):
        removed.append(paths.notification_key)
    autostart = AutostartManager(startup_dir=paths.startup_dir, python_exe=str(paths.exe))
    if autostart.enabled() and autostart.path is not None:
        content = autostart.path.read_text(encoding="utf-8", errors="ignore")
        if str(paths.program_dir).lower() in content.lower():
            autostart.disable()
            removed.append(str(autostart.path))
    return removed


def schedule_folder_removal(program_dir: Path) -> None:
    """Delete the program folder once this process (which runs from it) has ended.

    PowerShell gets the path on its (Unicode) command line, so user names with any characters work.
    """
    literal = str(program_dir).replace("'", "''")
    command = (
        f"Wait-Process -Id {os.getpid()} -ErrorAction SilentlyContinue; "
        f"Remove-Item -LiteralPath '{literal}' -Recurse -Force -ErrorAction SilentlyContinue"
    )
    powershell = Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    # A hidden console of its own (PowerShell does not start without one), in its own group (no Ctrl+C from ours).
    flags = 0x08000000 | 0x00000200  # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(  # noqa: S603 - Windows PowerShell by full path; the only variable part is our own folder
        [str(powershell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        cwd=str(program_dir.parent),
        creationflags=flags,
        close_fds=True,
    )


UNINSTALL_TEXTS = {
    "zh-CN": {
        "confirm": "要从这台电脑上卸载 TaskRadar 吗？\n\n你的任务、导入的文件和设置会保留在：\n{data}\n"
        "（如需一并删除，请先在 TaskRadar 中打开 设置 → 数据与隐私 → 删除全部数据。）",
        "running": "TaskRadar 正在运行。请先关闭 TaskRadar 窗口，再卸载。",
        "portable": "这个 TaskRadar 不是用安装程序安装的，无需卸载：直接删除它所在的文件夹即可。",
        "done": "TaskRadar 已卸载。\n\n你的数据仍保存在：\n{data}",
    },
    "en": {
        "confirm": "Remove TaskRadar from this computer?\n\n"
        "Your tasks, imported files and settings are kept in:\n{data}\n"
        "(To delete them as well, first use Settings -> Data and privacy -> Delete all data in TaskRadar.)",
        "running": "TaskRadar is running. Close the TaskRadar window first, then uninstall.",
        "portable": "This TaskRadar was not installed with the installer: just delete its folder.",
        "done": "TaskRadar was removed.\n\nYour data is still in:\n{data}",
    },
}


def uninstall_command(*, quiet: bool = False) -> int:
    from taskradar.config import default_data_dir
    from taskradar.desktop.prefs import DesktopPrefs
    from taskradar.packaged import program_dir

    data_dir = default_data_dir()
    language = DesktopPrefs.load(data_dir / "desktop.json").appearance.language
    texts = UNINSTALL_TEXTS["en" if language == "en" else "zh-CN"]

    def tell(text: str, flags: int = win32.MB_OK | win32.MB_ICONINFORMATION) -> int:
        if quiet:
            print(text.replace("\n\n", " ").replace("\n", " "))
            return win32.IDYES
        return win32.message_box(text, f"{APP_NAME}", flags)

    folder = program_dir()
    manifest = read_manifest(folder) if folder else None
    if folder is None or manifest is None:
        tell(texts["portable"])
        return 1
    if not quiet:
        flags = win32.MB_YESNO | win32.MB_ICONWARNING | win32.MB_DEFBUTTON2
        if tell(texts["confirm"].format(data=data_dir), flags) != win32.IDYES:
            return 1
    if win32.processes_running_from(str(folder)):  # TaskRadar from this folder is open: its files are in use
        tell(texts["running"], win32.MB_OK | win32.MB_ICONWARNING)
        return 2
    remove_integration(paths_for(folder, manifest))
    schedule_folder_removal(folder)
    tell(texts["done"].format(data=data_dir))
    return 0


if __name__ == "__main__":  # pragma: no cover - manual use
    sys.exit(uninstall_command())
