"""Composition root: builds every service from configuration (with test overrides)."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from taskradar.config import AppConfig
from taskradar.connectors.calendar import CalendarClient, GoogleCalendarClient
from taskradar.connectors.google_oauth import GoogleOAuthManager
from taskradar.db.base import utcnow
from taskradar.db.migrate import upgrade_to_head
from taskradar.db.session import create_sqlite_engine, make_session_factory
from taskradar.notify import windows as windows_notifications
from taskradar.security.permissions import PermissionGuard
from taskradar.security.secrets import KeyringSecretStore, SecretStore
from taskradar.services.calendar_sync import CalendarSyncService
from taskradar.services.data import DataService
from taskradar.services.jobs import JobRunner
from taskradar.services.notifications import NotificationService
from taskradar.services.settings import SettingsService
from taskradar.services.status_summary import StatusSummaryService
from taskradar.services.tasks import TaskService
from taskradar.services.timers import TimerService


@dataclass
class Container:
    config: AppConfig
    engine: Engine
    factory: sessionmaker[Session]
    clock: Callable[[], dt.datetime]
    secrets: SecretStore
    settings: SettingsService
    guard: PermissionGuard
    tasks: TaskService
    jobs: JobRunner
    oauth: GoogleOAuthManager
    calendar: CalendarSyncService
    notifications: NotificationService
    data: DataService
    status: StatusSummaryService
    timers: TimerService
    extras: dict[str, Any] = field(default_factory=dict)

    def dispose(self) -> None:
        self.engine.dispose()


def build_container(
    config: AppConfig,
    *,
    secrets: SecretStore | None = None,
    clock: Callable[[], dt.datetime] | None = None,
    calendar_client_factory: Callable[[], CalendarClient] | None = None,
    toast: Callable[[str, str], bool] | None = None,
    run_migrations: bool = True,
) -> Container:
    config.ensure_dirs()
    clock = clock or utcnow
    engine = create_sqlite_engine(config.database_url)
    if run_migrations:
        upgrade_to_head(engine)
    factory = make_session_factory(engine)
    secrets = secrets or KeyringSecretStore()
    settings = SettingsService(factory)
    guard = PermissionGuard(factory, settings, secrets)
    tasks = TaskService(clock)
    jobs = JobRunner(factory, clock)
    oauth = GoogleOAuthManager(secrets, redirect_uri=f"{config.base_url}/api/oauth/google/callback", clock=clock)

    def default_calendar_factory() -> CalendarClient:
        return GoogleCalendarClient(oauth.credentials("calendar"))

    calendar = CalendarSyncService(
        factory,
        settings=settings,
        guard=guard,
        tasks=tasks,
        client_factory=calendar_client_factory or default_calendar_factory,
        connected=lambda: oauth.connected("calendar"),
        base_url=config.base_url,
        clock=clock,
    )
    toast = toast or windows_notifications.show
    notifications = NotificationService(factory, settings=settings, guard=guard, jobs=jobs, clock=clock, toast=toast)
    return Container(
        config=config,
        engine=engine,
        factory=factory,
        clock=clock,
        secrets=secrets,
        settings=settings,
        guard=guard,
        tasks=tasks,
        jobs=jobs,
        oauth=oauth,
        calendar=calendar,
        notifications=notifications,
        data=DataService(factory, config=config, clock=clock),
        status=StatusSummaryService(factory, calendar_connected=lambda: oauth.connected("calendar"), clock=clock),
        timers=TimerService(factory, settings=settings, guard=guard, toast=toast, clock=clock),
    )
