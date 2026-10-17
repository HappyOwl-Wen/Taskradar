"""Entry point of TaskRadar.exe, the desktop app: double-clicked it opens the TaskRadar window.

With a command it runs the same command line as ``python -m taskradar`` (``TaskRadar.exe --version``, ``migrate``,
``eval``, ``serve`` ...); its output goes to the terminal it was started from. TaskRadar.exe is a windowed program
(no console of its own), so a failure is shown in a message box and written to the log.
"""

from __future__ import annotations

import logging
import sys
import traceback

from taskradar.__main__ import main
from taskradar.desktop import win32

# Commands that print something: they write to the terminal TaskRadar.exe was started from.
CONSOLE_COMMANDS = {"serve", "migrate", "demo-files", "eval", "--version", "-h", "--help"}


def run() -> int:
    argv = sys.argv[1:]
    if argv and argv[0] in CONSOLE_COMMANDS:
        win32.attach_parent_console()
    try:
        return main(argv)
    except SystemExit as exc:  # argparse: --help, --version, wrong arguments
        return exc.code if isinstance(exc.code, int) else 0 if exc.code is None else 1
    except Exception as exc:
        logging.getLogger("taskradar").exception("TaskRadar stopped after an unexpected error")
        if sys.stderr is not None:
            traceback.print_exc()
        win32.message_box(
            "TaskRadar 遇到意外错误，已停止。日志中有详细信息：\n%LOCALAPPDATA%\\TaskRadar\\logs\\taskradar.log\n\n"
            "TaskRadar stopped after an unexpected error; the log has the details.\n\n"
            f"{exc.__class__.__name__}",
            "TaskRadar",
            win32.MB_OK | win32.MB_ICONERROR,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(run())
