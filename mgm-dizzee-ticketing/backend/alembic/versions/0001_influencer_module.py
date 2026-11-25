"""influencer and regional sales intelligence

Revision ID: 0001
Revises: 
Create Date: 2026-11-25 13:50:14.048790
"""
from alembic import op
import sqlalchemy as sa


revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('influencers',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('platform', sa.String(length=40), nullable=False),
    sa.Column('referral_code', sa.String(length=32), nullable=False),
    sa.Column('commission_rate', sa.Numeric(precision=5, scale=2), nullable=False),
    sa.Column('handle', sa.String(length=200), nullable=True),
    sa.Column('email', sa.String(length=200), nullable=True),
    sa.Column('phone', sa.String(length=40), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.CheckConstraint('commission_rate >= 0 AND commission_rate <= 100', name='ck_influencer_rate'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('referral_code')
    )
    op.create_table('referral_sessions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('token', sa.String(length=64), nullable=False),
    sa.Column('influencer_id', sa.Integer(), nullable=False),
    sa.Column('campaign', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('geo_country_code', sa.String(length=2), nullable=True),
    sa.Column('geo_country', sa.String(length=80), nullable=True),
    sa.Column('geo_region', sa.String(length=120), nullable=True),
    sa.Column('geo_city', sa.String(length=120), nullable=True),
    sa.ForeignKeyConstraint(['influencer_id'], ['influencers.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token')
    )
    with op.batch_alter_table('referral_sessions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_referral_sessions_influencer_id'), ['influencer_id'], unique=False)

    op.create_table('booking_attributions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('booking_ref', sa.String(length=40), nullable=False),
    sa.Column('influencer_id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('campaign', sa.String(length=64), nullable=True),
    sa.Column('payment_ref', sa.String(length=80), nullable=True),
    sa.Column('paid_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('visit_date', sa.Date(), nullable=True),
    sa.Column('tickets', sa.Integer(), nullable=False),
    sa.Column('ticket_net_amount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('addons_amount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('tax_amount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('total_amount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('geo_country_code', sa.String(length=2), nullable=True),
    sa.Column('geo_country', sa.String(length=80), nullable=True),
    sa.Column('geo_region', sa.String(length=120), nullable=True),
    sa.Column('geo_city', sa.String(length=120), nullable=True),
    sa.CheckConstraint("status IN ('paid','cancelled')", name='ck_attribution_status'),
    sa.ForeignKeyConstraint(['influencer_id'], ['influencers.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['referral_sessions.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('booking_ref')
    )
    with op.batch_alter_table('booking_attributions', schema=None) as batch_op:
        batch_op.create_index('ix_booking_attr_influencer_status', ['influencer_id', 'status'], unique=False)
        batch_op.create_index('ix_booking_attr_paid_at', ['paid_at'], unique=False)

    op.create_table('referral_clicks',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('influencer_id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('campaign', sa.String(length=64), nullable=True),
    sa.Column('kept_existing_attribution', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['influencer_id'], ['influencers.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['referral_sessions.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('referral_clicks', schema=None) as batch_op:
        batch_op.create_index('ix_referral_clicks_influencer_created', ['influencer_id', 'created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_referral_clicks_session_id'), ['session_id'], unique=False)

    op.create_table('influencer_commissions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('booking_attribution_id', sa.Integer(), nullable=False),
    sa.Column('influencer_id', sa.Integer(), nullable=False),
    sa.Column('rate', sa.Numeric(precision=5, scale=2), nullable=False),
    sa.Column('basis', sa.String(length=32), nullable=False),
    sa.Column('basis_amount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('amount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('payout_reference', sa.String(length=120), nullable=True),
    sa.Column('reversed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('reversal_reason', sa.String(length=255), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    sa.CheckConstraint("status IN ('pending','approved','paid','reversed')", name='ck_commission_status'),
    sa.ForeignKeyConstraint(['booking_attribution_id'], ['booking_attributions.id'], ),
    sa.ForeignKeyConstraint(['influencer_id'], ['influencers.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('booking_attribution_id')
    )
    with op.batch_alter_table('influencer_commissions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_influencer_commissions_influencer_id'), ['influencer_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_influencer_commissions_status'), ['status'], unique=False)

    op.create_table('commission_events',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('commission_id', sa.Integer(), nullable=False),
    sa.Column('from_status', sa.String(length=16), nullable=True),
    sa.Column('to_status', sa.String(length=16), nullable=False),
    sa.Column('note', sa.String(length=255), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['commission_id'], ['influencer_commissions.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('commission_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_commission_events_commission_id'), ['commission_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('commission_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_commission_events_commission_id'))

    op.drop_table('commission_events')
    with op.batch_alter_table('influencer_commissions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_influencer_commissions_status'))
        batch_op.drop_index(batch_op.f('ix_influencer_commissions_influencer_id'))

    op.drop_table('influencer_commissions')
    with op.batch_alter_table('referral_clicks', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_referral_clicks_session_id'))
        batch_op.drop_index('ix_referral_clicks_influencer_created')

    op.drop_table('referral_clicks')
    with op.batch_alter_table('booking_attributions', schema=None) as batch_op:
        batch_op.drop_index('ix_booking_attr_paid_at')
        batch_op.drop_index('ix_booking_attr_influencer_status')

    op.drop_table('booking_attributions')
    with op.batch_alter_table('referral_sessions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_referral_sessions_influencer_id'))

    op.drop_table('referral_sessions')
    op.drop_table('influencers')
