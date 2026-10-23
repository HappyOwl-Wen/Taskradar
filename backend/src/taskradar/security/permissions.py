"""Central permission checks for every action with an external or system side effect.

Each check is evaluated independently of the caller (the API or the scheduler) and is
written to ``audit_log`` - allowed or not - so it is always traceable who could do what.
"""

from __future__ import annotations

import json
import logging
from enum import StrEnum
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from taskradar.db.models import AuditLog
from taskradar.db.session import transaction
from taskradar.security import secrets as sk
from taskradar.security.secrets import SecretStore, SecretStoreError
from taskradar.services.settings import SettingsService

log = logging.getLogger(__name__)


class SideEffect(StrEnum):
    GOOGLE_EVENT_WRITE = "calendar.event_write"
    GOOGLE_EVENT_DELETE = "calendar.event_delete"
    CALENDAR_WRITE = "calendar.write"
    CALENDAR_DELETE = "calendar.delete"
    AUTOSTART_MODIFY = "autostart.modify"
    START_MENU_MODIFY = "start_menu.modify"
    DESKTOP_NOTIFY = "desktop.notify"
    TIMER_NOTIFY = "timer.notify"
    TIMER_ALARM = "timer.alarm"
    OAUTH_CONNECT = "oauth.connect"
    OAUTH_REVOKE = "oauth.revoke"
    CREDENTIAL_DELETE = "credential.delete"
    DATA_EXPORT = "data.export"
    DATA_DELETE_ALL = "data.delete_all"


class PermissionDenied(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class PermissionGuard:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        settings: SettingsService,
        secrets: SecretStore,
    ) -> None:
        self._factory = session_factory
        self._settings = settings
        self._secrets = secrets

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

    def _evaluate(self, action: SideEffect, target: str | None, ctx: dict[str, Any]) -> tuple[bool, str, str]:
        settings = self._settings.get()
        if action in (SideEffect.CALENDAR_WRITE, SideEffect.CALENDAR_DELETE):
            raw = self._secret(sk.GOOGLE_TOKEN_CALENDAR)
            try:
                token = json.loads(raw or "{}")
                scopes = token.get("scopes", [])
                if isinstance(scopes, str):
                    scopes = scopes.split()
                if "scopes" in token and not set(scopes) & {
                    "https://www.googleapis.com/auth/calendar.app.created",
                    "https://www.googleapis.com/auth/calendar.events",
                }:
                    return False, "calendar_scope_required", "The stored Google grant cannot write calendar events"
            except (ValueError, TypeError, AttributeError):
                return False, "calendar_not_connected", "The stored authorization is invalid"
        if action in (SideEffect.GOOGLE_EVENT_WRITE, SideEffect.GOOGLE_EVENT_DELETE):
            if not self._secret(sk.GOOGLE_TOKEN_CALENDAR):
                return False, "calendar_not_connected", "Google Calendar is not connected"
            if not ctx.get("user_confirmed"):
                return False, "confirmation_required", "Confirm the event and target calendar first"
            if not ctx.get("scope_allowed") or not ctx.get("app_allowed"):
                return False, "calendar_scope_required", "Enable the appropriate Google editing permission"
            if not ctx.get("selected"):
                return False, "calendar_not_selected", "This calendar is not selected in TaskRadar"
            if ctx.get("access_role") not in ("owner", "writer"):
                return False, "calendar_read_only", "This calendar is read-only"
            return True, "allowed", "confirmed event operation in a selected writable calendar"
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
        if action == SideEffect.CALENDAR_DELETE:
            if not self._secret(sk.GOOGLE_TOKEN_CALENDAR):
                return False, "calendar_not_connected", "Google Calendar is not connected"
            if not ctx.get("user_confirmed") and not (ctx.get("auto_rule") and settings.calendar.remove_on_dismiss):
                return False, "confirmation_required", "Removing a calendar event requires explicit confirmation"
            return True, "allowed", "removing an event TaskRadar created for this task"
        if action == SideEffect.AUTOSTART_MODIFY:
            if ctx.get("confirmed") is not True:
                return False, "confirmation_required", "Changing Windows autostart requires explicit confirmation"
            return True, "allowed", "user confirmed"
        if action == SideEffect.START_MENU_MODIFY:
            if ctx.get("confirmed") is not True:
                return False, "confirmation_required", "Changing the Start menu requires explicit confirmation"
            return True, "allowed", "user confirmed"
        if action == SideEffect.DESKTOP_NOTIFY:
            if not settings.notifications.desktop_enabled:
                return False, "desktop_notifications_disabled", "Desktop notifications are disabled"
            return True, "allowed", "enabled in settings"
        if action == SideEffect.TIMER_ALARM:
            if not settings.timers.alarm_sound:
                return False, "timer_alarm_disabled", "Pomodoro alarm sound is switched off"
            return True, "allowed", "Pomodoro alarm sound enabled"
        if action == SideEffect.TIMER_NOTIFY:
            if not settings.timers.notify:
                return False, "timer_notifications_disabled", "Notifications at the end of timers are switched off"
            return True, "allowed", "enabled in settings"
        if action == SideEffect.DATA_DELETE_ALL:
            if ctx.get("confirm_phrase") != "DELETE":
                return False, "confirmation_required", "Type DELETE to confirm"
            return True, "allowed", "user confirmed"
        if action in (
            SideEffect.OAUTH_CONNECT,
            SideEffect.OAUTH_REVOKE,
            SideEffect.CREDENTIAL_DELETE,
            SideEffect.DATA_EXPORT,
        ):
            return True, "allowed", "user initiated"
        return False, "unknown_action", f"Unknown action {action}"

    def _audit(
        self,
        action: SideEffect,
        allowed: bool,
        code: str,
        reason: str,
        target: str | None,
        context: dict[str, Any],
        session: Session | None = None,
    ) -> None:
        safe_details = {
            k: v for k, v in context.items() if isinstance(v, (bool, int, float)) or k in ("task_id", "kind")
        }
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
