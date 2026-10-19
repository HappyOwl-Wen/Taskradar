"""Session, health, system status, settings, notifications, data management."""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from taskradar import __version__
from taskradar.api.deps import get_container
from taskradar.api.errors import ApiError
from taskradar.container import Container
from taskradar.notify import windows as windows_notifications
from taskradar.packaged import is_packaged
from taskradar.security.permissions import SideEffect
from taskradar.security.secrets import LEGACY_SECRETS
from taskradar.services.system import AutostartManager, StartMenuEntry

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "version": __version__}


@router.get("/session")
def session_info(request: Request, c: Container = Depends(get_container)) -> dict[str, Any]:
    general = c.settings.get().general
    return {
        "csrf_token": request.app.state.csrf_token,
        "version": __version__,
        "language": general.language,
        "theme": general.theme,
        "timezone": general.timezone,
        # Shown in the TaskRadar window (not a browser tab): links and the Google sign-in open in the browser.
        "desktop": getattr(request.app.state, "desktop", None) is not None,
    }


def _autostart(request: Request) -> AutostartManager:
    return request.app.state.autostart


def _start_menu(request: Request) -> StartMenuEntry:
    return request.app.state.start_menu


def _banners_missing(request: Request, c: Container) -> bool:
    """Windows would put TaskRadar's notifications only into the notification centre, while the user wants them."""
    entry = _start_menu(request)
    if not (entry.supported and windows_notifications.supported()):
        return False
    settings = c.settings.get()
    wanted = settings.notifications.desktop_enabled or settings.timers.notify
    return wanted and not entry.status()["banners"]


@router.get("/system/status")
def system_status(request: Request, c: Container = Depends(get_container)) -> dict[str, Any]:
    scheduler = getattr(request.app.state, "scheduler", None)
    autostart = _autostart(request)
    return {
        "version": __version__,
        "packaged": is_packaged(),
        "data_dir": str(c.config.data_dir),
        "secret_store": {"backend": c.secrets.backend_name, "available": c.secrets.available()},
        "scheduler": scheduler.status() if scheduler else {"running": False, "jobs": []},
        "google": {
            "client_configured": c.oauth.client_status()["configured"],
            "calendar_connected": c.oauth.connected("calendar"),
        },
        "autostart": {"supported": autostart.supported, "enabled": autostart.enabled()},
        "start_menu": _start_menu(request).status(),
        "desktop_notifications_supported": windows_notifications.supported(),
        "now": c.clock().isoformat(),
    }


@router.get("/system/summary")
def system_summary(request: Request, c: Container = Depends(get_container)) -> dict[str, Any]:
    """Runtime problems in plain terms (what, how many, since when, where to fix it) instead of logs."""
    scheduler = getattr(request.app.state, "scheduler", None)
    running = bool(scheduler and scheduler.status().get("running"))
    return c.status.summary(scheduler_running=running, banners_missing=_banners_missing(request, c))


# ---------------------------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------------------------


