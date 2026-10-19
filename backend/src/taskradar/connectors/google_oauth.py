"""Google OAuth 2.0 for installed (desktop) apps with PKCE and loopback redirect.

Only Google Calendar is authorized, with the minimum scope ``calendar.app.created`` (TaskRadar can only manage
the calendar and events it creates itself). Earlier versions could also read Gmail (``gmail.readonly``); such a
stored sign-in is only ever deleted (and revoked at Google), never used.

Tokens are stored in the OS credential store via :mod:`taskradar.security.secrets`.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from taskradar.connectors.errors import AuthRequiredError
from taskradar.security import secrets as sk
from taskradar.security.secrets import SecretStore

log = logging.getLogger(__name__)

# The token endpoint may return scopes in a different order; we verify scopes ourselves.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.app.created"]
SERVICES: dict[str, tuple[list[str], str]] = {
    "calendar": (CALENDAR_SCOPES, sk.GOOGLE_TOKEN_CALENDAR),
}
PENDING_TTL = dt.timedelta(minutes=15)


class OAuthError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class _Pending:
    service: str
    flow: Any
    created: dt.datetime


def validate_client_config(raw: bytes | str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise OAuthError("invalid_client_config", "The file is not valid JSON") from exc
    if not isinstance(data, dict):
        raise OAuthError("invalid_client_config", "Unexpected client configuration format")
    if "web" in data and "installed" not in data:
        raise OAuthError(
            "wrong_client_type",
            "This is a 'Web application' OAuth client. Please create an OAuth client of type 'Desktop app'.",
        )
    installed = data.get("installed")
    if not isinstance(installed, dict):
        raise OAuthError("invalid_client_config", "Expected an 'installed' (Desktop app) OAuth client JSON")
    required = ("client_id", "client_secret", "auth_uri", "token_uri")
    missing = [k for k in required if not installed.get(k)]
    if missing:
        raise OAuthError("invalid_client_config", f"Missing fields: {', '.join(missing)}")
    if not str(installed["client_id"]).endswith(".apps.googleusercontent.com"):
        raise OAuthError("invalid_client_config", "The client_id does not look like a Google OAuth client")
    return {"installed": {k: installed[k] for k in (*required, "project_id") if k in installed}}


class GoogleOAuthManager:
    def __init__(
        self,
        secrets: SecretStore,
        *,
        redirect_uri: str,
        clock: Callable[[], dt.datetime] = lambda: dt.datetime.now(dt.UTC),
    ) -> None:
        self.secrets = secrets
        self.redirect_uri = redirect_uri
        self.clock = clock
        self._pending: dict[str, _Pending] = {}
        self._lock = threading.Lock()
        # How the last authorization ended, for a page that waits while the user signs in elsewhere (the desktop
        # app opens Google in the system browser). ``seq`` grows with every result.
        self.last_result: dict[str, Any] | None = None
        self._results = 0

    # -- client configuration ----------------------------------------------------------------

    def client_config(self) -> dict[str, Any] | None:
        raw = self.secrets.get(sk.GOOGLE_CLIENT_CONFIG)
        return json.loads(raw) if raw else None

    def client_status(self) -> dict[str, Any]:
        cfg = self.client_config()
        if not cfg:
            return {"configured": False}
        client_id = cfg["installed"]["client_id"]
        return {"configured": True, "client_id_hint": client_id[:6] + "…" + client_id[-28:]}

    def save_client_config(self, raw: bytes | str) -> dict[str, Any]:
        cfg = validate_client_config(raw)
        self.secrets.set(sk.GOOGLE_CLIENT_CONFIG, json.dumps(cfg))
        return self.client_status()

    def delete_client_config(self) -> None:
        self.secrets.delete(sk.GOOGLE_CLIENT_CONFIG)

    # -- authorization flow ------------------------------------------------------------------

    def start(self, service: str) -> str:
        if service not in SERVICES:
            raise OAuthError("unknown_service", f"Unknown service {service}")
        cfg = self.client_config()
        if not cfg:
            raise OAuthError("client_not_configured", "Upload your Google OAuth client JSON first")
        from google_auth_oauthlib.flow import Flow

        scopes, _ = SERVICES[service]
        flow = Flow.from_client_config(
            cfg, scopes=scopes, redirect_uri=self.redirect_uri, autogenerate_code_verifier=True
        )
        url, state = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="false")
        with self._lock:
            now = self.clock()
            self._pending = {k: v for k, v in self._pending.items() if now - v.created < PENDING_TTL}
            self._pending[state] = _Pending(service, flow, now)
        return str(url)

    def complete(self, *, state: str | None, code: str | None, error: str | None) -> str:
        with self._lock:
            pending = self._pending.pop(state or "", None)
        if pending is None:
            raise OAuthError("invalid_state", "The authorization request expired or is unknown; please try again")
        if error:
            raise OAuthError("access_denied", "Authorization was cancelled or denied")
        if not code:
            raise OAuthError("missing_code", "Google did not return an authorization code")
        try:
            pending.flow.fetch_token(code=code)
        except Exception as exc:  # oauthlib raises a variety of errors
            raise OAuthError(
                "token_exchange_failed", f"Could not complete authorization: {exc.__class__.__name__}"
            ) from exc
        creds = pending.flow.credentials
        scopes, token_key = SERVICES[pending.service]
        granted = set(getattr(creds, "granted_scopes", None) or creds.scopes or [])
        if granted and not set(scopes) <= granted:
            raise OAuthError("scope_not_granted", "The required permission was not granted")
        self.secrets.set(token_key, creds.to_json())
        return pending.service

    def record_result(self, service: str | None, error: str | None) -> None:
        with self._lock:
            self._results += 1
            self.last_result = {"seq": self._results, "service": service, "ok": error is None, "error": error}

    # -- credentials ---------------------------------------------------------------------------

    def connected(self, service: str) -> bool:
        return bool(self.secrets.get(SERVICES[service][1]))

    def credentials(self, service: str) -> Any:
        from google.auth.exceptions import RefreshError
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials

        scopes, token_key = SERVICES[service]
        raw = self.secrets.get(token_key)
        if not raw:
            raise AuthRequiredError(f"{service} is not connected")
        try:
            creds = Credentials.from_authorized_user_info(json.loads(raw), scopes)
        except (ValueError, KeyError) as exc:
            raise AuthRequiredError("The stored authorization is invalid; please reconnect") from exc
        if not creds.valid:
            if creds.refresh_token:
                try:
                    creds.refresh(Request())
                except RefreshError as exc:
                    raise AuthRequiredError(
                        "The Google authorization expired or was revoked; please reconnect"
                    ) from exc
                self.secrets.set(token_key, creds.to_json())
            else:
                raise AuthRequiredError("The Google authorization expired; please reconnect")
        return creds

    def disconnect(self, service: str, *, revoke: bool = True) -> None:
        self.forget(SERVICES[service][1], revoke=revoke)

    def forget(self, token_key: str, *, revoke: bool = True) -> None:
        """Delete a stored Google sign-in and, by default, ask Google to revoke it as well (best effort)."""
        raw = self.secrets.get(token_key)
        self.secrets.delete(token_key)
        if raw and revoke:
            try:
                import requests

                token = json.loads(raw).get("refresh_token") or json.loads(raw).get("token")
                if token:
                    requests.post("https://oauth2.googleapis.com/revoke", data={"token": token}, timeout=10)
            except Exception:  # best effort - the local token is deleted either way
                log.info("Token revocation request failed (token deleted locally)")
