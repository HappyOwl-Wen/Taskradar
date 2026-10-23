"""Launch the real app with synthetic tasks, memory credentials and Fake Calendar only.

Usage: backend/.venv/Scripts/python.exe scripts/calendar-check/launch.py [--desktop]
Data: build/calendar-check/data. No access to the user's database or Credential Manager.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path

import taskradar.container as composition
from sqlalchemy import select
from taskradar.config import AppConfig
from taskradar.connectors.calendar import FakeCalendarClient
from taskradar.connectors.google_oauth import ACCESS_SCOPES
from taskradar.db.models import Setting, Task
from taskradar.db.session import transaction
from taskradar.domain.calendar import EventForm
from taskradar.domain.schemas import DueInfo
from taskradar.security import secrets as sk
from taskradar.security.secrets import MemorySecretStore

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "build" / "calendar-check" / "data"
arguments = argparse.ArgumentParser()
arguments.add_argument("--desktop", action="store_true")
arguments.add_argument("--local", action="store_true")
arguments.add_argument("--port", type=int, default=8134)
arguments.add_argument("--data-dir", type=Path, default=DATA)
args = arguments.parse_args()
DATA = args.data_dir.resolve()
if not DATA.is_relative_to(ROOT / "build" / "calendar-check"):
    raise SystemExit("Use a scratch folder inside build/calendar-check")
PORT = args.port
fake = FakeCalendarClient()
fake.calendars = {
    "personal@example.test": {
        "summary": "个人 · Personal",
        "primary": True,
        "timeZone": "Europe/Berlin",
        "accessRole": "owner",
        "backgroundColor": "#4285f4",
    },
    "radar@example.test": {
        "summary": "TaskRadar",
        "timeZone": "Europe/Berlin",
        "accessRole": "owner",
        "backgroundColor": "#4f46e5",
    },
    "team@example.test": {
        "summary": "团队 · Team",
        "timeZone": "Europe/Berlin",
        "accessRole": "reader",
        "backgroundColor": "#0d9488",
    },
}


def insert(id, title, start, end, calendar="personal@example.test", **extra):
    fake.insert_event(calendar, {"id": id, "summary": title, "start": start, "end": end, **extra})


insert(
    "review",
    "产品方案评审 · Design review",
    {"dateTime": "2026-10-22T10:00:00+02:00"},
    {"dateTime": "2026-10-22T11:00:00+02:00"},
    location="Room 204",
    description="Synthetic event for UI verification. No real attendees.",
)
insert(
    "reading",
    "阅读论文 · Reading",
    {"dateTime": "2026-10-22T10:30:00+02:00"},
    {"dateTime": "2026-10-22T12:00:00+02:00"},
)
insert("trip", "柏林出差 · Berlin visit", {"date": "2026-10-26"}, {"date": "2026-10-29"})
insert(
    "dst",
    "夏令时边界 · DST transition",
    {"dateTime": "2026-10-25T01:30:00+02:00"},
    {"dateTime": "2026-10-25T03:30:00+01:00"},
)
insert(
    "night",
    "跨日实验 · Overnight experiment",
    {"dateTime": "2026-10-23T23:00:00+02:00"},
    {"dateTime": "2026-10-24T02:00:00+02:00"},
)
insert(
    "invite",
    "团队周会 · Weekly team meeting",
    {"dateTime": "2026-10-23T14:00:00+02:00"},
    {"dateTime": "2026-10-23T15:00:00+02:00"},
    calendar="team@example.test",
    recurringEventId="weekly",
    attendees=[{"email": "synthetic@example.test"}],
)
insert(
    "exception",
    "团队周会（调整）· Exception",
    {"dateTime": "2026-10-30T15:00:00+01:00"},
    {"dateTime": "2026-10-30T16:00:00+01:00"},
    calendar="team@example.test",
    recurringEventId="weekly",
    originalStartTime={"dateTime": "2026-10-30T14:00:00+01:00"},
)
insert(
    "birthday",
    "生日 · Birthday",
    {"date": "2026-10-24"},
    {"date": "2026-10-25"},
    calendar="team@example.test",
    eventType="birthday",
)
original = composition.build_container


def build(config, **kwargs):
    secrets = MemorySecretStore()
    if not args.local:
        secrets.set(sk.GOOGLE_TOKEN_CALENDAR, json.dumps({"token": "fake", "scopes": ACCESS_SCOPES["edit"]}))
    c = original(config, secrets=secrets, calendar_client_factory=lambda: fake, toast=lambda *_: True)
    c.settings.update(
        {
            "general": {"language": "zh-CN", "theme": "light"},
            "calendar": {"google_edit_enabled": True},
            "timers": {"notify": False},
        }
    )
    with transaction(c.factory) as session:
        if not session.get(Setting, "calendar_state"):
            session.add(Setting(key="calendar_state", value={"calendar_id": "radar@example.test"}))
        if session.scalar(select(Task)) is None:
            task = c.tasks.create(
                session,
                title="提交研究计划 · Research proposal",
                due=DueInfo(date=dt.date(2026, 10, 23)),
                timezone="Europe/Berlin",
            )
            task_id = task.id
            c.tasks.create(session, title="整理实验记录 · Organize lab notes", due=DueInfo(), timezone="Europe/Berlin")
            c.tasks.create(
                session, title="准备下周汇报 · Prepare presentation", due=DueInfo(), timezone="Europe/Berlin"
            )
        else:
            task_id = session.scalar(select(Task.id).where(Task.due_date.isnot(None)))
    if task_id and not args.local:
        c.calendar.sync(task_id, user_confirmed=True)
        if not c.workspace.task_blocks(task_id):
            c.workspace.save_block(
                task_id,
                EventForm(title="研究计划写作 · Proposal writing", start="2026-10-22T14:00", end="2026-10-22T15:30"),
            )
    c.workspace.refresh(dt.date(2026, 10, 1), dt.date(2026, 11, 1))
    if not args.local:
        c.workspace.select_sources(list(fake.calendars), "personal@example.test", True)
    return c


composition.build_container = build
config = AppConfig(data_dir=DATA, port=PORT, open_browser=False, scheduler_enabled=False)
if args.desktop:
    os.environ["TASKRADAR_WEBVIEW_DEBUG_PORT"] = "9234"
    from taskradar.desktop.shell import run

    raise SystemExit(run(config))
else:
    import uvicorn
    from taskradar.api.app import create_app

    uvicorn.run(create_app(build(config)), host="127.0.0.1", port=PORT)
