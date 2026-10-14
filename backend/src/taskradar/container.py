"""Composition root: builds every service from configuration (with test overrides)."""

from __future__ import annotations

import datetime as dt
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

from taskradar.config import AppConfig
from taskradar.connectors.calendar import CalendarClient, GoogleCalendarClient
from taskradar.connectors.fake_gmail import FakeGmailClient
from taskradar.connectors.gmail import GmailClient, GoogleGmailClient
from taskradar.connectors.google_oauth import GoogleOAuthManager
from taskradar.db.base import utcnow
from taskradar.db.migrate import upgrade_to_head
from taskradar.db.models import Source, SyncCheckpoint
from taskradar.db.session import create_sqlite_engine, make_session_factory, transaction
from taskradar.demo.mailbox import build_demo_mailbox, demo_completion_message
from taskradar.domain.enums import SourceKind
from taskradar.llm.base import LLMProvider
from taskradar.notify.desktop import show_toast
from taskradar.parsing.ocr import OCREngine, TesseractEngine
from taskradar.security.permissions import PermissionGuard
from taskradar.security.secrets import KeyringSecretStore, SecretStore
from taskradar.services.agent import AgentFactory
from taskradar.services.calendar_sync import CalendarSyncService
from taskradar.services.data import DataService
from taskradar.services.documents import DocumentService
from taskradar.services.folders import FolderService
from taskradar.services.gmail_sync import GmailSyncService
from taskradar.services.ingest import IngestService
from taskradar.services.jobs import JobRunner
from taskradar.services.metrics import MetricsService
from taskradar.services.notifications import NotificationService
from taskradar.services.settings import SettingsService
from taskradar.services.tasks import TaskService

DEMO_ACCOUNT = "demo@taskradar.example"


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
    agent: AgentFactory
    ingest: IngestService
    ocr: OCREngine
    documents: DocumentService
    folders: FolderService
    jobs: JobRunner
    oauth: GoogleOAuthManager
    gmail: GmailSyncService
    calendar: CalendarSyncService
    notifications: NotificationService
    data: DataService
    metrics: MetricsService
    extras: dict[str, Any] = field(default_factory=dict)

    def dispose(self) -> None:
        self.engine.dispose()


def build_container(
    config: AppConfig,
    *,
    secrets: SecretStore | None = None,
    clock: Callable[[], dt.datetime] | None = None,
    llm_provider: LLMProvider | None = None,
    gmail_client_factory: Callable[[Source], GmailClient] | None = None,
    calendar_client_factory: Callable[[], CalendarClient] | None = None,
    ocr: OCREngine | None = None,
    toast: Callable[[str, str], bool] | None = None,
    sleep: Callable[[float], None] | None = None,
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
    guard = PermissionGuard(factory, settings, secrets, app_data_dir=config.data_dir)
    tasks = TaskService(clock)
    agent = AgentFactory(settings, guard, provider_override=llm_provider)
    ingest = IngestService(factory, settings=settings, agent=agent, tasks=tasks, clock=clock)
    ocr_engine = ocr or TesseractEngine(config.tesseract_cmd, tools_dir=config.tools_dir)
    documents = DocumentService(
        factory, config=config, settings=settings, ingest=ingest, tasks=tasks, ocr=ocr_engine, clock=clock
    )
    jobs = JobRunner(factory, clock)
    folders = FolderService(factory, settings=settings, documents=documents, guard=guard, jobs=jobs, clock=clock)
    oauth = GoogleOAuthManager(secrets, redirect_uri=f"{config.base_url}/api/oauth/google/callback", clock=clock)

    def default_gmail_factory(source: Source) -> GmailClient:
        if source.kind == SourceKind.DEMO_MAIL.value:
            messages, attachments = build_demo_mailbox(clock())
            client = FakeGmailClient(
                messages,
                attachments=attachments,
                clock=clock,
                email=DEMO_ACCOUNT,
                failure_mode=settings.get().demo.gmail_failure_mode,
            )
            with transaction(factory) as session:
                stage = session.scalar(
                    select(SyncCheckpoint.value).where(
                        SyncCheckpoint.source_id == source.id, SyncCheckpoint.key == "demo_stage"
                    )
                )
            if stage and int(stage) >= 2:
                client.add_message(demo_completion_message(clock()))
            return client
        return GoogleGmailClient(oauth.credentials("gmail"))

    def default_calendar_factory() -> CalendarClient:
        return GoogleCalendarClient(oauth.credentials("calendar"))

    gmail = GmailSyncService(
        factory,
        settings=settings,
        documents=documents,
        jobs=jobs,
        guard=guard,
        client_factory=gmail_client_factory or default_gmail_factory,
        clock=clock,
        sleep=sleep or time.sleep,
    )
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
    notifications = NotificationService(
        factory, settings=settings, guard=guard, jobs=jobs, clock=clock, toast=toast or show_toast
    )
    return Container(
        config=config,
        engine=engine,
        factory=factory,
        clock=clock,
        secrets=secrets,
        settings=settings,
        guard=guard,
        tasks=tasks,
        agent=agent,
        ingest=ingest,
        ocr=ocr_engine,
        documents=documents,
        folders=folders,
        jobs=jobs,
        oauth=oauth,
        gmail=gmail,
        calendar=calendar,
        notifications=notifications,
        data=DataService(factory, config=config, clock=clock),
        metrics=MetricsService(factory),
    )