@router.get("/settings")
def get_settings(c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.settings.get().model_dump(mode="json")


@router.put("/settings")
def put_settings(body: dict[str, dict[str, Any]], c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.settings.update(body).model_dump(mode="json")


# ---------------------------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------------------------


@router.get("/notifications")
def list_notifications(
    unread_only: bool = False, limit: int = 50, c: Container = Depends(get_container)
) -> dict[str, Any]:
    return {
        "items": c.notifications.list_notifications(unread_only=unread_only, limit=min(limit, 200)),
        "unread": c.notifications.unread_count(),
    }


class ReadBody(BaseModel):
    id: int | None = None


@router.post("/notifications/read")
def read_notifications(body: ReadBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    c.notifications.mark_read(body.id)
    return {"unread": c.notifications.unread_count()}


@router.post("/notifications/scan")
def scan_notifications(c: Container = Depends(get_container)) -> dict[str, Any]:
    from taskradar.domain.enums import JobTrigger

    return c.notifications.scan(JobTrigger.MANUAL)


@router.post("/notifications/test-desktop")
def test_desktop(c: Container = Depends(get_container)) -> dict[str, Any]:
    c.guard.check(SideEffect.DESKTOP_NOTIFY, target="test")
    ok = c.notifications.toast("TaskRadar", "桌面通知已启用 / Desktop notifications work")
    return {"delivered": ok}


# ---------------------------------------------------------------------------------------------
# Data management
# ---------------------------------------------------------------------------------------------


@router.get("/data/export")
def export_data(include_content: bool = True, c: Container = Depends(get_container)) -> JSONResponse:
    c.guard.check(SideEffect.DATA_EXPORT, target="export", include_content=include_content)
    payload = c.data.export(include_content=include_content)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
    return JSONResponse(
        payload, headers={"Content-Disposition": f'attachment; filename="taskradar-export-{stamp}.json"'}
    )


class DeleteAllBody(BaseModel):
    confirm: str


@router.get("/data/legacy")
def legacy_data(c: Container = Depends(get_container)) -> dict[str, Any]:
    """What earlier versions left behind: imported mails and files, a Gmail sign-in, a model API key."""
    return {**c.data.imported_counts(), "credentials": _legacy_credentials(c)}


def _legacy_credentials(c: Container) -> list[str]:
    stored = []
    for name, key in LEGACY_SECRETS.items():
        try:
            if c.secrets.get(key):
                stored.append(name)
        except Exception:  # noqa: S112 - an unavailable credential store has nothing to offer here
            continue
    return stored


class ConfirmBody(BaseModel):
    confirm: bool = False


@router.post("/data/delete-imported")
def delete_imported(body: ConfirmBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    if not body.confirm:
        raise ApiError("confirmation_required", "Please confirm deleting the imported mails and files", 400)
    c.guard.check(SideEffect.DATA_DELETE_ALL, target="imported", confirm_phrase="DELETE")
    return {"deleted": c.data.delete_imported()}


@router.delete("/data/legacy-credentials/{name}")
def delete_legacy_credential(name: str, c: Container = Depends(get_container)) -> dict[str, Any]:
    """Remove a sign-in or key only removed features used (Gmail reading, analysis by a language model)."""
    key = LEGACY_SECRETS.get(name)
    if key is None:
        raise ApiError("unknown_credential", "Unknown credential", 404)
    c.guard.check(SideEffect.CREDENTIAL_DELETE, target=name)
    if name == "gmail":
        c.oauth.forget(key)  # also revoked at Google, so the sign-in cannot be used anywhere any more
    else:
        c.secrets.delete(key)
    return {"credentials": _legacy_credentials(c)}


@router.post("/data/delete-all")
def delete_all(body: DeleteAllBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    c.guard.check(SideEffect.DATA_DELETE_ALL, target="all", confirm_phrase=body.confirm)
    return {"deleted": c.data.delete_all()}


# ---------------------------------------------------------------------------------------------
# Autostart (never changed without explicit confirmation)
# ---------------------------------------------------------------------------------------------


class AutostartBody(BaseModel):
    enabled: bool
    confirm: bool = False


@router.get("/system/autostart")
def get_autostart(request: Request) -> dict[str, Any]:
    manager = _autostart(request)
    return {
        "supported": manager.supported,
        "enabled": manager.enabled(),
        "path": str(manager.path) if manager.path else None,
    }


@router.post("/system/autostart")
def set_autostart(body: AutostartBody, request: Request, c: Container = Depends(get_container)) -> dict[str, Any]:
    manager = _autostart(request)
    if not manager.supported:
        raise ApiError("autostart_unsupported", "Autostart is only available on Windows", 409)
    c.guard.check(SideEffect.AUTOSTART_MODIFY, target=str(manager.path), confirmed=body.confirm)
    try:
        manager.enable() if body.enabled else manager.disable()
    except RuntimeError as exc:
        raise ApiError("autostart_failed", str(exc), 409) from exc
    return {"supported": True, "enabled": manager.enabled(), "path": str(manager.path)}


class StartMenuBody(BaseModel):
    enabled: bool
    confirm: bool = False


@router.post("/system/start-menu")
def set_start_menu(body: StartMenuBody, request: Request, c: Container = Depends(get_container)) -> dict[str, Any]:
    """Add TaskRadar to the Start menu (so Windows shows its notifications as banners), or remove that entry."""
    entry = _start_menu(request)
    if not entry.supported:
        raise ApiError("start_menu_unsupported", "The Start menu entry is only available on Windows", 409)
    c.guard.check(SideEffect.START_MENU_MODIFY, target=str(entry.path), confirmed=body.confirm)
    try:
        entry.add() if body.enabled else entry.remove()
    except (RuntimeError, OSError) as exc:
        raise ApiError("start_menu_failed", str(exc), 409) from exc
    return entry.status()
