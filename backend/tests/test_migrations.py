"""Schema migrations keep existing data and classify it correctly."""

from __future__ import annotations

from alembic import command
from sqlalchemy import text

from taskradar.config import AppConfig
from taskradar.db.migrate import alembic_config, upgrade_to_head
from taskradar.db.session import create_sqlite_engine

_NOW = "2026-10-14 10:00:00"


def _task(conn, task_id: str, title: str) -> None:  # type: ignore[no-untyped-def]
    conn.execute(
        text(
            "INSERT INTO tasks (id, title, description, category, action_type, action_required, status, priority,"
            " confidence, due_precision, due_is_relative, due_needs_confirmation, time_semantics, timezone,"
            " due_version, needs_review, review_reasons, entities, fingerprint, user_locked_fields, manual,"
            " detected_at, created_at, updated_at) VALUES (:id, :title, '', 'other', 'other', '', 'candidate',"
            " 'medium', 0.8, 'none', 0, 0, 'deadline', 'Europe/Berlin', 0, 0, '[]', '[]', '', '[]', 0,"
            " :now, :now, :now)"
        ),
        {"id": task_id, "title": title, "now": _NOW},
    )


def _source(conn, source_id: int, kind: str) -> None:  # type: ignore[no-untyped-def]
    conn.execute(
        text(
            "INSERT INTO sources (id, kind, name, recursive, enabled, status, created_at, updated_at)"
            " VALUES (:id, :kind, :kind, 0, 1, 'ok', :now, :now)"
        ),
        {"id": source_id, "kind": kind, "now": _NOW},
    )


def _message(conn, message_id: int, source_id: int) -> None:  # type: ignore[no-untyped-def]
    conn.execute(
        text(
            "INSERT INTO messages (id, source_id, external_id, subject, sender, recipients, snippet, body_text, labels,"
            " is_bulk, content_hash, status, created_at) VALUES (:id, :source, :ext, '', '', '', '', '', '[]', 0,"
            " 'h', 'processed', :now)"
        ),
        {"id": message_id, "source": source_id, "ext": f"x{message_id}", "now": _NOW},
    )


def _evidence(conn, task_id: str, *, message_id: int | None, origin: str) -> None:  # type: ignore[no-untyped-def]
    conn.execute(
        text(
            "INSERT INTO task_sources (task_id, message_id, origin_key, relation, evidence, source_label, created_at)"
            " VALUES (:task, :msg, :origin, 'origin', '[]', '', :now)"
        ),
        {"task": task_id, "msg": message_id, "origin": origin, "now": _NOW},
    )


def test_existing_demo_tasks_become_samples_and_real_ones_stay_real(config: AppConfig) -> None:
    config.ensure_dirs()
    engine = create_sqlite_engine(config.database_url)
    cfg = alembic_config(str(engine.url))
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "0001")
    with engine.begin() as conn:
        _source(conn, 1, "demo_mail")
        _source(conn, 2, "gmail")
        _message(conn, 10, 1)
        _message(conn, 20, 2)
        _task(conn, "demo", "Semesterbeitrag überweisen")
        _evidence(conn, "demo", message_id=10, origin="message:10")
        _task(conn, "real", "Prüfung anmelden")
        _evidence(conn, "real", message_id=20, origin="message:20")
        _task(conn, "mixed", "Visum verlängern")  # a demo mail merged into a real task: stays real
        _evidence(conn, "mixed", message_id=10, origin="message:10")
        _evidence(conn, "mixed", message_id=20, origin="message:20")
        _task(conn, "manual", "Arzttermin")
        _evidence(conn, "manual", message_id=None, origin="manual")

    upgrade_to_head(engine)
    with engine.connect() as conn:
        flags = dict(conn.execute(text("SELECT id, sample FROM tasks")).all())
    assert flags == {"demo": 1, "real": 0, "mixed": 0, "manual": 0}
    engine.dispose()


def test_the_migrations_build_the_schema_the_models_describe(config: AppConfig) -> None:
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    from taskradar.db.base import Base

    config.ensure_dirs()
    engine = create_sqlite_engine(config.database_url)
    try:
        upgrade_to_head(engine)
        with engine.connect() as conn:
            context = MigrationContext.configure(conn, opts={"compare_type": True})
            assert compare_metadata(context, Base.metadata) == []
    finally:
        engine.dispose()
