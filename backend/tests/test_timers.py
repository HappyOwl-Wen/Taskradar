"""Pomodoro timer and countdowns: phases, pausing, ending once with a Windows notification, the API."""

from __future__ import annotations

import datetime as dt
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest
from sqlalchemy import select

from taskradar.config import AppConfig
from taskradar.container import Container, build_container
from taskradar.db.models import Notification, Timer
from taskradar.db.session import transaction
from taskradar.security.secrets import MemorySecretStore
from taskradar.services.timers import TimerError

from .conftest import Clock, add_task


def _current(c: Container) -> dict[str, Any]:
    current = c.timers.overview()["pomodoro"]["current"]
    assert current is not None
    return current


def _notes(c: Container) -> list[Notification]:
    with transaction(c.factory) as session:
        notes = list(session.scalars(select(Notification).order_by(Notification.id)))
        session.expunge_all()
        return notes


# ------------------------------------------------------------------------------------------------
# Pomodoro
# ------------------------------------------------------------------------------------------------


def test_a_focus_session_ends_with_a_notification_and_a_break_comes_next(
    container: Container, clock: Clock, toasts: list[tuple[str, str]]
) -> None:
    first = container.timers.start_pomodoro()["pomodoro"]["current"]
    assert (first["phase"], first["cycle"], first["status"]) == ("focus", 1, "running")
    assert first["remaining_seconds"] == 25 * 60

    clock.advance(minutes=10)
    assert _current(container)["remaining_seconds"] == 15 * 60
    assert toasts == []

    clock.advance(minutes=15)
    view = container.timers.overview()["pomodoro"]
    assert view["current"] is None
    assert view["last"]["status"] == "finished"
    assert view["next"] == {"phase": "short_break", "cycle": 1, "duration_seconds": 5 * 60}
    assert view["today"] == {"focus_sessions": 1, "focus_minutes": 25}
    assert toasts == [("专注结束", "第 1 个番茄完成。休息 5 分钟吧。")]
    # It is in the notification list as well (for when nobody was at the computer).
    assert [(n.title, n.level) for n in _notes(container)] == [("专注结束", "info")]

    container.timers.start_pomodoro()
    clock.advance(minutes=5)
    view = container.timers.overview()["pomodoro"]
    assert toasts[-1] == ("休息结束", "准备好就开始第 2 个番茄。")
    assert view["next"]["phase"] == "focus"
    assert view["next"]["cycle"] == 2


def test_after_the_set_comes_a_long_break(container: Container, clock: Clock) -> None:
    container.settings.update({"timers": {"long_break_every": 2, "long_break_minutes": 20}})
    for phase in ("focus", "short_break", "focus"):
        assert container.timers.start_pomodoro()["pomodoro"]["current"]["phase"] == phase
        clock.advance(minutes=25)
    view = container.timers.overview()["pomodoro"]
    assert view["next"] == {"phase": "long_break", "cycle": 2, "duration_seconds": 20 * 60}
    container.timers.start_pomodoro()
    clock.advance(minutes=20)
    # After the long break a new set begins.
    assert container.timers.overview()["pomodoro"]["next"]["cycle"] == 1


def test_a_long_pause_between_phases_starts_a_new_set(container: Container, clock: Clock) -> None:
    container.timers.start_pomodoro()
    clock.advance(minutes=25)
    assert container.timers.overview()["pomodoro"]["next"]["phase"] == "short_break"
    clock.advance(hours=3)
    view = container.timers.overview()["pomodoro"]
    assert view["next"]["phase"] == "focus"
    assert view["next"]["cycle"] == 1
    assert view["last"] is None


