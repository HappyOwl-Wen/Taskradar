"""What the web UI tells the desktop window: unsaved changes (asked about on closing), theme and language."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from taskradar.api.errors import ApiError

router = APIRouter(prefix="/api/desktop", tags=["desktop"])


class DesktopState(BaseModel):
    unsaved: bool | None = None
    theme: Literal["light", "dark"] | None = None
    language: Literal["zh-CN", "en"] | None = None


@router.put("/state")
def update_state(body: DesktopState, request: Request) -> dict[str, Any]:
    bridge = getattr(request.app.state, "desktop", None)
    if bridge is None:
        raise ApiError("not_desktop", "Only available in the TaskRadar desktop window", 404)
    bridge.update(unsaved=body.unsaved, theme=body.theme, language=body.language)
    return {"ok": True}
