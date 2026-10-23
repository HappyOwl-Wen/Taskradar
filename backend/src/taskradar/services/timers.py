"""Pomodoro timer and countdowns, run by the server.

A running timer has an end time in the database; the scheduler wakes up at that moment (and on start-up for timers
that were running), so a timer ends - and sends its Windows notification - on time while the window is hidden in
the tray. Reading the timers finishes due ones as well, so the state is right even without a scheduler.

The Pomodoro timer is one phase at a time (focus, short break, long break); each phase is a row of its own, so the
finished ones are the day's history. After ``long_break_every`` focus sessions the break is a long one. A focus
session can belong to a task: a to-do then moves to "in progress" when the session starts or resumes. Countdowns run
for a duration (they can be paused) or until a moment.
"""

from __future__ import annotations

import datetime as dt
import logging
import math
import threading
from collections.abc import Callable
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, joinedload, sessionmaker

from taskradar.db.base import utcnow
from taskradar.db.models import Notification, Task, Timer
from taskradar.db.session import transaction
from taskradar.domain.enums import Actor, TaskStatus
from taskradar.security.permissions import PermissionGuard, SideEffect
from taskradar.services.settings import SettingsService, TimerSettings
from taskradar.services.tasks import TaskService

log = logging.getLogger(__name__)

Phase = Literal["focus", "short_break", "long_break"]
PHASES: tuple[Phase, ...] = ("focus", "short_break", "long_break")
MAX_COUNTDOWN = dt.timedelta(days=7)
MAX_UNTIL = dt.timedelta(days=366)
# A finished phase older than this no longer decides what comes next: the next start is a new set.
SET_TIMEOUT = dt.timedelta(minutes=60)
# A timer that ended this long before TaskRadar noticed it ended while TaskRadar was not running.
LATE = dt.timedelta(minutes=2)

TEXTS = {
    "zh-CN": {
        "focus_done": "专注结束",
        "focus_done_body": "第 {cycle} 个番茄完成。休息 {minutes} 分钟吧。",
        "focus_done_auto": "第 {cycle} 个番茄完成，{minutes} 分钟的休息已经开始。",
        "break_done": "休息结束",
        "break_done_body": "准备好就开始第 {cycle} 个番茄。",
        "break_done_auto": "第 {cycle} 个番茄已经开始。",
        "countdown_done": "倒计时结束",
        "countdown_unnamed": "时间到了",
        "late": "（已于 {time} 结束）",
        "focus": "专注中",
        "short_break": "休息中",
        "long_break": "长休息中",
        "paused": "已暂停",
        "left": "剩 {minutes} 分钟",
        "countdowns": "{count} 个倒计时",
    },
    "en": {
        "focus_done": "Focus session done",
        "focus_done_body": "Pomodoro {cycle} done. Take a {minutes}-minute break.",
        "focus_done_auto": "Pomodoro {cycle} done; your {minutes}-minute break has started.",
        "break_done": "Break is over",
        "break_done_body": "Start Pomodoro {cycle} when you are ready.",
        "break_done_auto": "Pomodoro {cycle} has started.",
        "countdown_done": "Countdown finished",
        "countdown_unnamed": "Time is up",
        "late": " (ended at {time})",
        "focus": "Focusing",
        "short_break": "On a break",
        "long_break": "On a long break",
        "paused": "Paused",
        "left": "{minutes} min left",
        "countdowns": "{count} countdown(s)",
    },
}


class TimerError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _phase_seconds(cfg: TimerSettings, phase: Phase) -> int:
    minutes = {"focus": cfg.focus_minutes, "short_break": cfg.short_break_minutes, "long_break": cfg.long_break_minutes}
    return minutes[phase] * 60


def _iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