def test_pausing_keeps_the_time_left(container: Container, clock: Clock, toasts: list[tuple[str, str]]) -> None:
    timer_id = container.timers.start_pomodoro()["pomodoro"]["current"]["id"]
    clock.advance(minutes=10)
    paused = container.timers.pause(timer_id)["pomodoro"]["current"]
    assert (paused["status"], paused["remaining_seconds"], paused["ends_at"]) == ("paused", 15 * 60, None)

    clock.advance(hours=1)  # nothing ends while paused
    assert container.timers.finish_due() == []
    assert toasts == []
    resumed = container.timers.resume(timer_id)["pomodoro"]["current"]
    assert resumed["status"] == "running"
    assert resumed["remaining_seconds"] == 15 * 60
    clock.advance(minutes=15)
    assert container.timers.finish_due() == [timer_id]

    with pytest.raises(TimerError) as raised:
        container.timers.resume(timer_id)
    assert raised.value.code == "not_paused"


def test_skipping_moves_on_without_counting_the_session(container: Container, clock: Clock) -> None:
    timer_id = container.timers.start_pomodoro()["pomodoro"]["current"]["id"]
    clock.advance(minutes=5)
    view = container.timers.skip(timer_id)["pomodoro"]
    assert (view["current"]["phase"], view["current"]["cycle"]) == ("short_break", 1)
    assert view["today"]["focus_sessions"] == 0

    # Skipping the break starts the set's next focus session.
    view = container.timers.skip(view["current"]["id"])["pomodoro"]
    assert (view["current"]["phase"], view["current"]["cycle"]) == ("focus", 2)


def test_a_phase_chosen_by_hand_keeps_the_set_in_order(container: Container, clock: Clock) -> None:
    container.timers.start_pomodoro()
    clock.advance(minutes=25)
    # The break is left out: the next focus session is the set's second.
    view = container.timers.start_pomodoro("focus")["pomodoro"]
    assert (view["current"]["phase"], view["current"]["cycle"]) == ("focus", 2)
    # Starting a phase while one runs skips that one (as the skip button does): the break after session 2.
    view = container.timers.start_pomodoro("short_break")["pomodoro"]
    assert (view["current"]["phase"], view["current"]["cycle"]) == ("short_break", 2)
    with transaction(container.factory) as session:
        statuses = [t.status for t in session.scalars(select(Timer).order_by(Timer.id))]
    assert statuses == ["finished", "skipped", "running"]
    assert view["today"]["focus_sessions"] == 1


def test_stopping_the_pomodoro_timer_begins_a_new_set_next_time(container: Container, clock: Clock) -> None:
    container.timers.start_pomodoro()
    clock.advance(minutes=25)
    timer_id = container.timers.start_pomodoro()["pomodoro"]["current"]["id"]
    view = container.timers.cancel(timer_id)["pomodoro"]
    assert view["current"] is None
    assert view["next"] == {"phase": "focus", "cycle": 1, "duration_seconds": 25 * 60}


def test_breaks_and_focus_sessions_can_start_by_themselves(
    container: Container, clock: Clock, toasts: list[tuple[str, str]]
) -> None:
    container.settings.update({"timers": {"auto_start_breaks": True}})
    container.timers.start_pomodoro()
    clock.advance(minutes=25)
    current = _current(container)
    assert (current["phase"], current["status"], current["remaining_seconds"]) == ("short_break", "running", 300)
    assert toasts == [("专注结束", "第 1 个番茄完成，5 分钟的休息已经开始。")]

    # Focus sessions do not start by themselves unless asked for.
    clock.advance(minutes=5)
    assert container.timers.overview()["pomodoro"]["current"] is None
    assert toasts[-1] == ("休息结束", "准备好就开始第 2 个番茄。")


def test_a_pomodoro_can_belong_to_a_task_that_may_be_deleted_later(api: Any) -> None:
    task_id = add_task(api.container, "Bericht schreiben")
    current = api.post("/api/timers/pomodoro", json={"task_id": task_id}).json()["pomodoro"]["current"]
    assert current["task_title"] == "Bericht schreiben"
    # An unknown task changes nothing (the running phase stays).
    assert api.post("/api/timers/pomodoro", json={"task_id": "missing"}).status_code == 404
    assert api.get("/api/timers").json()["pomodoro"]["current"]["id"] == current["id"]

    assert api.delete(f"/api/tasks/{task_id}").status_code == 200
    current = api.get("/api/timers").json()["pomodoro"]["current"]
    assert (current["task_id"], current["task_title"], current["status"]) == (None, None, "running")


