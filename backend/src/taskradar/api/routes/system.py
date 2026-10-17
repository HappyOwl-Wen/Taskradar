"""Session, health, system status, settings, secrets, notifications, metrics, data management."""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from taskradar import __version__
from taskradar.api.deps import get_container
from taskradar.api.errors import ApiError
from taskradar.container import Container
from taskradar.llm.base import LLMError
from taskradar.notify.desktop import desktop_notifications_supported
from taskradar.packaged import is_packaged
from taskradar.security import secrets as sk
from taskradar.security.permissions import SideEffect
from taskradar.services.system import AutostartManager

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


@router.get("/system/status")
def system_status(request: Request, c: Container = Depends(get_container)) -> dict[str, Any]:
    settings = c.settings.get()
    ocr = c.ocr
    scheduler = getattr(request.app.state, "scheduler", None)
    autostart = _autostart(request)
    key_source = None
    try:
        if c.secrets.get(sk.OPENAI_API_KEY):
            key_source = "credential_store"
    except Exception:
        key_source = None
    if key_source is None and c.guard.llm_api_key():
        key_source = "environment"
    return {
        "version": __version__,
        "packaged": is_packaged(),
        "data_dir": str(c.config.data_dir),
        "ocr": {
            "engine": ocr.name,
            "available": ocr.available(),
            "languages": ocr.languages(),
            "version": getattr(ocr, "version", lambda: None)(),
            "backlog": len(c.documents.ocr_backlog()),
            "reprocessing": c.documents.ocr_backlog_running(),
        },
        "secret_store": {"backend": c.secrets.backend_name, "available": c.secrets.available()},
        "scheduler": scheduler.status() if scheduler else {"running": False, "jobs": []},
        "agent_mode": c.agent.mode(),
        "llm": {
            "provider": settings.llm.provider,
            "model": settings.llm.model,
            "api_key_configured": key_source is not None,
            "api_key_source": key_source,
            "cloud_consent": settings.llm.cloud_consent,
        },
        "google": {
            "client_configured": c.oauth.client_status()["configured"],
            "gmail_connected": c.oauth.connected("gmail"),
            "calendar_connected": c.oauth.connected("calendar"),
        },
        "autostart": {"supported": autostart.supported, "enabled": autostart.enabled()},
        "desktop_notifications_supported": desktop_notifications_supported(),
        "now": c.clock().isoformat(),
    }


@router.get("/system/summary")
def system_summary(request: Request, c: Container = Depends(get_container)) -> dict[str, Any]:
    """Runtime problems in plain terms (what, how many, since when, where to fix it) instead of logs."""
    scheduler = getattr(request.app.state, "scheduler", None)
    running = bool(scheduler and scheduler.status().get("running"))
    return c.status.summary(scheduler_running=running)


# ---------------------------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------------------------


@router.get("/settings")
def get_settings(c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.settings.get().model_dump(mode="json")


@router.put("/settings")
def put_settings(body: dict[str, dict[str, Any]], c: Container = Depends(get_container)) -> dict[str, Any]:
    llm = body.get("llm")
    if isinstance(llm, dict) and "consent_at" in llm:
        llm.pop("consent_at")
    if isinstance(llm, dict) and llm.get("cloud_consent") is True and not c.settings.get().llm.cloud_consent:
        llm["consent_at"] = c.clock().isoformat()
    if isinstance(llm, dict) and llm.get("cloud_consent") is False:
        llm["consent_at"] = None
    return c.settings.update(body).model_dump(mode="json")


class ApiKeyBody(BaseModel):
    api_key: str = Field(min_length=8, max_length=400)


@router.put("/settings/llm-key")
def set_llm_key(body: ApiKeyBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    key = body.api_key.strip()
    if any(ch.isspace() for ch in key):
        raise ApiError("invalid_api_key", "The API key must not contain spaces", 422)
    c.secrets.set(sk.OPENAI_API_KEY, key)
    return {"configured": True}


@router.delete("/settings/llm-key")
def delete_llm_key(c: Container = Depends(get_container)) -> dict[str, Any]:
    c.secrets.delete(sk.OPENAI_API_KEY)
    return {"configured": False}


@router.post("/settings/llm/test")
def test_llm(c: Container = Depends(get_container)) -> dict[str, Any]:
    provider = c.agent.llm_provider()
    if provider is None:
        raise ApiError("llm_not_configured", "No model provider or API key is configured", 409)
    c.guard.check(SideEffect.LLM_SEND, target="connection_test", kind="test")
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"ok": {"type": "boolean"}},
        "required": ["ok"],
    }
    try:
        response = provider.complete_json(
            system='Reply with JSON {"ok": true}.',
            user="ping",
            schema_name="connection_test",
            schema=schema,
            max_output_tokens=200,
        )
    except LLMError as exc:
        raise ApiError(exc.code, str(exc), 502) from exc
    return {
        "ok": True,
        "model": response.model,
        "latency_ms": response.latency_ms,
        "input_tokens": response.input_tokens,
        "output_tokens": response.output_tokens,
    }


# ---------------------------------------------------------------------------------------------
# Notifications & metrics
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


@router.get("/metrics")
def metrics(c: Container = Depends(get_container)) -> dict[str, Any]:
    return {**c.metrics.summary(), "agent_mode": c.agent.mode()}


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
