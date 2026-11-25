"""Referral attribution and commission engine."""
import re
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .geo import GeoLookup
from .models import (
    BookingAttribution, CommissionEvent, Influencer, InfluencerCommission, ReferralClick, ReferralSession, as_utc, utcnow,
)

CODE_RE = re.compile(r"^[A-Z0-9_-]{3,32}$")
CAMPAIGN_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
CENT = Decimal("0.01")


class NotFound(Exception):
    pass


class InvalidTransition(Exception):
    pass


def normalize_code(code: str | None) -> str | None:
    c = (code or "").strip().upper()
    return c if CODE_RE.match(c) else None


def normalize_campaign(campaign: str | None) -> str | None:
    c = (campaign or "").strip().lower()
    return c if CAMPAIGN_RE.match(c) else None  # invalid campaign tags are dropped, the click still counts


@dataclass
class ClickResult:
    session: ReferralSession
    kept_existing: bool


def record_click(db: Session, cfg: Settings, geo: GeoLookup, code: str | None, campaign: str | None,
                 existing_token: str | None, ip: str | None) -> ClickResult:
    norm = normalize_code(code)
    influencer = norm and db.scalar(select(Influencer).where(Influencer.referral_code == norm, Influencer.active.is_(True)))
    if not influencer:
        raise NotFound("Unknown or inactive referral code")
    campaign = normalize_campaign(campaign)
    now = utcnow()

    existing = None
    if existing_token and cfg.attribution_model == "first_click":
        s = db.scalar(select(ReferralSession).where(ReferralSession.token == existing_token))
        if s and as_utc(s.expires_at) > now:
            existing = s

    if existing:
        session = existing
    else:
        session = ReferralSession(
            token=secrets.token_urlsafe(32), influencer_id=influencer.id, campaign=campaign, created_at=now,
            expires_at=now + timedelta(days=cfg.attribution_window_days), **geo.lookup(ip),
        )
        db.add(session)
        db.flush()
    db.add(ReferralClick(influencer_id=influencer.id, session_id=session.id, campaign=campaign,
                         kept_existing_attribution=existing is not None, created_at=now))
    db.commit()
    return ClickResult(session=session, kept_existing=existing is not None)


@dataclass
class BookingAmounts:
    tickets: int
    subtotal: Decimal
    discount: Decimal
    addons: Decimal
    tax: Decimal
    total: Decimal
    visit_date: date | None = None

    @property
    def ticket_net(self) -> Decimal:
        # The app's subtotal = ticket gross + add-ons; discounts (offers, coupons) apply to tickets only.
        return max(Decimal(0), self.subtotal - self.discount - self.addons)


def commission_basis(cfg: Settings, a: BookingAmounts) -> Decimal:
    if cfg.commission_basis == "total_ex_gst":
        return a.ticket_net + a.addons
    return a.ticket_net


def _amount(basis: Decimal, rate: Decimal) -> Decimal:
    return (basis * rate / 100).quantize(CENT, rounding=ROUND_HALF_UP)


def _event(db: Session, c: InfluencerCommission, from_status: str | None, note: str | None = None):
    db.add(CommissionEvent(commission_id=c.id, from_status=from_status, to_status=c.status, note=note))


