"""Benchmark read paths against disposable SQLite data, without accounts or notifications.

Run with backend/.venv/Scripts/python.exe scripts/benchmark-complexity.py --tasks 10000.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gc
import json
import statistics
import tempfile
import time
import tracemalloc
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlalchemy import insert

from taskradar.api.routes.tasks import dashboard, list_tasks
from taskradar.config import AppConfig
from taskradar.container import build_container
from taskradar.db.calendar_models import WorkBlock
from taskradar.db.models import Notification, Task, Timer
from taskradar.db.session import transaction
from taskradar.security.secrets import MemorySecretStore

NOW = dt.datetime(2026, 10, 14, 8, tzinfo=dt.UTC)


def measure(fn: Callable[[], Any], repeat: int) -> dict[str, float]:
    fn()  # Warm up SQL compilation and settings caches.
    times, peaks = [], []
    for _ in range(repeat):
        gc.collect()
        started = time.perf_counter()
        fn()
        times.append((time.perf_counter() - started) * 1000)
        gc.collect()
        tracemalloc.start()
        fn()
        peaks.append(tracemalloc.get_traced_memory()[1] / 1024 / 1024)
        tracemalloc.stop()
    return {"median_ms": round(statistics.median(times), 2), "peak_mib": round(max(peaks), 2)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", type=int, default=10000)
    parser.add_argument("--repeat", type=int, default=3)
    args = parser.parse_args()
    if args.tasks < 1 or args.repeat < 1:
        parser.error("--tasks and --repeat must be positive")
    with tempfile.TemporaryDirectory(prefix="taskradar-benchmark-") as temporary:
        c = build_container(
            AppConfig(data_dir=Path(temporary), scheduler_enabled=False, open_browser=False),
            secrets=MemorySecretStore(),
            clock=lambda: NOW,
            toast=lambda *_: True,
        )
        try:
            with transaction(c.factory) as session:
                session.execute(
                    insert(Task),
                    [
                        {
                            "id": f"task-{i:08}",
                            "title": f"Task {i}",
                            "description": "Benchmark notes. " * 64,
                            "status": ("confirmed", "in_progress", "waiting_for_reply", "completed")[i % 4],
                            "due_date": NOW.date() + dt.timedelta(days=i % 40 - 20) if i % 3 else None,
                            "due_time": "10:30" if i % 2 else None,
                            "timezone": ("Europe/Berlin", "America/New_York", "Asia/Shanghai")[i % 3],
                            "priority": ("high", "medium", "low")[i % 3],
                            "created_at": NOW - dt.timedelta(minutes=i),
                            "completed_at": NOW - dt.timedelta(minutes=i) if i % 4 == 3 else None,
                        }
                        for i in range(args.tasks)
                    ],
                )
                session.execute(
                    insert(Notification),
                    [{"title": f"Note {i}", "level": "info", "dedupe_key": f"note-{i}"} for i in range(args.tasks)],
                )
                session.execute(
                    insert(WorkBlock),
                    [
                        {
                            "id": f"block-{i}",
                            "task_id": f"task-{i:08}",
                            "title": "Work",
                            "start_at": NOW,
                            "end_at": NOW + dt.timedelta(hours=1),
                            "timezone": "Europe/Berlin",
                        }
                        for i in range(0, args.tasks, 4)
                    ],
                )
                session.execute(
                    insert(Timer),
                    [
                        {
                            "kind": "countdown",
                            "status": "finished",
                            "duration_seconds": 60,
                            "task_id": f"task-{i:08}",
                            "finished_at": NOW,
                        }
                        for i in range(min(args.tasks, 500))
                    ],
                )

            def tasks(sort: str) -> Any:
                return list_tasks(
                    status=[],
                    category=[],
                    urgency=[],
                    q=None,
                    sample=None,
                    manual=None,
                    in_calendar=None,
                    sort=sort,
                    order="asc",
                    limit=50,
                    offset=0,
                    c=c,
                )

            workloads = {
                "tasks_due_page_50": lambda: tasks("due"),
                "tasks_created_page_50": lambda: tasks("created_at"),
                "dashboard": lambda: dashboard(c),
                "calendar": lambda: c.workspace.view(dt.date(2026, 10, 1), dt.date(2026, 11, 1)),
                "unread_count": c.notifications.unread_count,
                "timers_500": c.timers.overview,
            }
            print(
                json.dumps(
                    {
                        "tasks": args.tasks,
                        "repeat": args.repeat,
                        "results": {name: measure(fn, args.repeat) for name, fn in workloads.items()},
                    },
                    indent=2,
                )
            )
        finally:
            c.dispose()


if __name__ == "__main__":
    main()