class TimerService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        settings: SettingsService,
        guard: PermissionGuard,
        tasks: TaskService,
        toast: Callable[[str, str], bool],
        clock: Callable[[], dt.datetime] = utcnow,
    ) -> None:
        self._factory = session_factory
        self.settings = settings
        self.guard = guard
        self.tasks = tasks
        self.toast = toast
        self.clock = clock
        # Set by the scheduler: wake up at a timer's end; and forget a timer that no longer ends then.
        self.on_schedule: Callable[[int, dt.datetime], None] | None = None
        self.on_unschedule: Callable[[int], None] | None = None
        self._listeners: list[Callable[[], None]] = []
        self._lock = threading.RLock()
        # One Pomodoro runs at a time. A newer completed phase replaces an older, unacknowledged alarm.
        self._alarm: dict[str, Any] | None = None

    def subscribe(self, listener: Callable[[], None]) -> None:
        """Call ``listener`` whenever a timer starts, stops or ends (the tray icon's tooltip follows them)."""
        self._listeners.append(listener)

    def _changed(self) -> None:
        for listener in list(self._listeners):
            try:
                listener()
            except Exception:
                log.exception("Timer listener failed")

    # ------------------------------------------------------------------------------------------
    # Reading
    # ------------------------------------------------------------------------------------------

    def alarm_state(self) -> dict[str, Any]:
        """A completion stays visible across page changes/reloads until explicitly acknowledged."""
        with self._lock:
            alarm = dict(self._alarm) if self._alarm is not None else None
        return {"alarm": alarm, "sound_enabled": self.settings.get().timers.alarm_sound}

    def dismiss_alarm(self, alarm_id: int) -> dict[str, Any]:
        with self._lock:
            # A delayed dismissal of the preceding phase must not silence a newer alarm.
            if self._alarm is not None and self._alarm["id"] == alarm_id:
                with transaction(self._factory) as session:
                    note = session.get(Notification, alarm_id)
                    if note is not None:
                        note.read_at = self.clock()
                self._alarm = None
        self._changed()
        return self.alarm_state()

    def overview(self) -> dict[str, Any]:
        """Everything the timer pages show; due timers are finished first."""
        self.finish_due()
        now = self.clock()
        cfg = self.settings.get()
        with transaction(self._factory) as session:
            current = self._current_pomodoro(session)
            last = None if current else self._last_pomodoro(session)
            if last is not None and (last.finished_at is None or now - last.finished_at >= SET_TIMEOUT):
                last = None
            nxt = None if current else self._next_phase(session, cfg.timers, now)
            countdowns = session.scalars(
                select(Timer)
                .where(Timer.kind == "countdown")
                .options(joinedload(Timer.task).load_only(Task.id, Task.title, Task.deleted_at))
                .order_by(Timer.created_at.desc())
            ).all()
            running = sorted(
                (c for c in countdowns if c.status in ("running", "paused")),
                key=lambda c: c.ends_at or (now + dt.timedelta(seconds=c.remaining_seconds or 0)),
            )
            done = [c for c in countdowns if c.status not in ("running", "paused")]
            done.sort(key=lambda c: c.finished_at or c.created_at, reverse=True)
            return {
                "now": now.isoformat(),
                "pomodoro": {
                    "current": self._view(current, now) if current else None,
                    # The phase that just ended (shown as "focus done, take a break" until the next one starts).
                    "last": self._view(last, now) if last else None,
                    "next": (
                        {"phase": nxt[0], "cycle": nxt[1], "duration_seconds": _phase_seconds(cfg.timers, nxt[0])}
                        if nxt
                        else None
                    ),
                    "long_break_every": cfg.timers.long_break_every,
                    "today": self._today(session, cfg.general.timezone, now),
                },
                "countdowns": [self._view(c, now) for c in running + done],
            }

    def _view(self, timer: Timer, now: dt.datetime) -> dict[str, Any]:
        if timer.status == "running" and timer.ends_at is not None:
            remaining = max(0, int((timer.ends_at - now).total_seconds() + 0.999))
        elif timer.status == "paused":
            remaining = timer.remaining_seconds or 0
        else:
            remaining = 0
        return {
            "id": timer.id,
            "kind": timer.kind,
            "phase": timer.phase,
            "mode": timer.mode,
            "label": timer.label,
            "task_id": timer.task_id if timer.task is not None and timer.task.deleted_at is None else None,
            "task_title": timer.task.title if timer.task is not None and timer.task.deleted_at is None else None,
            "cycle": timer.cycle,
            "status": timer.status,
            "duration_seconds": timer.duration_seconds,
            "remaining_seconds": remaining,
            "ends_at": _iso(timer.ends_at),
            "started_at": _iso(timer.started_at),
            "finished_at": _iso(timer.finished_at),
        }

    def _today(self, session: Session, tz: str, now: dt.datetime) -> dict[str, int]:
        midnight = dt.datetime.combine(now.astimezone(ZoneInfo(tz)).date(), dt.time(), tzinfo=ZoneInfo(tz))
        sessions, seconds = session.execute(
            select(func.count(), func.coalesce(func.sum(Timer.duration_seconds), 0)).where(
                Timer.kind == "pomodoro",
                Timer.phase == "focus",
                Timer.status == "finished",
                Timer.finished_at >= midnight.astimezone(dt.UTC),
            )
        ).one()
        return {"focus_sessions": sessions, "focus_minutes": seconds // 60}

    @staticmethod
    def _current_pomodoro(session: Session) -> Timer | None:
        return session.scalars(
            select(Timer)
            .where(Timer.kind == "pomodoro", Timer.status.in_(("running", "paused")))
            .order_by(Timer.id.desc())
            .limit(1)
        ).first()

    @staticmethod
    def _last_pomodoro(session: Session) -> Timer | None:
        return session.scalars(select(Timer).where(Timer.kind == "pomodoro").order_by(Timer.id.desc()).limit(1)).first()

    def _next_phase(self, session: Session, cfg: TimerSettings, now: dt.datetime) -> tuple[Phase, int]:
        """What the Pomodoro timer does next: after a focus session a break, after a break the next focus session."""
        last = self._last_pomodoro(session)
        if last is None or last.status == "cancelled" or last.finished_at is None:
            return "focus", 1
        if now - last.finished_at > SET_TIMEOUT:
            return "focus", 1
        if last.phase == "focus":
            return ("long_break" if last.cycle >= cfg.long_break_every else "short_break"), last.cycle
        if last.phase == "short_break":
            return "focus", last.cycle + 1
        return "focus", 1

    # ------------------------------------------------------------------------------------------
    # Pomodoro
    # ------------------------------------------------------------------------------------------

    def start_pomodoro(self, phase: Phase | None = None, *, task_id: str | None = None) -> dict[str, Any]:
        """Start the next phase (or the one asked for). A running phase is skipped for it: the set goes on."""
        self.finish_due()  # a phase whose time is up counts as done, not as skipped
        cfg = self.settings.get().timers
        now = self.clock()
        replaced: int | None = None
        with self._lock, transaction(self._factory) as session:
            if task_id is not None:
                task = session.get(Task, task_id)
                if task is None or task.deleted_at is not None:
                    raise TimerError("task_not_found", "Task not found", 404)
            current = self._current_pomodoro(session)
            if current is not None:
                self._end(current, "skipped", now)
                replaced = current.id
                session.flush()
            nxt_phase, cycle = self._next_phase(session, cfg, now)
            if phase is not None and phase != nxt_phase:
                if phase == "focus":
                    cycle += 1  # the break is left out: the set's next focus session
                elif nxt_phase == "focus":
                    cycle = max(0, cycle - 1)  # one more break after the last focus session
            chosen = phase or nxt_phase
            seconds = _phase_seconds(cfg, chosen)
            timer = self._new(session, "pomodoro", seconds, now, phase=chosen, cycle=cycle, task_id=task_id)
            self._work_on(session, timer, Actor.USER)
            timer_id, ends_at = timer.id, timer.ends_at
        if replaced is not None:
            self._unschedule(replaced)
        self._schedule(timer_id, ends_at)
        self._changed()
        return self.overview()

    @staticmethod
    def _end(timer: Timer, status: str, now: dt.datetime) -> None:
        timer.status = status
        timer.ends_at = None
        timer.remaining_seconds = None
        timer.finished_at = now

    def _new(
        self,
        session: Session,
        kind: str,
        seconds: int,
        now: dt.datetime,
        *,
        phase: Phase | None = None,
        cycle: int = 0,
        task_id: str | None = None,
        label: str = "",
        mode: str = "duration",
        ends_at: dt.datetime | None = None,
    ) -> Timer:
        timer = Timer(
            kind=kind,
            phase=phase,
            mode=mode,
            label=label,
            task_id=task_id,
            cycle=cycle,
            status="running",
            duration_seconds=seconds,
            ends_at=ends_at or now + dt.timedelta(seconds=seconds),
            started_at=now,
            created_at=now,
            updated_at=now,
        )
        session.add(timer)
        session.flush()
        return timer

    def _work_on(self, session: Session, timer: Timer, actor: Actor) -> None:
        """A focus session on a to-do: the to-do is being worked on now (as its "开始" button does); undoable."""
        task = timer.task
        if (
            timer.phase != "focus"
            or task is None
            or task.deleted_at is not None
            or task.status != TaskStatus.CONFIRMED.value
        ):
            return  # a task waiting for a reply, done or dismissed keeps its status
        self.tasks.change_status(
            session, task, TaskStatus.IN_PROGRESS, actor=actor, reason="pomodoro", summary="开始专注：待办 → 进行中"
        )

    def pause(self, timer_id: int) -> dict[str, Any]:
        self.finish_due()
        now = self.clock()
        with self._lock, transaction(self._factory) as session:
            timer = self._get(session, timer_id)
            if timer.mode == "until":
                raise TimerError("cannot_pause", "A countdown to a moment cannot be paused")
            if timer.status != "running" or timer.ends_at is None:
                raise TimerError("not_running", "The timer is not running")
            timer.remaining_seconds = max(1, int((timer.ends_at - now).total_seconds() + 0.999))
            timer.ends_at = None
            timer.status = "paused"
        self._unschedule(timer_id)
        self._changed()
        return self.overview()

    def resume(self, timer_id: int) -> dict[str, Any]:
        self.finish_due()
        now = self.clock()
        with self._lock, transaction(self._factory) as session:
            timer = self._get(session, timer_id)
            if timer.status != "paused":
                raise TimerError("not_paused", "The timer is not paused")
            timer.ends_at = now + dt.timedelta(seconds=timer.remaining_seconds or 0)
            timer.remaining_seconds = None
            timer.status = "running"
            ends_at = timer.ends_at
            self._work_on(session, timer, Actor.USER)
        self._schedule(timer_id, ends_at)
        self._changed()
        return self.overview()

    def skip(self, timer_id: int) -> dict[str, Any]:
        """End the current Pomodoro phase now (it does not count as done) and start the next one."""
        self.finish_due()
        now = self.clock()
        with self._lock, transaction(self._factory) as session:
            timer = self._get(session, timer_id)
            if timer.kind != "pomodoro" or timer.status not in ("running", "paused"):
                raise TimerError("not_running", "Only a running Pomodoro phase can be skipped")
            self._end(timer, "skipped", now)
        self._unschedule(timer_id)
        return self.start_pomodoro()

    def cancel(self, timer_id: int) -> dict[str, Any]:
        """Stop the Pomodoro timer (the next start begins a new set), or remove a countdown."""
        self.finish_due()
        now = self.clock()
        with self._lock, transaction(self._factory) as session:
            timer = self._get(session, timer_id)
            if timer.kind == "countdown":
                session.delete(timer)
            else:
                if timer.status not in ("running", "paused"):
                    raise TimerError("not_running", "The timer is not running")
                self._end(timer, "cancelled", now)
        self._unschedule(timer_id)
        self._changed()
        return self.overview()

    # ------------------------------------------------------------------------------------------
    # Countdowns
    # ------------------------------------------------------------------------------------------

    def start_countdown(
        self, *, label: str = "", seconds: int | None = None, until: dt.datetime | None = None
    ) -> dict[str, Any]:
        """A countdown for ``seconds``, or until the local moment ``until`` (naive: in the user's time zone)."""
        now = self.clock()
        label = label.strip()[:200]
        if (seconds is None) == (until is None):
            raise TimerError("invalid_countdown", "Give either a duration or an end time", 422)
        mode = "duration"
        end: dt.datetime | None = None
        if until is not None:
            tz = ZoneInfo(self.settings.get().general.timezone)
            end = (until if until.tzinfo else until.replace(tzinfo=tz)).astimezone(dt.UTC)
            if end - now < dt.timedelta(seconds=1):
                raise TimerError("countdown_in_past", "The end time has already passed", 422)
            seconds = math.ceil((end - now).total_seconds())
            if end - now > MAX_UNTIL:
                raise TimerError("countdown_too_long", "The end time is too far away", 422)
            mode = "until"
        assert seconds is not None
        if not 1 <= seconds <= MAX_COUNTDOWN.total_seconds() and mode == "duration":
            raise TimerError("countdown_too_long", "A countdown runs for 1 second to 7 days", 422)
        with self._lock, transaction(self._factory) as session:
            # A countdown to a moment ends exactly then (not a fraction of a second earlier).
            timer = self._new(session, "countdown", seconds, now, label=label, mode=mode, ends_at=end)
            timer_id, ends_at = timer.id, timer.ends_at
        self._schedule(timer_id, ends_at)
        self._changed()
        return self.overview()

    def restart(self, timer_id: int) -> dict[str, Any]:
        """Run a countdown for its duration again."""
        self.finish_due()
        now = self.clock()
        with self._lock, transaction(self._factory) as session:
            timer = self._get(session, timer_id)
            if timer.kind != "countdown" or timer.mode != "duration":
                raise TimerError("cannot_restart", "Only a countdown with a duration can run again")
            timer.status = "running"
            timer.started_at = now
            timer.ends_at = now + dt.timedelta(seconds=timer.duration_seconds)
            timer.remaining_seconds = None
            timer.finished_at = None
            timer.notified_at = None
            ends_at = timer.ends_at
        self._schedule(timer_id, ends_at)
        self._changed()
        return self.overview()

    def clear_finished(self) -> dict[str, Any]:
        self.finish_due()
        with self._lock, transaction(self._factory) as session:
            for timer in session.scalars(
                select(Timer).where(Timer.kind == "countdown", Timer.status.not_in(("running", "paused")))
            ):
                session.delete(timer)
        return self.overview()

    @staticmethod
    def _get(session: Session, timer_id: int) -> Timer:
        timer = session.get(Timer, timer_id)
        if timer is None:
            raise TimerError("timer_not_found", "Timer not found", 404)
        return timer

    # ------------------------------------------------------------------------------------------
    # Ending
    # ------------------------------------------------------------------------------------------

    def finish_due(self) -> list[int]:
        """Finish every running timer whose time is up: notify once, and start the next Pomodoro phase if wished."""
        now = self.clock()
        finished: list[int] = []
        notices: list[tuple[int, str, str]] = []
        with self._lock:
            with transaction(self._factory) as session:
                due = session.scalars(
                    select(Timer.id).where(Timer.status == "running", Timer.ends_at.is_not(None), Timer.ends_at <= now)
                ).all()
            for timer_id in due:
                notice = self._finish(timer_id, now)
                if notice is not None:
                    finished.append(timer_id)
                    notices.append(notice)
        # Listeners may read alarm state and call into the GUI: never dispatch while holding the timer lock.
        if finished:
            self._changed()
        # A blocked/unavailable toast service must not delay the independent alarm.
        for note_id, title, body in notices:
            if self._notify(title, body):
                with transaction(self._factory) as session:
                    sent = session.get(Notification, note_id)
                    if sent is not None:
                        sent.desktop_sent_at = self.clock()
        return finished

    def _finish(self, timer_id: int, now: dt.datetime) -> tuple[int, str, str] | None:
        cfg = self.settings.get()
        with transaction(self._factory) as session:
            # Only one caller (the scheduler or a page reading the timers) gets to finish it.
            done = session.execute(
                update(Timer)
                .where(Timer.id == timer_id, Timer.status == "running")
                .values(status="finished", finished_at=now, notified_at=now, remaining_seconds=None)
            )
            if not getattr(done, "rowcount", 0):
                return None
            timer = session.get(Timer, timer_id)
            assert timer is not None
            ended_at = timer.ends_at or now
            timer.ends_at = None
            session.flush()
            auto: tuple[Phase, int] | None = None
            if timer.kind == "pomodoro":
                nxt = self._next_phase(session, cfg.timers, now)
                wanted = cfg.timers.auto_start_breaks if timer.phase == "focus" else cfg.timers.auto_start_focus
                if wanted:
                    auto = nxt
                title, body = self._pomodoro_message(timer, nxt, auto is not None, cfg.general.language)
            else:
                texts = TEXTS["en" if cfg.general.language == "en" else "zh-CN"]
                title, body = texts["countdown_done"], timer.label or texts["countdown_unnamed"]
            if now - ended_at > LATE:  # TaskRadar was not running, or the computer was asleep
                tz = ZoneInfo(cfg.general.timezone)
                ended = ended_at.astimezone(tz)
                local = ended.strftime("%H:%M" if ended.date() == now.astimezone(tz).date() else "%Y-%m-%d %H:%M")
                body += TEXTS["en" if cfg.general.language == "en" else "zh-CN"]["late"].format(time=local)
            note = Notification(
                task_id=timer.task_id,
                level="info",
                title=title[:300],
                body=body,
                dedupe_key=f"timer:{timer.id}:{timer.started_at.isoformat()}",
                created_at=now,
            )
            session.add(note)
            session.flush()
            note_id = note.id
            alarm = (
                {
                    "id": note_id,
                    "timer_id": timer.id,
                    "phase": timer.phase,
                    "title": title,
                    "body": body,
                    "finished_at": ended_at.isoformat(),
                    # Missed phases are shown on return without starting an old alarm sound.
                    "audible": now - ended_at <= LATE,
                }
                if timer.kind == "pomodoro"
                else None
            )
            next_id: int | None = None
            next_end: dt.datetime | None = None
            if auto is not None:
                following = self._new(
                    session,
                    "pomodoro",
                    _phase_seconds(cfg.timers, auto[0]),
                    now,
                    phase=auto[0],
                    cycle=auto[1],
                    task_id=timer.task_id,
                )
                self._work_on(session, following, Actor.SYSTEM)
                next_id, next_end = following.id, following.ends_at
        if alarm is not None:
            self._alarm = alarm
        if next_id is not None:
            self._schedule(next_id, next_end)
        return note_id, title, body

    def _pomodoro_message(self, timer: Timer, nxt: tuple[Phase, int], auto: bool, language: str) -> tuple[str, str]:
        texts = TEXTS["en" if language == "en" else "zh-CN"]
        cfg = self.settings.get().timers
        if timer.phase == "focus":
            minutes = _phase_seconds(cfg, nxt[0]) // 60
            return texts["focus_done"], texts["focus_done_auto" if auto else "focus_done_body"].format(
                cycle=timer.cycle, minutes=minutes
            )
        return texts["break_done"], texts["break_done_auto" if auto else "break_done_body"].format(cycle=nxt[1])

    def _notify(self, title: str, body: str) -> bool:
        """Show the Windows notification, if the user wants timer notifications; whether it was shown."""
        if not self.guard.is_allowed(SideEffect.TIMER_NOTIFY):
            return False
        self.guard.check(SideEffect.TIMER_NOTIFY, target="timer")
        try:
            return bool(self.toast(title, body))
        except Exception:  # a notification that cannot be shown must not stop the timers
            log.exception("Timer notification failed")
            return False

    # ------------------------------------------------------------------------------------------
    # Scheduling
    # ------------------------------------------------------------------------------------------

    def _schedule(self, timer_id: int, at: dt.datetime | None) -> None:
        if self.on_schedule is not None and at is not None:
            self.on_schedule(timer_id, at)

    def _unschedule(self, timer_id: int) -> None:
        if self.on_unschedule is not None:
            self.on_unschedule(timer_id)

    def on_due(self, timer_id: int) -> None:
        """The scheduler's wake-up at a timer's end. A timer that runs on (resumed later) is woken up again."""
        self.finish_due()
        with transaction(self._factory) as session:
            timer = session.get(Timer, timer_id)
            ends_at = timer.ends_at if timer is not None and timer.status == "running" else None
        self._schedule(timer_id, ends_at)

    def resume_schedule(self) -> None:
        """On start-up: finish what ended while TaskRadar was not running, and wake up for the rest."""
        self.finish_due()
        with transaction(self._factory) as session:
            running = [
                (t.id, t.ends_at) for t in session.scalars(select(Timer).where(Timer.status == "running")) if t.ends_at
            ]
        for timer_id, ends_at in running:
            self._schedule(timer_id, ends_at)

    def tray_status(self) -> str | None:
        """A few words for the tray icon's tooltip: the Pomodoro phase and time left, running countdowns."""
        cfg = self.settings.get()
        texts = TEXTS["en" if cfg.general.language == "en" else "zh-CN"]
        now = self.clock()
        parts: list[str] = []
        with transaction(self._factory) as session:
            current = self._current_pomodoro(session)
            if current is not None and current.phase in PHASES:
                if current.status == "paused":
                    parts.append(f"{texts[current.phase]} · {texts['paused']}")
                elif current.ends_at is not None:
                    minutes = max(1, int((current.ends_at - now).total_seconds() / 60 + 0.999))
                    parts.append(f"{texts[current.phase]} · {texts['left'].format(minutes=minutes)}")
            countdowns = (
                session.scalar(
                    select(func.count())
                    .select_from(Timer)
                    .where(Timer.kind == "countdown", Timer.status.in_(("running", "paused")))
                )
                or 0
            )
        if countdowns:
            parts.append(texts["countdowns"].format(count=countdowns))
        return " · ".join(parts) or None
