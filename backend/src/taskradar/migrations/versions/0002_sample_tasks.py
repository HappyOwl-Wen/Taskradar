"""sample (demo / test) tasks

Tasks from the synthetic demo mailbox or imported as test data are marked, so they never count in the
dashboard and statistics, never cause reminders or calendar events and are never matched with real tasks.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-16 09:00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("sample", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index(op.f("ix_tasks_sample"), "tasks", ["sample"], unique=False)
    # Existing demo tasks: every source they still have comes from the demo mailbox.
    op.execute(
        """
        UPDATE tasks SET sample = 1 WHERE id IN (
            SELECT ts.task_id
            FROM task_sources ts
            LEFT JOIN messages m ON m.id = ts.message_id
            LEFT JOIN documents d ON d.id = ts.document_id
            LEFT JOIN sources s ON s.id = COALESCE(m.source_id, d.source_id)
            GROUP BY ts.task_id
            HAVING SUM(CASE WHEN s.kind = 'demo_mail' THEN 1 ELSE 0 END) > 0
               AND SUM(CASE WHEN s.kind IS NOT NULL AND s.kind <> 'demo_mail' THEN 1 ELSE 0 END) = 0
               AND SUM(CASE WHEN ts.origin_key = 'manual' THEN 1 ELSE 0 END) = 0
        )
        """
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_tasks_sample"), table_name="tasks")
    with op.batch_alter_table("tasks") as batch_op:
        batch_op.drop_column("sample")
