"""booking ledger: customers, bookings, items, tickets, inventory, payments, payment events, audit log, notifications

Links booking_attributions to bookings (booking_id, channel). Purely additive; existing attribution rows keep
booking_id NULL (they came from the retired browser-reported events).

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

MONEY = sa.Numeric(12, 2)


def _ts():
    return [sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())]


def upgrade() -> None:
    op.create_table(
        "customers",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("phone", sa.String(16), nullable=False, unique=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("email", sa.String(200)),
        sa.Column("phone_verified_at", sa.DateTime(timezone=True)),
        *_ts(),
    )
    op.create_table(
        "bookings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("ref", sa.String(16), nullable=False, unique=True),
        sa.Column("customer_id", sa.Integer, sa.ForeignKey("customers.id"), nullable=False, index=True),
        sa.Column("channel", sa.String(8), nullable=False),
        sa.Column("origin", sa.String(16), nullable=False, server_default="live"),
        sa.Column("visit_date", sa.Date, nullable=False, index=True),
        sa.Column("status", sa.String(16), nullable=False, index=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("phone", sa.String(16), nullable=False),
        sa.Column("email", sa.String(200)),
        sa.Column("notes", sa.String(500)),
        sa.Column("subtotal", MONEY, nullable=False),
        sa.Column("discount", MONEY, nullable=False),
        sa.Column("addons_total", MONEY, nullable=False),
        sa.Column("tax", MONEY, nullable=False),
        sa.Column("total", MONEY, nullable=False),
        sa.Column("complimentary", sa.Integer, nullable=False, server_default="0"),
        sa.Column("coupon", sa.String(32)),
        sa.Column("offer_ids", sa.JSON, nullable=False),
        sa.Column("units", sa.JSON, nullable=False),
        sa.Column("hold_expires_at", sa.DateTime(timezone=True)),
        sa.Column("confirmed_at", sa.DateTime(timezone=True)),
        sa.Column("cancelled_at", sa.DateTime(timezone=True)),
        sa.Column("modified_at", sa.DateTime(timezone=True)),
        sa.Column("visitor_session_id", sa.Integer, sa.ForeignKey("visitor_sessions.id")),
        sa.Column("created_by", sa.String(32)),
        sa.Column("idempotency_key", sa.String(80), unique=True),
        sa.Column("request_sha256", sa.String(64)),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        *_ts(),
        sa.CheckConstraint("status IN ('pending_payment','confirmed','cancelled','expired')", name="ck_booking_status"),
        sa.CheckConstraint("channel IN ('web','counter')", name="ck_booking_channel"),
        sa.CheckConstraint("channel = 'web' OR visitor_session_id IS NULL", name="ck_counter_no_session"),
        sa.CheckConstraint("total >= 0 AND subtotal >= 0 AND tax >= 0", name="ck_booking_amounts"),
    )
    op.create_table(
        "booking_items",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("booking_id", sa.Integer, sa.ForeignKey("bookings.id"), nullable=False, index=True),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("ref_id", sa.String(32), nullable=False),
        sa.Column("label", sa.String(200), nullable=False),
        sa.Column("detail", sa.String(200)),
        sa.Column("qty", sa.Integer, nullable=False),
        sa.Column("unit", MONEY, nullable=False),
        sa.Column("original", MONEY, nullable=False),
        sa.Column("amount", MONEY, nullable=False),
        sa.CheckConstraint("qty > 0", name="ck_item_qty"),
        sa.CheckConstraint("kind IN ('ticket','offer','addon')", name="ck_item_kind"),
    )
    op.create_table(
        "tickets",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("code", sa.String(16), nullable=False, unique=True),
        sa.Column("booking_id", sa.Integer, sa.ForeignKey("bookings.id"), nullable=False, index=True),
        sa.Column("category_id", sa.String(16), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("visit_date", sa.Date, nullable=False),
        sa.Column("status", sa.String(8), nullable=False, server_default="issued"),
        sa.Column("complimentary", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("offer_id", sa.String(32)),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.Column("used_gate", sa.String(60)),
        sa.Column("used_by", sa.String(32)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("status IN ('issued','used','void')", name="ck_ticket_status"),
        sa.CheckConstraint("status <> 'used' OR used_at IS NOT NULL", name="ck_ticket_used_at"),
    )
    op.create_index("ix_tickets_visit_status", "tickets", ["visit_date", "status"])
    for name, pk in (("date_inventory", ["visit_date"]), ("category_inventory", ["visit_date", "category_id"])):
        cols = [sa.Column("visit_date", sa.Date, nullable=False)]
        if name == "category_inventory":
            cols.append(sa.Column("category_id", sa.String(16), nullable=False))
        op.create_table(
            name, *cols,
            sa.Column("capacity", sa.Integer, nullable=False),
            sa.Column("held", sa.Integer, nullable=False, server_default="0"),
            sa.Column("sold", sa.Integer, nullable=False, server_default="0"),
            sa.PrimaryKeyConstraint(*pk),
            sa.CheckConstraint("held >= 0 AND sold >= 0 AND held + sold <= capacity", name=f"ck_{name}"),
        )
    op.create_table(
        "payments",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("booking_id", sa.Integer, sa.ForeignKey("bookings.id"), nullable=False, index=True),
        sa.Column("kind", sa.String(12), nullable=False, server_default="charge"),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("method", sa.String(32)),
        sa.Column("provider_order_id", sa.String(80)),
        sa.Column("provider_payment_id", sa.String(80)),
        sa.Column("amount", MONEY, nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="created"),
        sa.Column("failure_reason", sa.String(255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("captured_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("status IN ('created','captured','failed','refunded','partially_refunded')", name="ck_payment_status"),
        sa.CheckConstraint("amount >= 0", name="ck_payment_amount"),
    )
    op.create_index("uq_payment_provider_payment", "payments", ["provider", "provider_payment_id"], unique=True)
    op.create_table(
        "payment_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("event_id", sa.String(120), nullable=False),
        sa.Column("type", sa.String(40), nullable=False),
        sa.Column("payment_id", sa.Integer, sa.ForeignKey("payments.id")),
        sa.Column("payload_sha256", sa.String(64)),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("uq_payment_event", "payment_events", ["provider", "event_id"], unique=True)
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), index=True),
        sa.Column("actor", sa.String(60), nullable=False),
        sa.Column("type", sa.String(24), nullable=False),
        sa.Column("ref", sa.String(40), index=True),
        sa.Column("message", sa.String(500), nullable=False),
        sa.Column("details", sa.JSON),
    )
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), index=True),
        sa.Column("type", sa.String(24), nullable=False),
        sa.Column("ref", sa.String(40)),
        sa.Column("message", sa.String(500), nullable=False),
        sa.Column("read", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    with op.batch_alter_table("booking_attributions") as b:
        b.add_column(sa.Column("booking_id", sa.Integer, nullable=True))
        b.add_column(sa.Column("channel", sa.String(8), nullable=False, server_default="web"))
        b.create_foreign_key("fk_booking_attributions_booking", "bookings", ["booking_id"], ["id"])
        b.create_unique_constraint("uq_booking_attributions_booking_id", ["booking_id"])


def downgrade() -> None:
    with op.batch_alter_table("booking_attributions") as b:
        b.drop_constraint("uq_booking_attributions_booking_id", type_="unique")
        b.drop_constraint("fk_booking_attributions_booking", type_="foreignkey")
        b.drop_column("channel")
        b.drop_column("booking_id")
    for t in ("notifications", "audit_log", "payment_events", "payments", "category_inventory", "date_inventory",
              "tickets", "booking_items", "bookings", "customers"):
        op.drop_table(t)
