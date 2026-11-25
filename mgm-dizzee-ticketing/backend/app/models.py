"""Influencer & regional sales intelligence schema.

Bookings themselves still live in the existing front-end store; this module keeps a
booking *attribution* row per attributed booking (keyed by the booking reference), which
is where the attribution and regional snapshot are frozen for historical reporting.
"""
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

COMMISSION_STATUSES = ("pending", "approved", "paid", "reversed")
MONEY = Numeric(12, 2)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime) -> datetime:
    # SQLite returns naive datetimes; everything we write is UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class Timestamps:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=func.now(), nullable=False)


class GeoSnapshot:
    """Approximate, IP-derived location. Never the customer's stated address. No raw IP is stored."""
    geo_country_code: Mapped[str | None] = mapped_column(String(2))
    geo_country: Mapped[str | None] = mapped_column(String(80))
    geo_region: Mapped[str | None] = mapped_column(String(120))  # state / union territory for India
    geo_city: Mapped[str | None] = mapped_column(String(120))


class Influencer(Timestamps, Base):
    __tablename__ = "influencers"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    platform: Mapped[str] = mapped_column(String(40), nullable=False)
    referral_code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    commission_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)  # percent, e.g. 8.00
    handle: Mapped[str | None] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(40))
    notes: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    __table_args__ = (CheckConstraint("commission_rate >= 0 AND commission_rate <= 100", name="ck_influencer_rate"),)


class ReferralSession(GeoSnapshot, Base):
    """Anonymous visitor session established by the first valid referral click (first-click model)."""
    __tablename__ = "referral_sessions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    influencer_id: Mapped[int] = mapped_column(ForeignKey("influencers.id"), nullable=False, index=True)
    campaign: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    influencer: Mapped[Influencer] = relationship()


class ReferralClick(Base):
    __tablename__ = "referral_clicks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    influencer_id: Mapped[int] = mapped_column(ForeignKey("influencers.id"), nullable=False)
    session_id: Mapped[int] = mapped_column(ForeignKey("referral_sessions.id"), nullable=False, index=True)
    campaign: Mapped[str | None] = mapped_column(String(64))
    # True when the visitor already had a live attribution, so this click did not change it.
    kept_existing_attribution: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__ = (Index("ix_referral_clicks_influencer_created", "influencer_id", "created_at"),)


class BookingAttribution(Timestamps, GeoSnapshot, Base):
    """Frozen at payment confirmation; the geo columns are a copy of the session's snapshot so
    reporting stays stable even if session data is later purged."""
    __tablename__ = "booking_attributions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_ref: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    influencer_id: Mapped[int] = mapped_column(ForeignKey("influencers.id"), nullable=False)
    session_id: Mapped[int] = mapped_column(ForeignKey("referral_sessions.id"), nullable=False)
    campaign: Mapped[str | None] = mapped_column(String(64))
    payment_ref: Mapped[str | None] = mapped_column(String(80))
    paid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    visit_date: Mapped[datetime | None] = mapped_column(Date)
    tickets: Mapped[int] = mapped_column(Integer, nullable=False)
    ticket_net_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)  # after discounts, ex GST, ex add-ons
    addons_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    tax_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    total_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="paid")  # paid | cancelled
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    influencer: Mapped[Influencer] = relationship()
    commission: Mapped["InfluencerCommission"] = relationship(back_populates="attribution", uselist=False)
    __table_args__ = (
        CheckConstraint("status IN ('paid','cancelled')", name="ck_attribution_status"),
        Index("ix_booking_attr_influencer_status", "influencer_id", "status"),
        Index("ix_booking_attr_paid_at", "paid_at"),
    )


class InfluencerCommission(Timestamps, Base):
    __tablename__ = "influencer_commissions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_attribution_id: Mapped[int] = mapped_column(ForeignKey("booking_attributions.id"), nullable=False, unique=True)
    influencer_id: Mapped[int] = mapped_column(ForeignKey("influencers.id"), nullable=False, index=True)
    rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)  # snapshot of influencer rate at payment time
    basis: Mapped[str] = mapped_column(String(32), nullable=False)
    basis_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", index=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payout_reference: Mapped[str | None] = mapped_column(String(120))
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversal_reason: Mapped[str | None] = mapped_column(String(255))
    attribution: Mapped[BookingAttribution] = relationship(back_populates="commission")
    events: Mapped[list["CommissionEvent"]] = relationship(order_by="CommissionEvent.id")
    __table_args__ = (CheckConstraint("status IN ('pending','approved','paid','reversed')", name="ck_commission_status"),)


class CommissionEvent(Base):
    """Append-only history of every commission status/amount change."""
    __tablename__ = "commission_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    commission_id: Mapped[int] = mapped_column(ForeignKey("influencer_commissions.id"), nullable=False, index=True)
    from_status: Mapped[str | None] = mapped_column(String(16))
    to_status: Mapped[str] = mapped_column(String(16), nullable=False)
    note: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