# ------------------------------------------------------------------------------------------------
# Countdowns
# ------------------------------------------------------------------------------------------------


def test_a_countdown_runs_for_its_duration_and_can_run_again(
    container: Container, clock: Clock, toasts: list[tuple[str, str]]
) -> None:
    countdown = container.timers.start_countdown(label="Tee", seconds=180)["countdowns"][0]
    assert (countdown["mode"], countdown["status"], countdown["remaining_seconds"]) == ("duration", "running", 180)

    clock.advance(seconds=179)
    assert container.timers.finish_due() == []
    clock.advance(seconds=1)
    assert container.timers.finish_due() == [countdown["id"]]
    assert toasts == [("倒计时结束", "Tee")]
    assert container.timers.overview()["countdowns"][0]["status"] == "finished"

    again = container.timers.restart(countdown["id"])["countdowns"][0]
    assert (again["status"], again["remaining_seconds"]) == ("running", 180)
    clock.advance(minutes=3)
    container.timers.finish_due()
    # Each run notifies once.
    assert toasts == [("倒计时结束", "Tee"), ("倒计时结束", "Tee")]


def test_a_countdown_to_a_moment_uses_the_users_time_zone(container: Container, clock: Clock) -> None:
    # 12:30 in Berlin (CEST) is 10:30 UTC; the clock says 08:00 UTC.
    countdown = container.timers.start_countdown(until=dt.datetime(2026, 10, 14, 12, 30))["countdowns"][0]
    assert countdown["mode"] == "until"
    assert countdown["remaining_seconds"] == int(2.5 * 3600)
    assert countdown["ends_at"] == "2026-10-14T10:30:00+00:00"
    with pytest.raises(TimerError) as raised:
        container.timers.pause(countdown["id"])
    assert raised.value.code == "cannot_pause"
    with pytest.raises(TimerError) as raised:
        container.timers.restart(countdown["id"])
    assert raised.value.code == "cannot_restart"


def test_a_countdown_to_a_moment_ends_exactly_then(container: Container, clock: Clock) -> None:
    clock.advance(seconds=0.4)  # the clock is rarely on a whole second
    countdown = container.timers.start_countdown(until=dt.datetime(2026, 10, 14, 12, 0))["countdowns"][0]
    assert countdown["ends_at"] == "2026-10-14T10:00:00+00:00"
    assert countdown["duration_seconds"] == 2 * 3600


def test_running_countdowns_come_first_nearest_end_first(container: Container, clock: Clock) -> None:
    long = container.timers.start_countdown(label="lang", seconds=3600)["countdowns"][0]["id"]
    short = container.timers.start_countdown(label="kurz", seconds=60)["countdowns"][0]["id"]
    done = container.timers.start_countdown(label="fertig", seconds=1)["countdowns"][0]["id"]
    clock.advance(seconds=2)
    assert [c["id"] for c in container.timers.overview()["countdowns"]] == [short, long, done]

    view = container.timers.clear_finished()
    assert [c["id"] for c in view["countdowns"]] == [short, long]
    view = container.timers.cancel(short)
    assert [c["id"] for c in view["countdowns"]] == [long]


def test_a_paused_countdown_does_not_end(container: Container, clock: Clock, toasts: list[tuple[str, str]]) -> None:
    timer_id = container.timers.start_countdown(seconds=600)["countdowns"][0]["id"]
    clock.advance(seconds=100)
    assert container.timers.pause(timer_id)["countdowns"][0]["remaining_seconds"] == 500
    clock.advance(hours=2)
    assert container.timers.overview()["countdowns"][0]["status"] == "paused"
    container.timers.resume(timer_id)
    clock.advance(seconds=500)
    container.timers.finish_due()
    assert toasts == [("倒计时结束", "时间到了")]


# ------------------------------------------------------------------------------------------------
# Ending: once, on time, and only with the notifications the user wants
# ------------------------------------------------------------------------------------------------


