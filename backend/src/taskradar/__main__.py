"""Command line entry point: ``python -m taskradar [desktop|serve|migrate|demo-files|eval|uninstall]``.

Without a command, TaskRadar.exe opens the desktop window and ``python -m taskradar`` starts the browser version.
"""

from __future__ import annotations

import argparse
import contextlib
import logging
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO

from taskradar import __version__

if TYPE_CHECKING:
    from taskradar.config import AppConfig

log = logging.getLogger("taskradar")


class InstanceLock:
    """Prevents two TaskRadar servers from sharing one data folder."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fh: BinaryIO | None = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.path, "a+b")  # noqa: SIM115 - kept open for the process lifetime
        try:
            if sys.platform == "win32":
                import msvcrt

                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        self._fh = fh
        return True


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host if host != "localhost" else "127.0.0.1", port)) != 0


def _load_env_files() -> None:
    from taskradar.config import load_dotenv
    from taskradar.packaged import program_dir

    here = Path.cwd()
    beside_exe = program_dir()
    # The packaged program looks next to TaskRadar.exe; from source, next to the repository.
    candidates = (
        (here / ".env", beside_exe / ".env")
        if beside_exe
        else (here / ".env", here.parent / ".env", Path(__file__).resolve().parents[3] / ".env")
    )
    for candidate in candidates:
        load_dotenv(candidate)


def _config(args: argparse.Namespace) -> AppConfig:
    from taskradar.config import load_config
    from taskradar.logging_setup import configure_logging

    _load_env_files()
    overrides: dict[str, object] = {}
    if args.port:
        overrides["port"] = args.port
    if getattr(args, "no_browser", False):
        overrides["open_browser"] = False
    if args.data_dir:
        overrides["data_dir"] = Path(args.data_dir).expanduser().resolve()
    config = load_config(**overrides)
    configure_logging(config.logs_dir, config.log_level)
    return config


def cmd_desktop(args: argparse.Namespace) -> int:
    from taskradar.desktop.shell import run

    config = _config(args)
    # ``--no-browser`` came from autostart entries of earlier versions: start quietly, in the taskbar.
    code = run(config, minimized=args.minimized or args.no_browser, debug=args.debug)
    # Window closed, server stopped, database closed, position saved: end the process now. Left to itself, the
    # process would spend seconds shutting down the .NET runtime of the window (Python's unload, then the runtime's
    # own finalizer timeout), and opening TaskRadar again meanwhile would find the old one still running.
    logging.shutdown()
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.TerminateProcess(kernel32.GetCurrentProcess(), code)
    os._exit(code)


def cmd_serve(args: argparse.Namespace) -> int:
    from taskradar.desktop.instance import clear_instance, read_instance, write_instance

    config = _config(args)
    lock = InstanceLock(config.data_dir / "taskradar.lock")
    if not lock.acquire():
        running = read_instance(config.data_dir)
        url = str(running["url"]) if running and running.get("url") else config.base_url
        print(f"TaskRadar is already running for this data folder: {url}")
        if config.open_browser:
            webbrowser.open(url)
        return 0
    if not _port_free(config.host, config.port):
        print(f"Port {config.port} is already in use. Set TASKRADAR_PORT or use --port to choose another port.")
        return 2

    import uvicorn

    from taskradar.api.app import create_app
    from taskradar.container import build_container

    container = build_container(config)
    app = create_app(container, enable_scheduler=config.scheduler_enabled)
    log.info("TaskRadar %s starting on %s (data: %s)", __version__, config.base_url, config.data_dir)
    if not container.ocr.available():
        log.warning("No OCR engine found - scanned PDFs and screenshots cannot be read. See README (Tesseract).")
    if config.open_browser:
        threading.Timer(1.5, lambda: webbrowser.open(config.base_url)).start()
    write_instance(config.data_dir, mode="serve", url=config.base_url)
    try:
        uvicorn.run(app, host=config.host, port=config.port, log_config=None, access_log=False, server_header=False)
    finally:
        clear_instance(config.data_dir)
    return 0


def cmd_migrate(args: argparse.Namespace) -> int:
    from taskradar.config import load_config
    from taskradar.db.migrate import upgrade_to_head
    from taskradar.db.session import create_sqlite_engine

    config = load_config(**({"data_dir": Path(args.data_dir).expanduser().resolve()} if args.data_dir else {}))
    config.ensure_dirs()
    upgrade_to_head(create_sqlite_engine(config.database_url))
    print(f"Database at {config.db_path} is up to date.")
    return 0


def cmd_demo_files(args: argparse.Namespace) -> int:
    from taskradar.demo.samples import write_samples

    target = Path(args.target).resolve()
    written = write_samples(target)
    for path in written:
        print(path)
    return 0


def cmd_eval(args: argparse.Namespace) -> int:
    from taskradar.evaluation import run_evaluation

    report = run_evaluation(Path(args.dataset) if args.dataset else None)
    print(report.to_text())
    if args.json:
        Path(args.json).write_text(report.to_json(), encoding="utf-8")
    return 0


def cmd_uninstall(args: argparse.Namespace) -> int:
    from taskradar.desktop.install import uninstall_command

    return uninstall_command(quiet=args.quiet)


def main(argv: list[str] | None = None) -> int:
    from taskradar.packaged import is_packaged

    parser = argparse.ArgumentParser(prog="taskradar", description="TaskRadar - personal obligation radar")
    parser.add_argument("--version", action="version", version=f"TaskRadar {__version__}")
    sub = parser.add_subparsers(dest="command")
    data_help = r"data folder (default: %%LOCALAPPDATA%%\TaskRadar)"

    desktop = sub.add_parser("desktop", help="open the TaskRadar window (default of TaskRadar.exe)")
    desktop.add_argument("--port", type=int, default=None, help="preferred port (another free one if it is taken)")
    desktop.add_argument("--data-dir", default=None, help=data_help)
    desktop.add_argument("--minimized", action="store_true", help="start in the taskbar (autostart)")
    desktop.add_argument("--no-browser", action="store_true", help=argparse.SUPPRESS)
    desktop.add_argument("--debug", action="store_true", help="developer tools and the browser's context menu")
    desktop.set_defaults(func=cmd_desktop)

    serve = sub.add_parser("serve", help="start the local server and use TaskRadar in the browser")
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--no-browser", action="store_true")
    serve.add_argument("--data-dir", default=None, help=data_help)
    serve.set_defaults(func=cmd_serve)

    migrate = sub.add_parser("migrate", help="apply database migrations")
    migrate.add_argument("--data-dir", default=None)
    migrate.set_defaults(func=cmd_migrate)

    demo = sub.add_parser("demo-files", help="write synthetic demo PDFs / screenshots into a folder")
    demo.add_argument("target")
    demo.set_defaults(func=cmd_demo_files)

    ev = sub.add_parser("eval", help="run the extraction / dedup evaluation on the synthetic labelled dataset")
    ev.add_argument("--dataset", default=None)
    ev.add_argument("--json", default=None, help="also write the report as JSON")
    ev.set_defaults(func=cmd_eval)

    uninstall = sub.add_parser("uninstall", help="remove the installed TaskRadar (your data is kept)")
    uninstall.add_argument("--quiet", action="store_true", help="no questions (for scripts)")
    uninstall.set_defaults(func=cmd_uninstall)

    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or (argv[0].startswith("--") and argv[0] not in ("--version", "-h", "--help")):
        argv = ["desktop" if is_packaged() else "serve", *argv]
    args = parser.parse_args(argv)
    if os.environ.get("PYTHONIOENCODING") is None and hasattr(sys.stdout, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            sys.stdout.reconfigure(encoding="utf-8")
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
