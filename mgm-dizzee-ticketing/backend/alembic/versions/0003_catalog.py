"""catalog and park configuration in PostgreSQL (ticket categories, add-ons, offers, per-date settings, park settings)

Seeds the catalog the prototype shipped with (app/catalog_seed.py). Purely additive.

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    settings = op.create_table(
        "park_settings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("data", sa.JSON, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("id = 1", name="ck_park_settings_singleton"),
    )
    cats = op.create_table(
        "ticket_categories",
        sa.Column("id", sa.String(16), primary_key=True),
        sa.Column("sort", sa.Integer, nullable=False, server_default="0"),
        sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("daily_limit", sa.Integer, nullable=False),
        sa.Column("data", sa.JSON, nullable=False),
        sa.CheckConstraint("daily_limit >= 0", name="ck_ticket_category_limit"),
    )
    addons = op.create_table(
        "addons",
        sa.Column("id", sa.String(16), primary_key=True),
        sa.Column("sort", sa.Integer, nullable=False, server_default="0"),
        sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("data", sa.JSON, nullable=False),
    )
    offers = op.create_table(
        "offers",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("coupon", sa.String(32), unique=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("max_redemptions", sa.Integer, nullable=False),
        sa.Column("redemptions", sa.Integer, nullable=False, server_default="0"),
        sa.Column("data", sa.JSON, nullable=False),
        sa.CheckConstraint("status IN ('draft','scheduled','active','paused','expired')", name="ck_offer_status"),
        sa.CheckConstraint("redemptions >= 0 AND max_redemptions >= 0", name="ck_offer_redemptions"),
    )
    dates = op.create_table(
        "park_dates",
        sa.Column("visit_date", sa.Date, primary_key=True),
        sa.Column("data", sa.JSON, nullable=False),
    )
    from app.catalog import seed_rows  # pure data; no ORM session involved
    rows = seed_rows()
    for table, t in (("park_settings", settings), ("ticket_categories", cats), ("addons", addons), ("offers", offers), ("park_dates", dates)):
        op.bulk_insert(t, rows[table])


def downgrade() -> None:
    for t in ("park_dates", "offers", "addons", "ticket_categories", "park_settings"):
        op.drop_table(t)
