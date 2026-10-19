"""What the web UI tells the desktop window (unsaved changes, theme and language), and "come forward"."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from taskradar.api.errors import ApiError
from taskradar.desktop.bridge import DesktopBridge

router = APIRouter(prefix="/api/desktop", tags=["desktop"])


class DesktopState(BaseModel):
    unsaved: bool | None = None
    theme: Literal["light", "dark"] | None = None
    language: Literal["zh-CN", "en"] | None = None


def _bridge(request: Request) -> DesktopBridge:
    bridge = getattr(request.app.state, "desktop", None)
    if bridge is None:
        raise ApiError("not_desktop", "Only available in the TaskRadar desktop window", 404)
    return bridge


@router.put("/state")
def update_state(body: DesktopState, request: Request) -> dict[str, Any]:
    _bridge(request).update(unsaved=body.unsaved, theme=body.theme, language=body.language)
    return {"ok": True}


@router.post("/activate")
def activate(request: Request) -> dict[str, Any]:
    """Show the window and bring it to the front, also out of the tray: TaskRadar was started a second time."""
    _bridge(request).activate()
    return {"ok": True}
