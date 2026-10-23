"""Prep, commute and rest time reserved around calendar items."""

import sqlalchemy as sa
from alembic import op

from taskradar.db.base import UTCDateTime

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "calendar_buffers",
        sa.Column("item_key", sa.String(length=1600), nullable=False),
        sa.Column("before_minutes", sa.Integer(), nullable=False),
        sa.Column("before_kind", sa.String(length=16), nullable=False),
        sa.Column("after_minutes", sa.Integer(), nullable=False),
        sa.Column("after_kind", sa.String(length=16), nullable=False),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("item_key", name=op.f("pk_calendar_buffers")),
    )


def downgrade() -> None:
    op.drop_table("calendar_buffers")
