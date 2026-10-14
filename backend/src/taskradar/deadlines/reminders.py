"""Reminder planning with deduplication and throttling keys.

A notification is identified by a deterministic ``dedupe_key``; the database enforces uniqueness,
so re-running a scan (or running it concurrently) never produces duplicate reminders.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from taskradar.deadlines.engine import DeadlineStatus
from taskradar.domain.enums import NotificationLevel, TaskStatus, Urgency

_NOTIFY_LEVELS = {
    Urgency.OVERDUE: NotificationLevel.OVERDUE,
    Urgency.URGENT: NotificationLevel.URGENT,
    Urgency.HIGH: NotificationLevel.HIGH,
    Urgency.UPCOMING: NotificationLevel.UPCOMING,
}

MESSAGES = {
    "zh-CN": {
        NotificationLevel.OVERDUE: "已逾期：{title}",
        NotificationLevel.URGENT: "24 小时内截止：{title}",
        NotificationLevel.HIGH: "3 天内截止：{title}",
        NotificationLevel.UPCOMING: "7 天内截止：{title}",
        "candidate": "（待确认）",
        "due": "截止：{due}",
    },
    "en": {
        NotificationLevel.OVERDUE: "Overdue: {title}",
        NotificationLevel.URGENT: "Due within 24 hours: {title}",
        NotificationLevel.HIGH: "Due within 3 days: {title}",
        NotificationLevel.UPCOMING: "Due within 7 days: {title}",
        "candidate": " (unconfirmed)",
        "due": "Due: {due}",
    },
}


@dataclass(frozen=True)
class ReminderSettings:
    notify_candidates: bool = False
    overdue_repeat_hours: int = 24
    notify_upcoming: bool = True


@dataclass(frozen=True)
class ReminderDecision:
    level: NotificationLevel
    dedupe_key: str
    title: str
    body: str


def plan_reminder(
    *,
    task_id: str,
    title: str,
    status: str,
    due_version: int,
    due_label: str,
    deadline: DeadlineStatus,
    now: dt.datetime,
    settings: ReminderSettings,
    language: str = "zh-CN",
) -> ReminderDecision | None:
    level = _NOTIFY_LEVELS.get(deadline.urgency)
    if level is None:
        return None
    if level == NotificationLevel.UPCOMING and not settings.notify_upcoming:
        return None
    is_candidate = status == TaskStatus.CANDIDATE.value
    if is_candidate and not settings.notify_candidates and level not in (NotificationLevel.OVERDUE, NotificationLevel.URGENT):
        # Unconfirmed tasks never cause frequent notifications.
        return None
    if is_candidate:
        key = f"{task_id}:v{due_version}:{level.value}:candidate"
    elif level == NotificationLevel.OVERDUE and deadline.effective_deadline is not None:
        overdue_hours = (now - deadline.effective_deadline).total_seconds() / 3600
        bucket = int(overdue_hours // max(1, settings.overdue_repeat_hours))
        key = f"{task_id}:v{due_version}:overdue:{bucket}"
    else:
        key = f"{task_id}:v{due_version}:{level.value}"
    texts = MESSAGES.get(language, MESSAGES["en"])
    suffix = texts["candidate"] if is_candidate else ""
    return ReminderDecision(
        level=level,
        dedupe_key=key,
        title=(texts[level].format(title=title) + suffix)[:300],
        body=texts["due"].format(due=due_label),
    )
