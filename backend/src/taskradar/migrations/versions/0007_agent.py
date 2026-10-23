"""Local AI Agent conversations and reviewable changes."""

import sqlalchemy as sa
from alembic import op

from taskradar.db.base import UTCDateTime

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_conversations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(100), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
        sa.Column("updated_at", UTCDateTime(), nullable=False),
    )
    op.create_index("ix_agent_conversations_updated_at", "agent_conversations", ["updated_at"])
    op.create_table(
        "agent_turns",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "conversation_id",
            sa.String(36),
            sa.ForeignKey("agent_conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_text", sa.Text(), nullable=False),
        sa.Column("assistant_text", sa.Text(), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error", sa.String(100), nullable=True),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("created_at", UTCDateTime(), nullable=False),
    )
    op.create_index("ix_agent_turns_conversation_id", "agent_turns", ["conversation_id"])
    op.create_index("ix_agent_turns_created_at", "agent_turns", ["created_at"])


def downgrade() -> None:
    op.drop_table("agent_turns")
    op.drop_table("agent_conversations")
