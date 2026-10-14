"""Central permission checks for every action with an external or system side effect.

Each check is evaluated independently of the caller (the API, the scheduler or the agent) and is
written to ``audit_log`` - allowed or not - so it is always traceable who could do what.
"""

from __future__ import annotations

import logging
import os
from enum import StrEnum
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from taskradar.db.models import AuditLog, Source
from taskradar.db.session import transaction
from taskradar.security import secrets as sk
from taskradar.security.secrets import SecretStore, SecretStoreError
from taskradar.services.settings import SettingsService

log = logging.getLogger(__name__)


class SideEffect(StrEnum):
    LLM_SEND = "llm.send"
    GMAIL_READ = "gmail.read"
    CALENDAR_WRITE = "calendar.write"
    AUTOSTART_MODIFY = "autostart.modify"
    DESKTOP_NOTIFY = "desktop.notify"
    FILE_REVEAL = "file.reveal"
    FOLDER_WATCH = "folder.watch"
    OAUTH_CONNECT = "oauth.connect"
    OAUTH_REVOKE = "oauth.revoke"
    DATA_EXPORT = "data.export"
    DATA_DELETE_ALL = "data.delete_all"


class PermissionDenied(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


_FORBIDDEN_FOLDER_ROOTS = [
    os.environ.get("SystemRoot", r"C:\Windows"),
    os.environ.get("ProgramFiles", r"C:\Program Files"),
    os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
    os.environ.get("ProgramData", r"C:\ProgramData"),
    "/bin", "/sbin", "/usr", "/etc", "/proc", "/sys", "/dev", "/var",
]


def validate_watch_folder(raw: str, *, app_data_dir: Path) -> Path:
    """Only explicit, ordinary user folders can be watched - never a drive root or system folder."""
    if not raw or not raw.strip():
        raise PermissionDenied("folder_invalid", "Please provide a folder path")
    path = Path(raw.strip().strip('"'))
    if not path.is_absolute():
        raise PermissionDenied("folder_not_absolute", "The folder path must be absolute")
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PermissionDenied("folder_not_found", "The folder does not exist") from exc
    if not resolved.is_dir():
        raise PermissionDenied("folder_not_directory", "The path is not a folder")
    if resolved.parent == resolved or len(resolved.parts) <= 1:
        raise PermissionDenied("folder_is_drive_root", "Watching a whole drive is not allowed")
    if resolved == Path.home().resolve():
        raise PermissionDenied("folder_is_home", "Watching the whole user profile is not allowed; choose a sub-folder")
    for root in _FORBIDDEN_FOLDER_ROOTS:
        try:
            if resolved.is_relative_to(Path(root).resolve()):
                raise PermissionDenied("folder_is_system", "System folders cannot be watched")
        except (OSError, ValueError):
            continue
    if resolved.is_relative_to(app_data_dir.resolve()):
        raise PermissionDenied("folder_is_app_data", "TaskRadar's own data folder cannot be watched")
    return resolved


class PermissionGuard:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        settings: SettingsService,
        secrets: SecretStore,
        *,
        app_data_dir: Path,
    ) -> None:
        self._factory = session_factory
        self._settings = settings
        self._secrets = secrets
        self._app_data_dir = app_data_dir

    # -----------------------------------------------------------------------------------------

    def check(
        self, action: SideEffect, *, target: str | None = None, session: Session | None = None, **context: Any
    ) -> None:
        """Raise :class:`PermissionDenied` unless allowed. Always audited.

        Pass ``session`` when called inside an open write transaction: SQLite serialises writers, so
        the audit row must be written through the same connection.
        """
        try:
            allowed, code, reason = self._evaluate(action, target, context)
        except PermissionDenied as exc:
            allowed, code, reason = False, exc.code, exc.message
        self._audit(action, allowed, code if not allowed else "allowed", reason, target, context, session)
        if not allowed:
            raise PermissionDenied(code, reason)

    def is_allowed(self, action: SideEffect, *, target: str | None = None, **context: Any) -> bool:
        try:
            allowed, _, _ = self._evaluate(action, target, context)
            return allowed
        except PermissionDenied:
            return False

    # -----------------------------------------------------------------------------------------

    def _secret(self, key: str) -> str | None:
        try:
            return self._secrets.get(key)
        except SecretStoreError:
            return None

    def llm_api_key(self) -> str | None:
        return self._secret(sk.OPENAI_API_KEY) or os.environ.get("OPENAI_API_KEY") or None

    def _evaluate(self, action: SideEffect, target: str | None, ctx: dict[str, Any]) -> tuple[bool, str, str]:
        settings = self._settings.get()
        if action == SideEffect.LLM_SEND:
            llm = settings.llm
            if llm.provider == "none":
                return False, "llm_disabled", "No model provider is configured"
            is_local = bool(llm.base_url) and any(h in (llm.base_url or "") for h in ("127.0.0.1", "localhost", "[::1]"))
            if not is_local and not llm.cloud_consent:
                return False, "cloud_consent_missing", "Sending content to a cloud model requires explicit consent"
            if llm.provider == "openai" and not self.llm_api_key():
                return False, "api_key_missing", "No API key is configured"
            return True, "allowed", "provider configured and consent given"
        if action == SideEffect.GMAIL_READ:
            if ctx.get("demo"):
                return True, "allowed", "synthetic demo mailbox"
            if not self._secret(sk.GOOGLE_TOKEN_GMAIL):
                return False, "gmail_not_connected", "Gmail is not connected"
            return True, "allowed", "read-only Gmail scope granted by the user"
        if action == SideEffect.CALENDAR_WRITE:
            if not self._secret(sk.GOOGLE_TOKEN_CALENDAR):
                return False, "calendar_not_connected", "Google Calendar is not connected"
            if not ctx.get("user_confirmed") and not (ctx.get("auto_rule") and settings.calendar.auto_sync_enabled):
                return False, "confirmation_required", "Writing to the calendar requires explicit confirmation"
            if ctx.get("task_status") not in ("confirmed", "in_progress", "waiting_for_reply"):
                return False, "task_not_confirmed", "Only confirmed tasks can be added to the calendar"
            if not ctx.get("has_due"):
                return False, "task_without_date", "The task has no date to put in the calendar"
            return True, "allowed", "user-confirmed calendar write"
        if action == SideEffect.AUTOSTART_MODIFY:
            if ctx.get("confirmed") is not True:
                return False, "confirmation_required", "Changing Windows autostart requires explicit confirmation"
            return True, "allowed", "user confirmed"
        if action == SideEffect.DESKTOP_NOTIFY:
            if not settings.notifications.desktop_enabled:
                return False, "desktop_notifications_disabled", "Desktop notifications are disabled"
            return True, "allowed", "enabled in settings"
        if action == SideEffect.FILE_REVEAL:
            return self._evaluate_file_access(target)
        if action == SideEffect.FOLDER_WATCH:
            validate_watch_folder(target or "", app_data_dir=self._app_data_dir)
            return True, "allowed", "explicit user folder"
        if action == SideEffect.DATA_DELETE_ALL:
            if ctx.get("confirm_phrase") != "DELETE":
                return False, "confirmation_required", "Type DELETE to confirm"
            return True, "allowed", "user confirmed"
        if action in (SideEffect.OAUTH_CONNECT, SideEffect.OAUTH_REVOKE, SideEffect.DATA_EXPORT):
            return True, "allowed", "user initiated"
        return False, "unknown_action", f"Unknown action {action}"

    def _evaluate_file_access(self, target: str | None) -> tuple[bool, str, str]:
        if not target:
            return False, "file_missing", "No file"
        try:
            path = Path(target).resolve(strict=True)
        except (OSError, RuntimeError):
            return False, "file_missing", "The file no longer exists"
        roots = [self._app_data_dir.resolve()]
        with transaction(self._factory) as session:
            roots.extend(Path(p).resolve() for (p,) in session.query(Source.folder_path).filter(Source.folder_path.isnot(None)))
        if any(path.is_relative_to(root) for root in roots):
            return True, "allowed", "file inside TaskRadar storage or a watched folder"
        return False, "file_outside_allowed_roots", "The file is outside the folders TaskRadar may access"

    def _audit(self, action: SideEffect, allowed: bool, code: str, reason: str, target: str | None,
               context: dict[str, Any], session: Session | None = None) -> None:
        safe_details = {k: v for k, v in context.items() if isinstance(v, (bool, int, float)) or k in ("task_id", "kind")}
        entry = AuditLog(
            action=action.value,
            allowed=allowed,
            reason=f"{code}: {reason}",
            target=(target or "")[:500] or None,
            details=safe_details,
        )
        if session is not None:
            session.add(entry)
            return
        try:
            with transaction(self._factory) as own:
                own.add(entry)
        except Exception:  # pragma: no cover - auditing must never mask the decision
            log.exception("Failed to write audit log entry")