def test_a_timer_ends_only_once_even_when_two_callers_race(
    container: Container, clock: Clock, toasts: list[tuple[str, str]]
) -> None:
    container.timers.start_countdown(label="Pizza", seconds=60)
    clock.advance(minutes=1)
    barrier = threading.Barrier(4)
    results: list[list[int]] = []

    def finish() -> None:
        barrier.wait()
        results.append(container.timers.finish_due())

    threads = [threading.Thread(target=finish) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(len(r) for r in results) == [0, 0, 0, 1]
    assert toasts == [("倒计时结束", "Pizza")]
    assert len(_notes(container)) == 1


def test_timer_notifications_can_be_turned_off(
    container: Container, clock: Clock, toasts: list[tuple[str, str]]
) -> None:
    container.settings.update({"timers": {"notify": False}})
    container.timers.start_countdown(label="Pizza", seconds=60)
    clock.advance(minutes=1)
    container.timers.finish_due()
    assert toasts == []
    # Still recorded in TaskRadar's own list, but not as sent to Windows.
    [note] = _notes(container)
    assert (note.title, note.desktop_sent_at) == ("倒计时结束", None)


def test_a_shown_notification_is_marked_as_sent(container: Container, clock: Clock) -> None:
    container.timers.start_countdown(seconds=60)
    clock.advance(minutes=1)
    container.timers.finish_due()
    [note] = _notes(container)
    assert note.desktop_sent_at == clock.now


def test_a_timer_that_ended_while_taskradar_was_closed_says_when(
    container: Container, clock: Clock, toasts: list[tuple[str, str]]
) -> None:
    container.timers.start_countdown(label="Wäsche", seconds=600)  # ends 10:10 Berlin time
    clock.advance(hours=2)
    container.timers.resume_schedule()  # what happens on start-up
    assert toasts == [("倒计时结束", "Wäsche（已于 10:10 结束）")]


def test_the_notification_follows_the_language(
    container: Container, clock: Clock, toasts: list[tuple[str, str]]
) -> None:
    container.settings.update({"general": {"language": "en"}})
    container.timers.start_pomodoro()
    clock.advance(minutes=25)
    container.timers.finish_due()
    assert toasts == [("Focus session done", "Pomodoro 1 done. Take a 5-minute break.")]


def test_the_scheduler_is_told_when_each_timer_ends(container: Container, clock: Clock) -> None:
    scheduled: list[tuple[int, dt.datetime]] = []
    removed: list[int] = []
    container.timers.on_schedule = lambda timer_id, at: scheduled.append((timer_id, at))
    container.timers.on_unschedule = removed.append

    timer_id = container.timers.start_countdown(seconds=600)["countdowns"][0]["id"]
    assert scheduled == [(timer_id, clock.now + dt.timedelta(seconds=600))]
    clock.advance(seconds=100)
    container.timers.pause(timer_id)
    assert removed == [timer_id]
    clock.advance(seconds=50)
    container.timers.resume(timer_id)
    assert scheduled[-1] == (timer_id, clock.now + dt.timedelta(seconds=500))

    # A wake-up before the (moved) end leaves the timer running and wakes up again at the end.
    container.timers.on_due(timer_id)
    assert scheduled[-1] == (timer_id, clock.now + dt.timedelta(seconds=500))
    container.timers.cancel(timer_id)
    assert removed == [timer_id, timer_id]


def test_listeners_hear_about_starts_and_ends(container: Container, clock: Clock) -> None:
    changes: list[str | None] = []
    container.timers.subscribe(lambda: changes.append(container.timers.tray_status()))
    container.timers.start_pomodoro()
    container.timers.start_countdown(seconds=90)
    clock.advance(seconds=90)
    container.timers.finish_due()
    assert changes == ["专注中 · 剩 25 分钟", "专注中 · 剩 25 分钟 · 1 个倒计时", "专注中 · 剩 24 分钟"]
    container.timers.pause(_current(container)["id"])
    assert changes[-1] == "专注中 · 已暂停"


def test_a_countdown_ends_on_time_without_anyone_looking(config: AppConfig) -> None:
    """The real scheduler (real time): nothing reads the timers, the notification still comes."""
    from taskradar.scheduler.service import SchedulerService

    shown = threading.Event()
    toasts: list[tuple[str, str]] = []

    def toast(title: str, body: str) -> bool:
        toasts.append((title, body))
        shown.set()
        return True

    container = build_container(config, secrets=MemorySecretStore(), toast=toast)
    scheduler = SchedulerService(container)
    scheduler.start()
    try:
        started = time.monotonic()
        container.timers.start_countdown(label="Ofen", seconds=1)
        assert shown.wait(10)
        assert time.monotonic() - started >= 0.9
        assert toasts == [("倒计时结束", "Ofen")]
    finally:
        scheduler.shutdown()
        container.dispose()


# ------------------------------------------------------------------------------------------------
# API and data
# ------------------------------------------------------------------------------------------------


def test_the_timer_api(api: Any) -> None:
    clock: Clock = api.container.clock
    view = api.get("/api/timers").json()
    assert view["pomodoro"]["current"] is None
    assert view["pomodoro"]["next"] == {"phase": "focus", "cycle": 1, "duration_seconds": 1500}
    assert view["countdowns"] == []

    current = api.post("/api/timers/pomodoro", json={}).json()["pomodoro"]["current"]
    assert api.post(f"/api/timers/{current['id']}/pause").json()["pomodoro"]["current"]["status"] == "paused"
    assert api.post(f"/api/timers/{current['id']}/pause").json()["error"]["code"] == "not_running"
    assert api.post(f"/api/timers/{current['id']}/resume").json()["pomodoro"]["current"]["status"] == "running"
    skipped = api.post(f"/api/timers/{current['id']}/skip").json()["pomodoro"]["current"]
    assert skipped["phase"] == "short_break"
    assert api.post(f"/api/timers/{skipped['id']}/cancel").json()["pomodoro"]["current"] is None
    assert api.post("/api/timers/pomodoro", json={"phase": "nap"}).status_code == 422

    created = api.post("/api/timers/countdowns", json={"label": "Tee", "seconds": 120})
    assert created.status_code == 201
    countdown = created.json()["countdowns"][0]
    clock.advance(minutes=2)
    assert api.get("/api/timers").json()["countdowns"][0]["status"] == "finished"
    assert api.post(f"/api/timers/{countdown['id']}/restart").json()["countdowns"][0]["status"] == "running"
    clock.advance(minutes=2)
    assert api.post("/api/timers/clear-finished").json()["countdowns"] == []
    assert api.post("/api/timers/999/cancel").status_code == 404


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"seconds": 60, "until": "2026-10-14T12:00"}, "invalid_countdown"),
        ({}, "invalid_countdown"),
        ({"until": "2026-10-14T09:00"}, "countdown_in_past"),  # 09:00 Berlin = 07:00 UTC, before 08:00 UTC
        ({"until": "2028-01-01T00:00"}, "countdown_too_long"),
        ({"seconds": 8 * 24 * 3600}, "validation_error"),
        ({"seconds": 0}, "validation_error"),
        ({"seconds": 60, "label": "x" * 201}, "validation_error"),
    ],
)
def test_countdowns_that_cannot_run_are_refused(api: Any, body: dict[str, Any], code: str) -> None:
    response = api.post("/api/timers/countdowns", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == code


def test_timer_changes_need_the_csrf_token(api: Any) -> None:
    del api.headers["X-TaskRadar-CSRF"]
    assert api.post("/api/timers/pomodoro", json={}).status_code == 403
    assert api.get("/api/timers").status_code == 200


def test_timers_are_exported_and_deleted_with_all_data(make_container: Callable[..., Container]) -> None:
    c = make_container()
    c.timers.start_pomodoro()
    c.timers.start_countdown(label="Tee", seconds=60)
    exported = c.data.export()
    assert sorted(t["kind"] for t in exported["timers"]) == ["countdown", "pomodoro"]
    counts = c.data.delete_all()
    assert counts["timers"] == 2
    assert c.timers.overview()["countdowns"] == []
    assert c.timers.overview()["pomodoro"]["current"] is None
