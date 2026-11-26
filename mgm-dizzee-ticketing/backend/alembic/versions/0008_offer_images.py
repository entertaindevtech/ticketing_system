"""offer images: optional banner image per offer, stored in the database

Revision ID: 0008
Revises: 0007
"""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "offer_images",
        sa.Column("offer_id", sa.String(32), sa.ForeignKey("offers.id"), primary_key=True),
        sa.Column("content_type", sa.String(16), nullable=False),
        sa.Column("data", sa.LargeBinary, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("offer_images")
