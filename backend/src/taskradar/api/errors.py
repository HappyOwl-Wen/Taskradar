"""Uniform error envelope: {"error": {"code", "message", "recoverable", "details"}}."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from taskradar.connectors.errors import ConnectorError
from taskradar.connectors.google_oauth import OAuthError
from taskradar.security.permissions import PermissionDenied
from taskradar.security.redact import redact_secrets
from taskradar.security.secrets import SecretStoreError
from taskradar.services.calendar_sync import CalendarSyncError
from taskradar.services.jobs import JobAlreadyRunning
from taskradar.services.settings import SettingsError
from taskradar.services.tasks import TaskError

log = logging.getLogger(__name__)


class ApiError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400, *, recoverable: bool = True,
                 details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.recoverable = recoverable
        self.details = details or {}


def error_response(code: str, message: str, status_code: int, *, recoverable: bool = True,
                   details: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": redact_secrets(message), "recoverable": recoverable,
                           "details": details or {}}},
    )


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.code, exc.message, exc.status_code, recoverable=exc.recoverable, details=exc.details)

    @app.exception_handler(TaskError)
    async def _task_error(_: Request, exc: TaskError) -> JSONResponse:
        return error_response(exc.code, str(exc), exc.status_code)

    @app.exception_handler(PermissionDenied)
    async def _denied(_: Request, exc: PermissionDenied) -> JSONResponse:
        return error_response(exc.code, exc.message, 403)

    @app.exception_handler(CalendarSyncError)
    async def _calendar(_: Request, exc: CalendarSyncError) -> JSONResponse:
        return error_response(exc.code, exc.message, exc.status_code)

    @app.exception_handler(OAuthError)
    async def _oauth(_: Request, exc: OAuthError) -> JSONResponse:
        return error_response(exc.code, exc.message, 400)

    @app.exception_handler(ConnectorError)
    async def _connector(_: Request, exc: ConnectorError) -> JSONResponse:
        return error_response(exc.code, str(exc), 502, recoverable=exc.recoverable)

    @app.exception_handler(JobAlreadyRunning)
    async def _running(_: Request, exc: JobAlreadyRunning) -> JSONResponse:
        return error_response(exc.code, "This sync is already running", 409)

    @app.exception_handler(SettingsError)
    async def _settings(_: Request, exc: SettingsError) -> JSONResponse:
        return error_response(exc.code, str(exc), 422)

    @app.exception_handler(SecretStoreError)
    async def _secrets(_: Request, exc: SecretStoreError) -> JSONResponse:
        return error_response(exc.code, str(exc), 503, recoverable=False)

    @app.exception_handler(LookupError)
    async def _lookup(_: Request, exc: LookupError) -> JSONResponse:
        return error_response("not_found", str(exc) or "Not found", 404)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"loc": [str(p) for p in e.get("loc", ())], "msg": str(e.get("msg", ""))} for e in exc.errors()[:10]
        ]
        return error_response("validation_error", "The request is invalid", 422, details={"errors": errors})

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled API error")
        return error_response("internal_error", "An unexpected error occurred. Details were written to the log.", 500)
