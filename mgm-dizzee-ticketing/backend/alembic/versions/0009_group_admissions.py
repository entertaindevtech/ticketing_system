"""group admissions: one booking QR, several admission transactions (Model A)

Adds the admission transaction tables and tickets.admission_id. Purely additive: existing tickets, used tickets and
gate scans are untouched; tickets used before this revision keep admission_id NULL (no history is invented).

Revision ID: 0009
Revises: 0008
"""
from alembic import op
import sqlalchemy as sa

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "gate_admissions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("ref", sa.String(16), nullable=False, unique=True),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("booking_id", sa.Integer, sa.ForeignKey("bookings.id"), nullable=False, index=True),
        sa.Column("booking_ref", sa.String(16), nullable=False),
        sa.Column("gate", sa.String(60), nullable=False),
        sa.Column("staff_code", sa.String(32), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), index=True),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("corrects_id", sa.Integer, sa.ForeignKey("gate_admissions.id")),
        sa.Column("reason", sa.String(255)),
        sa.Column("device_id", sa.String(64)),
        sa.Column("client_txn_id", sa.String(64)),
        sa.CheckConstraint("kind IN ('admit','correction')", name="ck_admission_kind"),
        sa.CheckConstraint("quantity > 0", name="ck_admission_quantity"),
        sa.CheckConstraint("kind = 'admit' OR (corrects_id IS NOT NULL AND reason IS NOT NULL)", name="ck_admission_correction"),
    )
    op.create_index("uq_admission_client_txn", "gate_admissions", ["device_id", "client_txn_id"], unique=True)
    op.create_table(
        "gate_admission_lines",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("admission_id", sa.Integer, sa.ForeignKey("gate_admissions.id"), nullable=False, index=True),
        sa.Column("category_id", sa.String(16), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_admission_line_quantity"),
    )
    with op.batch_alter_table("tickets") as b:
        b.add_column(sa.Column("admission_id", sa.Integer, nullable=True))
        b.create_foreign_key("fk_tickets_admission", "gate_admissions", ["admission_id"], ["id"])
        b.create_index("ix_tickets_admission_id", ["admission_id"])


def downgrade() -> None:
    with op.batch_alter_table("tickets") as b:
        b.drop_index("ix_tickets_admission_id")
        b.drop_constraint("fk_tickets_admission", type_="foreignkey")
        b.drop_column("admission_id")
    op.drop_table("gate_admission_lines")
    op.drop_table("gate_admissions")
