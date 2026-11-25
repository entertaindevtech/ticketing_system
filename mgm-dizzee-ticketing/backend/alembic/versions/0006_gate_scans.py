"""gate scans: every scan attempt, with idempotent client scan ids

Revision ID: 0006
Revises: 0005
"""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "gate_scans",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), index=True),
        sa.Column("ticket_id", sa.Integer, sa.ForeignKey("tickets.id"), index=True),
        sa.Column("ticket_code", sa.String(20)),
        sa.Column("booking_ref", sa.String(16)),
        sa.Column("gate", sa.String(60), nullable=False),
        sa.Column("staff_code", sa.String(32), nullable=False),
        sa.Column("device_id", sa.String(64)),
        sa.Column("client_scan_id", sa.String(64)),
        sa.Column("result", sa.String(10), nullable=False),
        sa.Column("reason", sa.String(200), nullable=False),
        sa.CheckConstraint("result IN ('valid','duplicate','invalid')", name="ck_scan_result"),
    )
    op.create_index("uq_scan_client_id", "gate_scans", ["device_id", "client_scan_id"], unique=True)


def downgrade() -> None:
    op.drop_table("gate_scans")
