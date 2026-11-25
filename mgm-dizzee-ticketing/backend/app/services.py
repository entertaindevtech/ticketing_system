"""Visitor sessions, influencer attribution and the commission engine."""
import re
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .acquisition import classify, referrer_host
from .geo import GeoLookup
from .models import (
    BookingAttribution, CommissionEvent, Influencer, InfluencerCommission, ReferralClick, VisitorSession, as_utc, utcnow,
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


UTM_KEYS = ("utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term")


def _clean(v: str | None) -> str | None:
    v = (v or "").strip().lower()[:100]
    return v or None


@dataclass
class VisitResult:
    session: VisitorSession
    created: bool
    kept_existing: bool  # a referral click arrived while another attribution was live, so it changed nothing


def record_visit(db: Session, cfg: Settings, geo: GeoLookup, *, existing_token: str | None, ip: str | None,
                 ref: str | None = None, campaign: str | None = None, utm: dict | None = None,
                 click_ids: set[str] | None = None, referrer: str | None = None, own_hosts: set[str] = frozenset()) -> VisitResult:
    """Get or create the visitor's session; record an influencer click if a valid ?ref is present.

    New sessions get one GeoIP lookup and a first-touch acquisition source. An existing live session keeps
    its source, geography and any live influencer attribution (first click wins)."""
    now = utcnow()
    session = None
    if existing_token:
        s = db.scalar(select(VisitorSession).where(VisitorSession.token == existing_token))
        if s and as_utc(s.expires_at) > now:
            session = s
    norm = normalize_code(ref)
    influencer = db.scalar(select(Influencer).where(Influencer.referral_code == norm, Influencer.active.is_(True))) if norm else None
    utm = {k: _clean((utm or {}).get(k)) for k in UTM_KEYS}
    campaign = normalize_campaign(campaign) or normalize_campaign(utm["utm_campaign"])

    created = session is None
    if created:
        host = referrer_host(referrer)
        session = VisitorSession(
            token=secrets.token_urlsafe(32), created_at=now, expires_at=now + timedelta(days=cfg.visitor_session_days),
            source=classify(influencer=influencer is not None, utm=utm, click_ids=click_ids or set(), ref_host=host, own_hosts=own_hosts),
            referrer_host=host, **utm, **geo.lookup(ip),
        )
        db.add(session)

    kept = False
    if influencer:
        live = session.influencer_id is not None and as_utc(session.attribution_expires_at) > now
        if live and cfg.attribution_model == "first_click":
            kept = True
        else:
            session.influencer_id, session.campaign = influencer.id, campaign
            session.attributed_at, session.attribution_expires_at = now, now + timedelta(days=cfg.attribution_window_days)
            session.expires_at = max(as_utc(session.expires_at), session.attribution_expires_at)
        db.flush()
        db.add(ReferralClick(influencer_id=influencer.id, session_id=session.id, campaign=campaign,
                             kept_existing_attribution=kept, created_at=now))
    db.commit()
    return VisitResult(session=session, created=created, kept_existing=kept)


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
    """Record a paid website booking with its session's region and source. Idempotent per booking_ref.

    A commission is created only if the session holds a live influencer attribution at payment time.
    Returns None only for unpaid events."""
    if payment_status != "paid":
        return None
    existing = db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == booking_ref))
    if existing:
        return existing  # repeated callback: never a second record or commission
    session = db.scalar(select(VisitorSession).where(VisitorSession.token == session_token)) if session_token else None
    now = utcnow()
    # A delayed (retried) event may report the real payment time; never trust it beyond [session start, now].
    paid = now
    if paid_at:
        paid = min(max(as_utc(paid_at), as_utc(session.created_at)) if session else as_utc(paid_at), now)

    influencer = None
    if session and session.influencer_id and as_utc(session.attributed_at) <= paid <= as_utc(session.attribution_expires_at):
        # A real visitor rarely makes more than a few bookings; cap how far one (possibly leaked) token can earn commission.
        used = db.scalar(select(func.count()).select_from(BookingAttribution).where(
            BookingAttribution.session_id == session.id, BookingAttribution.influencer_id.is_not(None)))
        if used < cfg.max_bookings_per_session:
            influencer = db.get(Influencer, session.influencer_id)

    snap = {k: getattr(session, k) if session else None for k in
            ("geo_country_code", "geo_country", "geo_region", "geo_city", "utm_source", "utm_medium", "utm_campaign")}
    attr = BookingAttribution(
        booking_ref=booking_ref, influencer_id=influencer.id if influencer else None, session_id=session.id if session else None,
        campaign=session.campaign if influencer else None, source=session.source if session else "unknown",
        payment_ref=payment_ref, paid_at=paid, visit_date=amounts.visit_date, tickets=amounts.tickets,
        ticket_net_amount=amounts.ticket_net, addons_amount=amounts.addons, tax_amount=amounts.tax,
        total_amount=amounts.total, status="paid", **snap,
    )
    db.add(attr)
    try:
        db.flush()
    except IntegrityError:  # a concurrent duplicate callback won the race
        db.rollback()
        return db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == booking_ref))
    if not influencer:
        db.commit()
        return attr
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
