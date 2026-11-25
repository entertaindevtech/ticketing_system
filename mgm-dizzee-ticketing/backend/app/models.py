"""Database schema: catalog and park configuration, the booking ledger (customers, bookings, tickets, inventory,
payments, refunds, lifecycle records), staff accounts, gate scans, and the influencer & regional intelligence tables.

PostgreSQL is the source of truth for all of it. booking_attributions freezes each paid website booking's
region / acquisition source / influencer at payment time for historical reporting.
"""
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    JSON, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, func,
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


class VisitorSession(GeoSnapshot, Base):
    """Anonymous visitor session for every website visitor (one opaque token, one GeoIP lookup).

    Acquisition fields record the *first touch* and are never overwritten. Influencer attribution is a
    separate, optional first-click claim with its own window, so geography never depends on a referral."""
    __tablename__ = "visitor_sessions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # first-touch acquisition (see app/acquisition.py)
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown", server_default="unknown", index=True)
    utm_source: Mapped[str | None] = mapped_column(String(100))
    utm_medium: Mapped[str | None] = mapped_column(String(100))
    utm_campaign: Mapped[str | None] = mapped_column(String(100))
    utm_content: Mapped[str | None] = mapped_column(String(100))
    utm_term: Mapped[str | None] = mapped_column(String(100))
    referrer_host: Mapped[str | None] = mapped_column(String(255))  # host only; full referrer URLs can contain search terms
    # influencer attribution (first click, own window); all three null for non-referred visitors
    influencer_id: Mapped[int | None] = mapped_column(ForeignKey("influencers.id"), index=True)
    campaign: Mapped[str | None] = mapped_column(String(64))
    attributed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attribution_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    influencer: Mapped[Influencer | None] = relationship()


class ReferralClick(Base):
    __tablename__ = "referral_clicks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    influencer_id: Mapped[int] = mapped_column(ForeignKey("influencers.id"), nullable=False)
    session_id: Mapped[int] = mapped_column(ForeignKey("visitor_sessions.id"), nullable=False, index=True)
    campaign: Mapped[str | None] = mapped_column(String(64))
    # True when the visitor already had a live attribution, so this click did not change it.
    kept_existing_attribution: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__ = (Index("ix_referral_clicks_influencer_created", "influencer_id", "created_at"),)


class BookingAttribution(Timestamps, GeoSnapshot, Base):
    """One row per paid website booking (any acquisition source), frozen at payment confirmation; the geo columns are a copy of the session's snapshot so
    reporting stays stable even if session data is later purged."""
    __tablename__ = "booking_attributions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_ref: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    # null when the booking had no valid influencer attribution (most bookings)
    influencer_id: Mapped[int | None] = mapped_column(ForeignKey("influencers.id"))
    # null when the browser had no visitor session (storage blocked, API down at arrival)
    session_id: Mapped[int | None] = mapped_column(ForeignKey("visitor_sessions.id"))
    campaign: Mapped[str | None] = mapped_column(String(64))
    # copied from the session so reporting survives session expiry/purging
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown", server_default="unknown", index=True)
    utm_source: Mapped[str | None] = mapped_column(String(100))
    utm_medium: Mapped[str | None] = mapped_column(String(100))
    utm_campaign: Mapped[str | None] = mapped_column(String(100))
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
    influencer: Mapped[Influencer | None] = relationship()
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


# ---------- catalog & park configuration (milestone A) ----------
# Catalog rows keep the front-end's own shape in `data` (camelCase, as src/store.ts types it), so the pricing
# engine and the admin editors exchange the same objects. Columns that SQL must filter, lock or constrain are
# kept alongside and are authoritative over `data` (e.g. offers.redemptions).
class ParkSettings(Base):
    __tablename__ = "park_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[dict] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    __table_args__ = (CheckConstraint("id = 1", name="ck_park_settings_singleton"),)


class TicketCategory(Base):
    __tablename__ = "ticket_categories"
    id: Mapped[str] = mapped_column(String(16), primary_key=True)  # "ga", "gc", "fa", "fc"
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    daily_limit: Mapped[int] = mapped_column(Integer, nullable=False)
    data: Mapped[dict] = mapped_column(JSON, nullable=False)
    __table_args__ = (CheckConstraint("daily_limit >= 0", name="ck_ticket_category_limit"),)


class Addon(Base):
    __tablename__ = "addons"
    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    data: Mapped[dict] = mapped_column(JSON, nullable=False)


class Offer(Base):
    __tablename__ = "offers"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    coupon: Mapped[str | None] = mapped_column(String(32), unique=True)  # upper-case; NULL for automatic offers
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    max_redemptions: Mapped[int] = mapped_column(Integer, nullable=False)
    redemptions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    data: Mapped[dict] = mapped_column(JSON, nullable=False)
    __table_args__ = (
        CheckConstraint("status IN ('draft','scheduled','active','paused','expired')", name="ck_offer_status"),
        CheckConstraint("redemptions >= 0 AND max_redemptions >= 0", name="ck_offer_redemptions"),
    )


class ParkDate(Base):
    """Per-date overrides: closed, blackout, capacity, price adjustment, note (the prototype's dateCfg)."""
    __tablename__ = "park_dates"
    visit_date: Mapped[date] = mapped_column(Date, primary_key=True)
    data: Mapped[dict] = mapped_column(JSON, nullable=False)
