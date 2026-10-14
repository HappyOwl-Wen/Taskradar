"""FastAPI dependency helpers."""

from __future__ import annotations

from fastapi import Request

from taskradar.container import Container
from taskradar.deadlines.engine import Thresholds


def get_container(request: Request) -> Container:
    return request.app.state.container  # type: ignore[no-any-return]


def thresholds_for(container: Container) -> Thresholds:
    reminders = container.settings.get().reminders
    return Thresholds(reminders.urgent_hours, reminders.high_days, reminders.upcoming_days)
