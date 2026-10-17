"""Entry point of TaskRadar.exe: the same commands as ``python -m taskradar`` (``serve`` when double-clicked)."""

from __future__ import annotations

import contextlib
import sys
import traceback

from taskradar.__main__ import main

TITLE = "TaskRadar - 关闭此窗口即停止 / close this window to stop"


def _someone_can_answer() -> bool:
    """Input comes from a console window (not NUL, a pipe or a file, as when started by a scheduler)."""
    if sys.stdin is None:
        return False
    if sys.platform != "win32":
        return sys.stdin.isatty()
    import ctypes
    import msvcrt

    try:
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    except (OSError, ValueError):
        return False
    mode = ctypes.c_ulong()
    # NUL also counts as a terminal for isatty(); only a real console has a console mode.
    return bool(ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)))


def run() -> int:
    if sys.platform == "win32":
        import ctypes

        ctypes.windll.kernel32.SetConsoleTitleW(TITLE)
    try:
        code = main()
    except SystemExit as exc:  # argparse: --help, --version, wrong arguments
        code = exc.code if isinstance(exc.code, int) else 0 if exc.code is None else 1
    except Exception:
        traceback.print_exc()
        code = 1
    if code and _someone_can_answer():
        # Started by double-click: keep the window open so that the message can be read.
        with contextlib.suppress(EOFError, KeyboardInterrupt):
            input("\n按回车键关闭此窗口 / Press Enter to close this window ")
    return code


if __name__ == "__main__":
    raise SystemExit(run())
