"""Keep deleted tasks in the recycle bin before permanent removal."""

import sqlalchemy as sa
from alembic import op

from taskradar.db.base import UTCDateTime

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("deleted_at", UTCDateTime(), nullable=True))
    op.create_index(op.f("ix_tasks_deleted_at"), "tasks", ["deleted_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_tasks_deleted_at"), table_name="tasks")
    op.drop_column("tasks", "deleted_at")
