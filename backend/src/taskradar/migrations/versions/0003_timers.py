"""timers: Pomodoro phases and countdowns

The server runs them, so a timer ends (and notifies) on time while the window is hidden in the tray, and a
restart picks running timers up again.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-18 22:00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from taskradar.db.base import UTCDateTime

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "timers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("phase", sa.String(length=16), nullable=True),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=False),
        sa.Column("task_id", sa.String(length=36), nullable=True),
        sa.Column("cycle", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("duration_seconds", sa.Integer(), nullable=False),
        sa.Column("remaining_seconds", sa.Integer(), nullable=True),
        sa.Column("ends_at", UTCDateTime(), nullable=True),
        sa.Column("started_at", UTCDateTime(), nullable=False),
        sa.Column("finished_at", UTCDateTime(), nullable=True),
        sa.Column("notified_at", UTCDateTime(), nullable=True),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], name=op.f("fk_timers_task_id_tasks"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_timers")),
    )
    op.create_index(op.f("ix_timers_kind"), "timers", ["kind"], unique=False)
    op.create_index(op.f("ix_timers_status"), "timers", ["status"], unique=False)
    op.create_index(op.f("ix_timers_ends_at"), "timers", ["ends_at"], unique=False)
    op.create_index(op.f("ix_timers_task_id"), "timers", ["task_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_timers_task_id"), table_name="timers")
    op.drop_index(op.f("ix_timers_ends_at"), table_name="timers")
    op.drop_index(op.f("ix_timers_status"), table_name="timers")
    op.drop_index(op.f("ix_timers_kind"), table_name="timers")
    op.drop_table("timers")
