"""Scheduling correctness and bounded reads without wall-clock timing thresholds."""

import datetime as dt
import random

from sqlalchemy import event

from taskradar.db.calendar_models import CalendarSource, CalendarWindow
from taskradar.db.session import transaction
from taskradar.services.calendar_conflicts import Busy, CalendarConflicts, next_free

BASE = dt.datetime(2026, 10, 25, tzinfo=dt.UTC)


def busy(start, end, before=0, after=0):
    return Busy(
        id="test",
        kind="work",
        title="test",
        start=BASE + dt.timedelta(minutes=start),
        end=BASE + dt.timedelta(minutes=end),
        before=dt.timedelta(minutes=before),
        after=dt.timedelta(minutes=after),
    )


def test_next_free_matches_exhaustive_five_minute_search():
    rng = random.Random(42)
    day_end = BASE + dt.timedelta(days=1)
    for _ in range(300):
        start = rng.randrange(1440)
        own = busy(start, start + rng.randrange(1, 120), rng.randrange(30), rng.randrange(30))
        others = []
        for _ in range(rng.randrange(60)):
            a = rng.randrange(-120, 1500)
            others.append(busy(a, a + rng.randrange(1, 180), rng.randrange(30), rng.randrange(30)))

        def blocked(candidate, own=own, others=others):
            lo = candidate - own.before
            hi = candidate + (own.end - own.start) + own.after
            return any(lo < item.hi and item.lo < hi for item in others)

        expected = None
        if blocked(own.start):
            for minute in range((start // 5 + 1) * 5, 1441, 5):
                candidate = BASE + dt.timedelta(minutes=minute)
                end = candidate + (own.end - own.start)
                if end > day_end:
                    break
                if not blocked(candidate):
                    expected = {"start": candidate.isoformat(), "end": end.isoformat()}
                    break
        assert next_free(own, others, day_end) == expected


def test_chained_intervals_read_each_bound_once(monkeypatch):
    reads = {"lo": 0, "hi": 0}
    for name in reads:
        original = getattr(Busy, name).fget

        def counted(self, name=name, original=original):
            reads[name] += 1
            return original(self)

        monkeypatch.setattr(Busy, name, property(counted))
    others = [busy(i * 5, (i + 1) * 5) for i in range(250)]
    own = busy(0, 5)
    assert next_free(own, list(reversed(others)), BASE + dt.timedelta(days=1)) == {
        "start": (BASE + dt.timedelta(minutes=1250)).isoformat(),
        "end": (BASE + dt.timedelta(minutes=1255)).isoformat(),
    }
    assert reads == {"lo": 250, "hi": 250}


def test_window_selection_loads_only_the_winning_payload(container):
    with transaction(container.factory) as session:
        session.add(CalendarSource(id="test", summary="Test", timezone="UTC", access_role="reader"))
        session.flush()
        for i in range(300):
            session.add(
                CalendarWindow(
                    calendar_id="test",
                    start_date=BASE.date() - dt.timedelta(days=i),
                    end_date=BASE.date() + dt.timedelta(days=1),
                    timezone="UTC",
                    last_synced_at=BASE + dt.timedelta(seconds=i),
                    events=[{"id": str(i)}],
                )
            )
        # Newer metadata passes the coarse SQL filter but does not cover midnight UTC.
        session.add(
            CalendarWindow(
                calendar_id="test",
                start_date=BASE.date(),
                end_date=BASE.date() + dt.timedelta(days=1),
                timezone="America/New_York",
                last_synced_at=BASE + dt.timedelta(days=1),
                events=[],
            )
        )
    with transaction(container.factory) as session:
        loaded = []
        event.listen(session, "loaded_as_persistent", lambda session, row: loaded.append(row))
        window = CalendarConflicts._window(session, "test", BASE, BASE + dt.timedelta(hours=1))
        assert window is not None and window.events == [{"id": "299"}]
        assert loaded == [window]
        assert CalendarConflicts._window(session, "missing", BASE, BASE) is None
