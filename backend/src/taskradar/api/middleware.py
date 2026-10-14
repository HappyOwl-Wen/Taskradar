"""Security middleware (pure ASGI).

* Host header allow-list -> defeats DNS-rebinding attacks against the local server.
* CSRF protection for every state-changing request under /api: a per-process random token must be
  sent in the ``X-TaskRadar-CSRF`` header (another web page can neither read the token nor send
  custom headers cross-origin without a CORS preflight, which is never granted). ``Origin`` and
  ``Sec-Fetch-Site`` are checked as defence in depth.
* Strict security headers / CSP on every response.
"""

from __future__ import annotations

import hmac
import json
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

CSRF_HEADER = b"x-taskradar-csrf"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'self'; frame-ancestors 'self'; "
    "base-uri 'self'; form-action 'self'"
)


async def _reject(send: Send, status: int, code: str, message: str) -> None:
    body = json.dumps({"error": {"code": code, "message": message, "recoverable": False, "details": {}}}).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


class SecurityMiddleware:
    def __init__(self, app: ASGIApp, *, allowed_hosts: set[str], allowed_origins: set[str], csrf_token: str) -> None:
        self.app = app
        self.allowed_hosts = {h.lower() for h in allowed_hosts}
        self.allowed_origins = {o.lower().rstrip("/") for o in allowed_origins}
        self.csrf_token = csrf_token.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        host = headers.get(b"host", b"").decode("latin-1").lower()
        if host not in self.allowed_hosts:
            await _reject(send, 421, "invalid_host", "Requests must be addressed to the local TaskRadar host")
            return

        method = scope.get("method", "GET").upper()
        path: str = scope.get("path", "")
        if method not in SAFE_METHODS and path.startswith("/api/"):
            origin = headers.get(b"origin", b"").decode("latin-1").lower().rstrip("/")
            if origin and origin not in self.allowed_origins:
                await _reject(send, 403, "cross_origin_rejected", "Cross-origin requests are not allowed")
                return
            fetch_site = headers.get(b"sec-fetch-site", b"").decode("latin-1").lower()
            if fetch_site and fetch_site not in ("same-origin", "none"):
                await _reject(send, 403, "cross_site_rejected", "Cross-site requests are not allowed")
                return
            token = headers.get(CSRF_HEADER, b"")
            if not token or not hmac.compare_digest(token, self.csrf_token):
                await _reject(send, 403, "csrf_failed", "Missing or invalid CSRF token; reload the page")
                return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                extra = [
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"x-frame-options", b"SAMEORIGIN"),
                    (b"cross-origin-opener-policy", b"same-origin"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                ]
                existing = {k.lower() for k, _ in message.get("headers", [])}
                if b"content-security-policy" not in existing:
                    extra.append((b"content-security-policy", CSP.encode()))
                if path.startswith("/api/") and b"cache-control" not in existing:
                    extra.append((b"cache-control", b"no-store"))
                message["headers"] = list(message.get("headers", [])) + extra
            await send(message)

        await self.app(scope, receive, send_with_headers)
