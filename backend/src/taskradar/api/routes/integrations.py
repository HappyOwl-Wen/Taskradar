"""Google OAuth (Gmail read-only, Calendar app-created) setup and status."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from taskradar.api.deps import get_container
from taskradar.api.errors import ApiError
from taskradar.api.serializers import source_to_dict
from taskradar.connectors.errors import ConnectorError
from taskradar.connectors.gmail import GoogleGmailClient
from taskradar.connectors.google_oauth import CALENDAR_SCOPES, GMAIL_SCOPES, SERVICES, OAuthError
from taskradar.container import Container
from taskradar.db.models import Source
from taskradar.db.session import transaction
from taskradar.domain.enums import JobTrigger, SourceKind, SourceStatus
from taskradar.security.permissions import SideEffect

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["integrations"])


def _gmail_source(c: Container) -> dict[str, Any] | None:
    with transaction(c.factory) as session:
        source = session.scalar(select(Source).where(Source.kind == SourceKind.GMAIL.value).order_by(Source.id))
        return source_to_dict(source) if source else None


@router.get("/integrations/google")
def google_status(c: Container = Depends(get_container)) -> dict[str, Any]:
    return {
        "client": c.oauth.client_status(),
        "redirect_uri": c.oauth.redirect_uri,
        "gmail": {"connected": c.oauth.connected("gmail"), "scopes": GMAIL_SCOPES, "source": _gmail_source(c)},
        "calendar": {**c.calendar.status(), "scopes": CALENDAR_SCOPES},
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


@router.post("/integrations/google/{service}/connect")
def connect(service: str, c: Container = Depends(get_container)) -> dict[str, Any]:
    if service not in SERVICES:
        raise ApiError("unknown_service", "Unknown service", 404)
    c.guard.check(SideEffect.OAUTH_CONNECT, target=service)
    return {"auth_url": c.oauth.start(service)}


@router.post("/integrations/google/{service}/disconnect")
def disconnect(service: str, c: Container = Depends(get_container)) -> dict[str, Any]:
    if service not in SERVICES:
        raise ApiError("unknown_service", "Unknown service", 404)
    c.guard.check(SideEffect.OAUTH_REVOKE, target=service)
    c.oauth.disconnect(service)
    if service == "gmail":
        with transaction(c.factory) as session:
            for source in session.scalars(select(Source).where(Source.kind == SourceKind.GMAIL.value)):
                source.status = SourceStatus.DISCONNECTED.value
    return {"connected": False}


@router.get("/oauth/google/callback")
def oauth_callback(
    request: Request,
    state: str | None = None,
    code: str | None = None,
    error: str | None = None,
    c: Container = Depends(get_container),
) -> RedirectResponse:
    try:
        service = c.oauth.complete(state=state, code=code, error=error)
    except OAuthError as exc:
        log.info("OAuth callback rejected: %s", exc.code)
        return RedirectResponse(f"/settings?oauth_error={quote(exc.code)}", status_code=303)
    if service == "gmail":
        account = None
        try:
            account = GoogleGmailClient(c.oauth.credentials("gmail")).get_profile().get("emailAddress")
        except ConnectorError as exc:
            log.warning("Could not read Gmail profile after authorization: %s", exc.code)
        with transaction(c.factory) as session:
            source = session.scalar(select(Source).where(Source.kind == SourceKind.GMAIL.value).order_by(Source.id))
            if source is None:
                source = Source(kind=SourceKind.GMAIL.value, name="Gmail", account=account, status="ok")
                session.add(source)
                session.flush()
            else:
                source.status = SourceStatus.OK.value
                source.account = account or source.account
                source.last_error_code = None
                source.last_error_message = None
            source_id = source.id

        def initial_sync() -> None:
            try:
                c.gmail.sync(source_id, trigger=JobTrigger.MANUAL)
            except Exception:
                log.exception("Initial Gmail sync failed")

        request.app.state.executor.submit(initial_sync)
    return RedirectResponse(f"/settings?connected={quote(service)}", status_code=303)
