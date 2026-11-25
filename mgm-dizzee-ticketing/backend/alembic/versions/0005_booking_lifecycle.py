"""booking lifecycle: cancellation requests, booking modifications, refunds

Revision ID: 0005
Revises: 0004
"""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

MONEY = sa.Numeric(12, 2)


def upgrade() -> None:
    op.create_table(
        "cancellation_requests",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("booking_id", sa.Integer, sa.ForeignKey("bookings.id"), nullable=False, index=True),
        sa.Column("requested_by", sa.String(16), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default="pending"),
        sa.Column("fee", MONEY, nullable=False),
        sa.Column("refund_amount", MONEY, nullable=False),
        sa.Column("reason", sa.String(255)),
        sa.Column("rejection_reason", sa.String(255)),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("decided_by", sa.String(32)),
        sa.CheckConstraint("status IN ('pending','approved','rejected')", name="ck_cancellation_status"),
    )
    op.create_index("uq_cancellation_pending", "cancellation_requests", ["booking_id"], unique=True,
                    postgresql_where=sa.text("status = 'pending'"), sqlite_where=sa.text("status = 'pending'"))
    op.create_table(
        "booking_modifications",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("booking_id", sa.Integer, sa.ForeignKey("bookings.id"), nullable=False, index=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("by", sa.String(32), nullable=False),
        sa.Column("previous_visit_date", sa.Date, nullable=False),
        sa.Column("visit_date", sa.Date, nullable=False),
        sa.Column("previous_total", MONEY, nullable=False),
        sa.Column("new_total", MONEY, nullable=False),
        sa.Column("settlement", sa.String(8), nullable=False),
        sa.Column("before", sa.JSON, nullable=False),
        sa.Column("after", sa.JSON, nullable=False),
    )
    op.create_table(
        "refunds",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("booking_id", sa.Integer, sa.ForeignKey("bookings.id"), nullable=False, index=True),
        sa.Column("payment_id", sa.Integer, sa.ForeignKey("payments.id"), nullable=False),
        sa.Column("cancellation_request_id", sa.Integer, sa.ForeignKey("cancellation_requests.id")),
        sa.Column("modification_id", sa.Integer, sa.ForeignKey("booking_modifications.id")),
        sa.Column("amount", MONEY, nullable=False),
        sa.Column("fee", MONEY, nullable=False, server_default="0"),
        sa.Column("status", sa.String(12), nullable=False, server_default="pending"),
        sa.Column("provider_refund_id", sa.String(80), unique=True),
        sa.Column("reason", sa.String(255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("processed_at", sa.DateTime(timezone=True)),
        sa.Column("processed_by", sa.String(32)),
        sa.CheckConstraint("status IN ('pending','processing','succeeded','failed')", name="ck_refund_status"),
        sa.CheckConstraint("amount > 0", name="ck_refund_amount"),
    )


def downgrade() -> None:
    for t in ("refunds", "booking_modifications", "cancellation_requests"):
        op.drop_table(t)
