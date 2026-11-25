"""universal visitor sessions: every visitor gets a session, every website booking a record

Generalizes referral_sessions into visitor_sessions (renamed, not rebuilt) and lets booking_attributions
hold bookings without an influencer. Existing rows are kept and backfilled as influencer traffic.

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

UTM = ("utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term")


def upgrade() -> None:
    op.rename_table("referral_sessions", "visitor_sessions")
    with op.batch_alter_table("visitor_sessions") as b:
        b.alter_column("influencer_id", existing_type=sa.Integer(), nullable=True)
        b.add_column(sa.Column("source", sa.String(16), nullable=False, server_default="unknown"))
        for c in UTM:
            b.add_column(sa.Column(c, sa.String(100), nullable=True))
        b.add_column(sa.Column("referrer_host", sa.String(255), nullable=True))
        b.add_column(sa.Column("attributed_at", sa.DateTime(timezone=True), nullable=True))
        b.add_column(sa.Column("attribution_expires_at", sa.DateTime(timezone=True), nullable=True))
        b.drop_index("ix_referral_sessions_influencer_id")
        b.create_index("ix_visitor_sessions_influencer_id", ["influencer_id"])
        b.create_index("ix_visitor_sessions_created_at", ["created_at"])
        b.create_index("ix_visitor_sessions_source", ["source"])
    # Every session before this migration was created by an influencer link (first-click, same window).
    op.execute("UPDATE visitor_sessions SET source = 'influencer', attributed_at = created_at, attribution_expires_at = expires_at")

    with op.batch_alter_table("booking_attributions") as b:
        b.alter_column("influencer_id", existing_type=sa.Integer(), nullable=True)
        b.alter_column("session_id", existing_type=sa.Integer(), nullable=True)
        b.add_column(sa.Column("source", sa.String(16), nullable=False, server_default="unknown"))
        for c in UTM[:3]:
            b.add_column(sa.Column(c, sa.String(100), nullable=True))
        b.create_index("ix_booking_attributions_source", ["source"])
    op.execute("UPDATE booking_attributions SET source = 'influencer'")


def downgrade() -> None:
    # The old schema cannot hold non-influencer traffic: those rows are removed on downgrade.
    op.execute("DELETE FROM booking_attributions WHERE influencer_id IS NULL OR session_id IS NULL")
    op.execute("DELETE FROM visitor_sessions WHERE influencer_id IS NULL")
    with op.batch_alter_table("booking_attributions") as b:
        b.drop_index("ix_booking_attributions_source")
        for c in ("source", *UTM[:3]):
            b.drop_column(c)
        b.alter_column("session_id", existing_type=sa.Integer(), nullable=False)
        b.alter_column("influencer_id", existing_type=sa.Integer(), nullable=False)
    with op.batch_alter_table("visitor_sessions") as b:
        for i in ("ix_visitor_sessions_source", "ix_visitor_sessions_created_at", "ix_visitor_sessions_influencer_id"):
            b.drop_index(i)
        b.create_index("ix_referral_sessions_influencer_id", ["influencer_id"])
        for c in ("source", *UTM, "referrer_host", "attributed_at", "attribution_expires_at"):
            b.drop_column(c)
        b.alter_column("influencer_id", existing_type=sa.Integer(), nullable=False)
    op.rename_table("visitor_sessions", "referral_sessions")
