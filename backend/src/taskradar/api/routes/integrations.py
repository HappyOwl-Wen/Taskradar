"""Google OAuth setup, staged calendar grants and actual authorization status."""

from __future__ import annotations

import logging
from html import escape
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

from taskradar.api.deps import get_container
from taskradar.api.errors import ApiError
from taskradar.connectors.google_oauth import SERVICES, OAuthError
from taskradar.container import Container
from taskradar.security.permissions import SideEffect

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["integrations"])


@router.get("/integrations/google")
def google_status(c: Container = Depends(get_container)) -> dict[str, Any]:
    return {
        "client": c.oauth.client_status(),
        "redirect_uri": c.oauth.redirect_uri,
        "calendar": {**c.calendar.status(), **c.oauth.capabilities()},
        "last_authorization": c.oauth.last_result,
    }


@router.post("/integrations/google/client-config")
async def upload_client_config(file: UploadFile = File(...), c: Container = Depends(get_container)) -> dict[str, Any]:
    raw = await file.read(64 * 1024 + 1)
    if len(raw) > 64 * 1024:
        raise ApiError("invalid_client_config", "The file is too large to be an OAuth client JSON", 413)
    return c.oauth.save_client_config(raw)


@router.delete("/integrations/google/client-config")
def delete_client_config(c: Container = Depends(get_container)) -> dict[str, Any]:
    c.oauth.delete_client_config()
    return c.oauth.client_status()


class ConnectBody(BaseModel):
    access: Literal["app", "read", "edit"] = "app"


@router.post("/integrations/google/{service}/connect")
def connect(service: str, body: ConnectBody = ConnectBody(), c: Container = Depends(get_container)) -> dict[str, Any]:
    if service not in SERVICES:
        raise ApiError("unknown_service", "Unknown service", 404)
    c.guard.check(SideEffect.OAUTH_CONNECT, target=service)
    return {"auth_url": c.oauth.start(service, body.access)}


@router.post("/integrations/google/{service}/disconnect")
def disconnect(service: str, c: Container = Depends(get_container)) -> dict[str, Any]:
    if service not in SERVICES:
        raise ApiError("unknown_service", "Unknown service", 404)
    c.guard.check(SideEffect.OAUTH_REVOKE, target=service)
    c.oauth.disconnect(service)
    return {"connected": False}


@router.get("/oauth/google/callback", response_model=None)
def oauth_callback(
    request: Request,
    state: str | None = None,
    code: str | None = None,
    error: str | None = None,
    c: Container = Depends(get_container),
) -> RedirectResponse | HTMLResponse:
    desktop = getattr(request.app.state, "desktop", None)
    try:
        service = c.oauth.complete(state=state, code=code, error=error)
    except OAuthError as exc:
        log.info("OAuth callback rejected: %s", exc.code)
        c.oauth.record_result(None, exc.code)
        if desktop is not None:
            desktop.activate()
            return _finished_in_browser(c, service=None, error=exc.code)
        return RedirectResponse(f"/settings?oauth_error={quote(exc.code)}", status_code=303)
    c.oauth.record_result(service, None)
    if desktop is not None:
        # Signed in in the system browser: the desktop window shows the result; this tab can be closed.
        desktop.activate()
        return _finished_in_browser(c, service=service, error=None)
    return RedirectResponse(f"/settings?connected={quote(service)}", status_code=303)


_FINISHED = {
    "zh-CN": {
        "calendar": "Google 日历已连接",
        "failed": "授权没有完成",
        "back": "可以关闭这个浏览器标签页，回到 TaskRadar 窗口。",
        "retry": "回到 TaskRadar 窗口后可以重试。错误代码：",
    },
    "en": {
        "calendar": "Google Calendar is connected",
        "failed": "The authorization was not completed",
        "back": "You can close this browser tab and return to the TaskRadar window.",
        "retry": "You can try again in the TaskRadar window. Error code:",
    },
}


def _finished_in_browser(c: Container, *, service: str | None, error: str | None) -> HTMLResponse:
    language = c.settings.get().general.language
    text = _FINISHED["en" if language == "en" else "zh-CN"]
    title = text["failed"] if error else text["calendar"]
    detail = f"{text['retry']} <code>{escape(error)}</code>" if error else text["back"]
    html = f"""<!doctype html><html lang="{escape(language)}"><head><meta charset="utf-8"><title>TaskRadar</title>
<meta name="color-scheme" content="light dark"></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText;
font:15px/1.6 'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI',sans-serif">
<main style="max-width:28rem;padding:24px;text-align:center">
<h1 style="font-size:20px;line-height:28px;font-weight:600;margin:0 0 8px">{escape(title)}</h1>
<p style="margin:0;opacity:.75">{detail}</p></main></body></html>"""
    return HTMLResponse(html, status_code=200 if error is None else 400)
