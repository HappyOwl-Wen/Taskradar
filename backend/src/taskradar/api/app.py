"""FastAPI application factory."""

from __future__ import annotations

import logging
import secrets
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from taskradar import __version__
from taskradar.api.errors import install_error_handlers
from taskradar.api.middleware import SecurityMiddleware
from taskradar.api.routes import desktop as desktop_routes
from taskradar.api.routes import integrations, system, tasks, timers
from taskradar.container import Container
from taskradar.desktop.bridge import DesktopBridge
from taskradar.services.system import AutostartManager, StartMenuEntry

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

_FALLBACK_HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>TaskRadar</title></head>
<body style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto">
<h1>TaskRadar</h1><p>后端已运行，但前端尚未构建。请运行 <code>scripts\\setup.ps1</code> 或在 <code>frontend</code>
目录执行 <code>npm run build</code>。</p><p>The API is running but the web UI has not been built yet.</p>
</body></html>"""


def create_app(
    container: Container,
    *,
    enable_scheduler: bool = False,
    autostart: AutostartManager | None = None,
    start_menu: StartMenuEntry | None = None,
    static_dir: Path | None = None,
    extra_hosts: set[str] | None = None,
    desktop: DesktopBridge | None = None,
) -> FastAPI:
    static_root = static_dir or STATIC_DIR
    scheduler = None
    if enable_scheduler:
        from taskradar.scheduler.service import SchedulerService

        scheduler = SchedulerService(container)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if scheduler is not None:
            scheduler.start()
        try:
            yield
        finally:
            if scheduler is not None:
                scheduler.shutdown()
            app.state.executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(
        title="TaskRadar",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.container = container
    app.state.csrf_token = secrets.token_urlsafe(32)
    app.state.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="taskradar-bg")
    app.state.scheduler = scheduler
    app.state.autostart = autostart or AutostartManager()
    app.state.start_menu = start_menu or StartMenuEntry()
    # Set when the server runs inside the desktop window (taskradar.desktop); None for the browser version.
    app.state.desktop = desktop

    port = container.config.port
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}", *(extra_hosts or set())}
    origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    if container.config.dev_origin:
        origins.add(container.config.dev_origin)
        dev_host = container.config.dev_origin.split("://", 1)[-1]
        hosts.add(dev_host)
    app.add_middleware(
        SecurityMiddleware, allowed_hosts=hosts, allowed_origins=origins, csrf_token=app.state.csrf_token
    )
    install_error_handlers(app)

    for router in (system.router, tasks.router, timers.router, integrations.router, desktop_routes.router):
        app.include_router(router)

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    def api_not_found(rest: str) -> JSONResponse:
        return JSONResponse(
            status_code=404,
            content={
                "error": {"code": "not_found", "message": "Unknown API endpoint", "recoverable": False, "details": {}}
            },
        )

    assets = static_root / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    index = static_root / "index.html"

    @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
    def spa(full_path: str) -> FileResponse | HTMLResponse:
        candidate = (static_root / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(static_root.resolve()):
            return FileResponse(candidate)
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return HTMLResponse(_FALLBACK_HTML)

    return app
