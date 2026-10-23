"""Agent execution/reasoning receipts, generated titles and prompt suggestions."""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_conversations", sa.Column("title_source", sa.String(16), nullable=False, server_default="message")
    )
    op.add_column("agent_conversations", sa.Column("title_error", sa.String(100), nullable=True))
    op.add_column("agent_turns", sa.Column("options", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))


def downgrade() -> None:
    with op.batch_alter_table("agent_turns") as batch:
        batch.drop_column("options")
    with op.batch_alter_table("agent_conversations") as batch:
        batch.drop_column("title_error")
        batch.drop_column("title_source")