def confirm_payment(db: Session, cfg: Settings, booking_ref: str, session_token: str | None, payment_status: str,
                    amounts: BookingAmounts, payment_ref: str | None = None,
                    paid_at: datetime | None = None) -> BookingAttribution | None:
    """Attach the referral to a booking once its payment is confirmed. Idempotent per booking_ref.

    Returns None when nothing is attributable (unpaid, no/expired referral session)."""
    if payment_status != "paid":
        return None
    existing = db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == booking_ref))
    if existing:
        return existing  # repeated callback: never a second attribution or commission
    if not session_token:
        return None
    session = db.scalar(select(ReferralSession).where(ReferralSession.token == session_token))
    if not session:
        return None
    now = utcnow()
    # A delayed (retried) event may report the real payment time; never trust it beyond [session start, now].
    paid = min(max(as_utc(paid_at), as_utc(session.created_at)), now) if paid_at else now
    if paid > as_utc(session.expires_at):
        return None
    influencer = db.get(Influencer, session.influencer_id)

    attr = BookingAttribution(
        booking_ref=booking_ref, influencer_id=influencer.id, session_id=session.id, campaign=session.campaign,
        payment_ref=payment_ref, paid_at=paid, visit_date=amounts.visit_date, tickets=amounts.tickets,
        ticket_net_amount=amounts.ticket_net, addons_amount=amounts.addons, tax_amount=amounts.tax,
        total_amount=amounts.total, status="paid",
        geo_country_code=session.geo_country_code, geo_country=session.geo_country,
        geo_region=session.geo_region, geo_city=session.geo_city,
    )
    db.add(attr)
    try:
        db.flush()
    except IntegrityError:  # a concurrent duplicate callback won the race
        db.rollback()
        return db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == booking_ref))
    basis = commission_basis(cfg, amounts)
    c = InfluencerCommission(
        booking_attribution_id=attr.id, influencer_id=influencer.id, rate=influencer.commission_rate,
        basis=cfg.commission_basis, basis_amount=basis, amount=_amount(basis, Decimal(influencer.commission_rate)),
        status="pending",
    )
    db.add(c)
    db.flush()
    _event(db, c, None, f"Created on payment {payment_ref or ''}".strip())
    db.commit()
    return attr


def cancel_booking(db: Session, booking_ref: str, reason: str | None) -> BookingAttribution | None:
    attr = db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == booking_ref))
    if not attr or attr.status == "cancelled":
        return attr
    attr.status = "cancelled"
    attr.cancelled_at = utcnow()
    c = attr.commission
    if c and c.status != "reversed":
        prev = c.status
        c.status, c.reversed_at, c.reversal_reason = "reversed", utcnow(), (reason or "Booking cancelled / refunded")[:255]
        note = "Booking cancelled/refunded" + (" - commission was already paid out; recover from influencer" if prev == "paid" else "")
        _event(db, c, prev, note)
    db.commit()
    return attr


def modify_booking(db: Session, cfg: Settings, booking_ref: str, amounts: BookingAmounts) -> BookingAttribution | None:
    """Update an attributed booking's amounts without ever creating a second commission."""
    attr = db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == booking_ref))
    if not attr or attr.status != "paid":
        return attr
    attr.tickets, attr.visit_date = amounts.tickets, amounts.visit_date
    attr.ticket_net_amount, attr.addons_amount = amounts.ticket_net, amounts.addons
    attr.tax_amount, attr.total_amount = amounts.tax, amounts.total
    c = attr.commission
    if c and c.status == "pending":
        basis = commission_basis(cfg, amounts)
        new_amount = _amount(basis, Decimal(c.rate))  # keep the original rate snapshot
        if new_amount != c.amount:
            old = c.amount
            c.basis_amount, c.amount = basis, new_amount
            _event(db, c, "pending", f"Booking modified: amount {old} -> {new_amount}")
    elif c:
        _event(db, c, c.status, "Booking modified after approval; commission amount unchanged - review manually")
    db.commit()
    return attr


def approve_commission(db: Session, commission_id: int) -> InfluencerCommission:
    c = db.get(InfluencerCommission, commission_id)
    if not c:
        raise NotFound("Commission not found")
    if c.status != "pending":
        raise InvalidTransition(f"Only pending commissions can be approved (current: {c.status})")
    c.status, c.approved_at = "approved", utcnow()
    _event(db, c, "pending")
    db.commit()
    return c


def mark_commission_paid(db: Session, commission_id: int, payout_reference: str) -> InfluencerCommission:
    """Records that MGM settled this commission outside the system. No money is moved here."""
    c = db.get(InfluencerCommission, commission_id)
    if not c:
        raise NotFound("Commission not found")
    if c.status != "approved":
        raise InvalidTransition(f"Only approved commissions can be marked paid (current: {c.status})")
    c.status, c.paid_at, c.payout_reference = "paid", utcnow(), payout_reference
    _event(db, c, "approved", f"Payout reference {payout_reference}")
    db.commit()
    return c
