"""Database schema: catalog and park configuration, the booking ledger (customers, bookings, tickets, inventory,
payments, refunds, lifecycle records), staff accounts, gate scans, and the influencer & regional intelligence tables.

PostgreSQL is the source of truth for all of it. booking_attributions freezes each paid website booking's
region / acquisition source / influencer at payment time for historical reporting.
"""
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    JSON, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, LargeBinary, Numeric, String, Text, func, text,
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
    # Set for every booking captured by the booking engine; NULL only for rows reported by the retired browser events.
    booking_id: Mapped[int | None] = mapped_column(ForeignKey("bookings.id"), unique=True)
    channel: Mapped[str] = mapped_column(String(8), nullable=False, default="web", server_default="web")  # web | counter
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


# ---------- booking ledger (milestone B) ----------
class Customer(Timestamps, Base):
    __tablename__ = "customers"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    phone: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)  # 10-digit Indian mobile
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str | None] = mapped_column(String(200))
    phone_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # set once OTP exists


class Booking(Timestamps, Base):
    __tablename__ = "bookings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ref: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)  # MGM-XXXXXX, server-generated
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), nullable=False, index=True)
    channel: Mapped[str] = mapped_column(String(8), nullable=False)  # web | counter
    origin: Mapped[str] = mapped_column(String(16), nullable=False, default="live", server_default="live")  # live | legacy_import | demo_seed
    visit_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    # customer snapshot at booking time
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    phone: Mapped[str] = mapped_column(String(16), nullable=False)
    email: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(String(500))
    # priced totals (server-computed)
    subtotal: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    discount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    addons_total: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    tax: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    total: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    complimentary: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    coupon: Mapped[str | None] = mapped_column(String(32))
    offer_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    units: Mapped[list] = mapped_column(JSON, nullable=False)  # admissions to issue on payment [{catId,label,offerId,complimentary}]
    hold_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    modified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    visitor_session_id: Mapped[int | None] = mapped_column(ForeignKey("visitor_sessions.id"))
    created_by: Mapped[str | None] = mapped_column(String(32))  # staff code for counter/admin actions
    idempotency_key: Mapped[str | None] = mapped_column(String(80), unique=True)
    request_sha256: Mapped[str | None] = mapped_column(String(64))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    customer: Mapped[Customer] = relationship()
    items: Mapped[list["BookingItem"]] = relationship(order_by="BookingItem.id", cascade="all, delete-orphan")
    tickets: Mapped[list["Ticket"]] = relationship(order_by="Ticket.id")
    payments: Mapped[list["Payment"]] = relationship(order_by="Payment.id")
    __table_args__ = (
        CheckConstraint("status IN ('pending_payment','confirmed','cancelled','expired')", name="ck_booking_status"),
        CheckConstraint("channel IN ('web','counter')", name="ck_booking_channel"),
        CheckConstraint("channel = 'web' OR visitor_session_id IS NULL", name="ck_counter_no_session"),
        CheckConstraint("total >= 0 AND subtotal >= 0 AND tax >= 0", name="ck_booking_amounts"),
    )


class BookingItem(Base):
    __tablename__ = "booking_items"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)  # ticket | offer | addon
    ref_id: Mapped[str] = mapped_column(String(32), nullable=False)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    detail: Mapped[str | None] = mapped_column(String(200))
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    unit: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    original: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    __table_args__ = (CheckConstraint("qty > 0", name="ck_item_qty"), CheckConstraint("kind IN ('ticket','offer','addon')", name="ck_item_kind"))


class Ticket(Base):
    __tablename__ = "tickets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)  # TKT-XXXXXXXX (printed / in the QR)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id"), nullable=False, index=True)
    category_id: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    visit_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="issued")  # issued | used | void
    complimentary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    offer_id: Mapped[str | None] = mapped_column(String(32))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    used_gate: Mapped[str | None] = mapped_column(String(60))
    used_by: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__ = (
        CheckConstraint("status IN ('issued','used','void')", name="ck_ticket_status"),
        CheckConstraint("status <> 'used' OR used_at IS NOT NULL", name="ck_ticket_used_at"),
        Index("ix_tickets_visit_status", "visit_date", "status"),
    )


class DateInventory(Base):
    """Park-wide admissions per visit date. held = reserved by unpaid bookings; sold = paid."""
    __tablename__ = "date_inventory"
    visit_date: Mapped[date] = mapped_column(Date, primary_key=True)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    held: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sold: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    __table_args__ = (CheckConstraint("held >= 0 AND sold >= 0 AND held + sold <= capacity", name="ck_date_inventory"),)


class CategoryInventory(Base):
    __tablename__ = "category_inventory"
    visit_date: Mapped[date] = mapped_column(Date, primary_key=True)
    category_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    held: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sold: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    __table_args__ = (CheckConstraint("held >= 0 AND sold >= 0 AND held + sold <= capacity", name="ck_category_inventory"),)


class Payment(Base):
    __tablename__ = "payments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(12), nullable=False, default="charge")  # charge | difference
    provider: Mapped[str] = mapped_column(String(16), nullable=False)  # simulated | counter | razorpay | legacy
    method: Mapped[str | None] = mapped_column(String(32))
    provider_order_id: Mapped[str | None] = mapped_column(String(80))
    provider_payment_id: Mapped[str | None] = mapped_column(String(80))
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="created")
    failure_reason: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint("status IN ('created','captured','failed','refunded','partially_refunded')", name="ck_payment_status"),
        CheckConstraint("amount >= 0", name="ck_payment_amount"),
        Index("uq_payment_provider_payment", "provider", "provider_payment_id", unique=True),
    )


