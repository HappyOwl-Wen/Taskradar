"""The local server of the desktop app, run in a background thread of the same process.

Building the app (which opens the database and applies migrations) happens in that thread too, so the window
appears at once and shows a start screen until the server answers. Stopping it lets running requests finish
(at most a few seconds) and stops the background jobs, as closing the console window of the browser version did.
"""

from __future__ import annotations

import logging
import socket
import sys
import threading
import time
from typing import TYPE_CHECKING

from taskradar.config import AppConfig

if TYPE_CHECKING:
    import uvicorn

    from taskradar.container import Container
    from taskradar.desktop.bridge import DesktopBridge

log = logging.getLogger(__name__)


def port_available(host: str, port: int) -> bool:
    """Whether a server could listen on this address now, bound the way uvicorn binds it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if sys.platform != "win32":
            # As asyncio does on POSIX: connections of an earlier server still in TIME_WAIT do not block a new
            # listener. (On Windows the option would even allow binding over a live listener, so it stays off.)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def choose_port(host: str, preferred: int) -> int:
    """The configured port if it is free, otherwise any free one: the window does not need a fixed address."""
    if preferred > 0 and port_available(host, preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        port = int(sock.getsockname()[1])
    if preferred > 0:
        log.info("Port %s is in use; the desktop app uses port %s instead", preferred, port)
    return port


class BackgroundServer:
    def __init__(self, config: AppConfig, bridge: DesktopBridge | None = None) -> None:
        self.config = config
        self.bridge = bridge
        self.error: str | None = None
        self._server: uvicorn.Server | None = None
        self._container: Container | None = None
        self._done = threading.Event()
        self._stopping = threading.Event()
        self._lifecycle_lock = threading.RLock()
        self._thread = threading.Thread(target=self._run, name="taskradar-server", daemon=True)

    @property
    def url(self) -> str:
        return self.config.base_url

    @property
    def ready(self) -> bool:
        return bool(
            self._server is not None
            and self._server.started
            and not self._stopping.is_set()
            and not self._done.is_set()
        )

    @property
    def container(self) -> Container | None:
        """The services once the server has built them (None while it starts or after a failed start)."""
        return None if self._stopping.is_set() or self._done.is_set() else self._container

    def start(self) -> None:
        with self._lifecycle_lock:
            self._thread.start()

    def restart(self, cancel: threading.Event | None = None) -> bool:
        """Rebuild the service on the same address, only after its old worker has fully stopped."""
        with self._lifecycle_lock:
            if not self.stop():
                self.error = "shutdown_timeout"
                return False
            if cancel is not None and cancel.is_set():
                return False
            self.error = None
            self._server = None
            self._container = None
            self._done.clear()
            self._stopping.clear()
            self._thread = threading.Thread(target=self._run, name="taskradar-server", daemon=True)
            self.start()
        return self.wait_ready(cancel=cancel)

    def _run(self) -> None:
        try:
            import uvicorn

            from taskradar.api.app import create_app
            from taskradar.container import build_container

            container = self._container = build_container(self.config)
            app = create_app(container, enable_scheduler=self.config.scheduler_enabled, desktop=self.bridge)
            self._server = uvicorn.Server(
                uvicorn.Config(
                    app,
                    host=self.config.host,
                    port=self.config.port,
                    log_config=None,
                    access_log=False,
                    server_header=False,
                    timeout_graceful_shutdown=5,
                )
            )
            log.info("TaskRadar desktop server starting on %s (data: %s)", self.url, self.config.data_dir)
            if self._stopping.is_set():  # the window was closed while the database was being prepared
                return
            self._server.run()
            if not self._server.started and self.error is None:
                self.error = "server_not_started"  # uvicorn logs why (for example the port was taken meanwhile)
        except BaseException as exc:  # SystemExit from uvicorn included: the window shows the failure
            self.error = exc.__class__.__name__
            log.exception("The TaskRadar server could not start")
        finally:
            if self._container is not None:
                self._container.dispose()  # closes the database cleanly
            self._done.set()

    def wait_ready(self, timeout: float = 120.0, cancel: threading.Event | None = None) -> bool:
        """True once the server answers; False if it failed (see ``error``), did not start in time or ``cancel``
        was set (the window was closed meanwhile)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.ready:
                return True
            if self._done.is_set() or (cancel is not None and cancel.is_set()):
                return False
            time.sleep(0.05)
        self.error = self.error or "timeout"
        return False

    def stop(self, timeout: float = 15.0) -> bool:
        with self._lifecycle_lock:
            self._stopping.set()
            if self._server is not None:
                self._server.should_exit = True
            if self._thread.is_alive():
                self._thread.join(timeout)
            return not self._thread.is_alive()
