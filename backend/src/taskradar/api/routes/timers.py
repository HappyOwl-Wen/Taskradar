"""Pomodoro timer and countdowns (the timers run in the server; see :mod:`taskradar.services.timers`)."""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from taskradar.api.deps import get_container
from taskradar.container import Container
from taskradar.services.timers import MAX_COUNTDOWN, Phase

router = APIRouter(prefix="/api/timers", tags=["timers"])


class PomodoroBody(BaseModel):
    # Left out: the phase that comes next (a break after a focus session, else a focus session).
    phase: Phase | None = None
    task_id: str | None = Field(default=None, max_length=64)


class CountdownBody(BaseModel):
    label: str = Field(default="", max_length=200)
    # Either a duration or an end time ("2026-10-19T18:30", in the user's time zone).
    seconds: int | None = Field(default=None, ge=1, le=int(MAX_COUNTDOWN.total_seconds()))
    until: dt.datetime | None = None


@router.get("")
def overview(c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.timers.overview()


@router.post("/pomodoro")
def start_pomodoro(body: PomodoroBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.timers.start_pomodoro(body.phase, task_id=body.task_id)


@router.get("/alarm")
def alarm(c: Container = Depends(get_container)) -> dict[str, Any]:
    c.timers.finish_due()
    return c.timers.alarm_state()


@router.post("/alarm/{alarm_id}/dismiss")
def dismiss_alarm(alarm_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.timers.dismiss_alarm(alarm_id)


@router.post("/countdowns", status_code=201)
def start_countdown(body: CountdownBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.timers.start_countdown(label=body.label, seconds=body.seconds, until=body.until)


@router.post("/clear-finished")
def clear_finished(c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.timers.clear_finished()


@router.post("/{timer_id}/pause")
def pause(timer_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.timers.pause(timer_id)


@router.post("/{timer_id}/resume")
def resume(timer_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.timers.resume(timer_id)


@router.post("/{timer_id}/skip")
def skip(timer_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.timers.skip(timer_id)


@router.post("/{timer_id}/restart")
def restart(timer_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.timers.restart(timer_id)


@router.post("/{timer_id}/cancel")
def cancel(timer_id: int, c: Container = Depends(get_container)) -> dict[str, Any]:
    """Stop the Pomodoro timer, or remove a countdown."""
    return c.timers.cancel(timer_id)