class PaymentEvent(Base):
    """Every payment-provider event processed (simulated now, verified gateway webhooks later). The unique
    (provider, event_id) makes replays and concurrent duplicates no-ops."""
    __tablename__ = "payment_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    event_id: Mapped[str] = mapped_column(String(120), nullable=False)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    payment_id: Mapped[int | None] = mapped_column(ForeignKey("payments.id"))
    payload_sha256: Mapped[str | None] = mapped_column(String(64))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__ = (Index("uq_payment_event", "provider", "event_id", unique=True),)


class AuditLog(Base):
    """Append-only record of every booking, payment, refund, scan and admin change (who, what, when)."""
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    actor: Mapped[str] = mapped_column(String(60), nullable=False)  # "Customer", "System", or a staff code
    type: Mapped[str] = mapped_column(String(24), nullable=False)
    ref: Mapped[str | None] = mapped_column(String(40), index=True)
    message: Mapped[str] = mapped_column(String(500), nullable=False)
    details: Mapped[dict | None] = mapped_column(JSON)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(24), nullable=False)
    ref: Mapped[str | None] = mapped_column(String(40))
    message: Mapped[str] = mapped_column(String(500), nullable=False)
    read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


# ---------- booking lifecycle (milestone C) ----------
class CancellationRequest(Base):
    __tablename__ = "cancellation_requests"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id"), nullable=False, index=True)
    requested_by: Mapped[str] = mapped_column(String(16), nullable=False)  # customer | admin
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    fee: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    refund_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    reason: Mapped[str | None] = mapped_column(String(255))
    rejection_reason: Mapped[str | None] = mapped_column(String(255))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[str | None] = mapped_column(String(32))
    __table_args__ = (
        CheckConstraint("status IN ('pending','approved','rejected')", name="ck_cancellation_status"),
        # at most one open request per booking
        Index("uq_cancellation_pending", "booking_id", unique=True, postgresql_where=text("status = 'pending'"), sqlite_where=text("status = 'pending'")),
    )


class Refund(Base):
    __tablename__ = "refunds"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id"), nullable=False, index=True)
    payment_id: Mapped[int] = mapped_column(ForeignKey("payments.id"), nullable=False)
    cancellation_request_id: Mapped[int | None] = mapped_column(ForeignKey("cancellation_requests.id"))
    modification_id: Mapped[int | None] = mapped_column(ForeignKey("booking_modifications.id"))
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    fee: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    provider_refund_id: Mapped[str | None] = mapped_column(String(80), unique=True)
    reason: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    processed_by: Mapped[str | None] = mapped_column(String(32))
    __table_args__ = (
        CheckConstraint("status IN ('pending','processing','succeeded','failed')", name="ck_refund_status"),
        CheckConstraint("amount > 0", name="ck_refund_amount"),
    )


class BookingModification(Base):
    __tablename__ = "booking_modifications"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    booking_id: Mapped[int] = mapped_column(ForeignKey("bookings.id"), nullable=False, index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    by: Mapped[str] = mapped_column(String(32), nullable=False)
    previous_visit_date: Mapped[date] = mapped_column(Date, nullable=False)
    visit_date: Mapped[date] = mapped_column(Date, nullable=False)
    previous_total: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    new_total: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    settlement: Mapped[str] = mapped_column(String(8), nullable=False)  # none | collect | refund
    before: Mapped[dict] = mapped_column(JSON, nullable=False)
    after: Mapped[dict] = mapped_column(JSON, nullable=False)


# ---------- gate (milestone D) ----------
class GateScan(Base):
    """Every scan attempt at a gate, valid or not. (device_id, client_scan_id) makes a scanner's network retry
    return the original result instead of counting twice."""
    __tablename__ = "gate_scans"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    ticket_id: Mapped[int | None] = mapped_column(ForeignKey("tickets.id"), index=True)
    ticket_code: Mapped[str | None] = mapped_column(String(20))
    booking_ref: Mapped[str | None] = mapped_column(String(16))
    gate: Mapped[str] = mapped_column(String(60), nullable=False)
    staff_code: Mapped[str] = mapped_column(String(32), nullable=False)
    device_id: Mapped[str | None] = mapped_column(String(64))
    client_scan_id: Mapped[str | None] = mapped_column(String(64))
    result: Mapped[str] = mapped_column(String(10), nullable=False)
    reason: Mapped[str] = mapped_column(String(200), nullable=False)
    __table_args__ = (
        CheckConstraint("result IN ('valid','duplicate','invalid')", name="ck_scan_result"),
        Index("uq_scan_client_id", "device_id", "client_scan_id", unique=True),
    )


# ---------- staff accounts (milestone E) ----------
class User(Timestamps, Base):
    """Staff / administrator account. roles: comma-separated subset of admin, finance, counter, gate, marketing."""
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)  # staff ID, e.g. STF1024
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(40))
    gate: Mapped[str | None] = mapped_column(String(60))
    roles: Mapped[str] = mapped_column(String(120), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)  # Argon2id
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    failed_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)  # SHA-256 of the cookie value
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class OfferImage(Base):
    """Optional banner image for an offer, kept in PostgreSQL (no separate file storage to provision or back up)."""
    __tablename__ = "offer_images"
    offer_id: Mapped[str] = mapped_column(ForeignKey("offers.id"), primary_key=True)
    content_type: Mapped[str] = mapped_column(String(16), nullable=False)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
