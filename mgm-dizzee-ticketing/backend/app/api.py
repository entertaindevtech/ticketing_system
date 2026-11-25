import hmac
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import analytics, services
from .geo import client_ip
from .models import BookingAttribution, Influencer, InfluencerCommission

PLATFORMS = ("Instagram", "YouTube", "Facebook", "X", "TikTok", "Blog", "Other")
BOOKING_REF = r"^[A-Z0-9][A-Z0-9-]{2,39}$"  # e.g. MGM-7TXBFB


# ---------- dependencies (overridable in tests) ----------
def get_db(request: Request):
    db = request.app.state.sessionmaker()
    try:
        yield db
    finally:
        db.close()


def cfg(request: Request):
    return request.app.state.settings


PLACEHOLDER_TOKENS = {"change-me-to-a-long-random-string", "changeme", "admin"}
MIN_TOKEN_LEN = 24


def require_admin(request: Request, x_admin_token: str | None = Header(default=None)):
    expected = request.app.state.settings.admin_api_token
    if not expected or len(expected) < MIN_TOKEN_LEN or expected in PLACEHOLDER_TOKENS:
        # Fail closed: a missing, short or copied-from-example token never opens the admin API.
        raise HTTPException(503, f"Admin API disabled: set ADMIN_API_TOKEN to a random secret of at least {MIN_TOKEN_LEN} characters")
    if not x_admin_token or not hmac.compare_digest(x_admin_token, expected):
        raise HTTPException(401, "Invalid admin token")


def require_events_token(request: Request, x_booking_events_token: str | None = Header(default=None)):
    expected = request.app.state.settings.booking_events_token
    if expected and not (x_booking_events_token and hmac.compare_digest(x_booking_events_token, expected)):
        raise HTTPException(401, "Invalid booking events token")


public = APIRouter(prefix="/api")
events = APIRouter(prefix="/api/booking-events", dependencies=[Depends(require_events_token)])
admin = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)])


# ---------- public: referral capture ----------
class ClickIn(BaseModel):
    code: str = Field(max_length=64)
    campaign: str | None = Field(default=None, max_length=128)
    session_token: str | None = Field(default=None, max_length=64)


@public.post("/referrals/click")
def referral_click(body: ClickIn, request: Request, db: Session = Depends(get_db)):
    s = request.app.state.settings
    ip = client_ip(request.headers.get("x-forwarded-for"), request.client.host if request.client else None, s.trusted_proxy_hops)
    try:
        r = services.record_click(db, s, request.app.state.geo, body.code, body.campaign, body.session_token, ip)
    except services.NotFound:
        raise HTTPException(404, "Unknown or inactive referral code")
    return {
        "session_token": r.session.token, "expires_at": r.session.expires_at.isoformat(),
        "attributed_code": r.session.influencer.referral_code, "kept_existing": r.kept_existing,
    }


# ---------- booking lifecycle (called by the booking flow / payment confirmation) ----------
class AmountsIn(BaseModel):
    tickets: int = Field(ge=0, le=10000)
    subtotal: Decimal = Field(ge=0, le=10_000_000)
    discount: Decimal = Field(ge=0, le=10_000_000)
    addons: Decimal = Field(ge=0, le=10_000_000)
    tax: Decimal = Field(ge=0, le=10_000_000)
    total: Decimal = Field(ge=0, le=10_000_000)
    visit_date: date | None = None

    @model_validator(mode="after")
    def _consistent(self):
        # Mirrors the app's pricing (store.ts priceCart): total = subtotal - discount + tax; add-ons are part of subtotal.
        if self.discount > self.subtotal or self.addons > self.subtotal:
            raise ValueError("discount and add-ons cannot exceed the subtotal")
        if abs(self.subtotal - self.discount + self.tax - self.total) > 1:
            raise ValueError("total must equal subtotal - discount + tax")
        return self

    def to_amounts(self):
        return services.BookingAmounts(**self.model_dump(include=set(AmountsIn.model_fields)))


class PaidIn(AmountsIn):
    booking_ref: str = Field(pattern=BOOKING_REF)
    session_token: str | None = Field(default=None, max_length=64)
    payment_status: str = Field(max_length=16)
    payment_ref: str | None = Field(default=None, max_length=80)
    paid_at: datetime | None = None


class ModifiedIn(AmountsIn):
    booking_ref: str = Field(pattern=BOOKING_REF)


class CancelledIn(BaseModel):
    booking_ref: str = Field(pattern=BOOKING_REF)
    reason: str | None = Field(default=None, max_length=255)


@events.post("/paid")
def booking_paid(body: PaidIn, db: Session = Depends(get_db), s=Depends(cfg)):
    attr = services.confirm_payment(db, s, body.booking_ref, body.session_token, body.payment_status,
                                    body.to_amounts(), body.payment_ref, body.paid_at)
    return {"attributed": attr is not None, "influencer_code": attr.influencer.referral_code if attr else None}


@events.post("/cancelled")
def booking_cancelled(body: CancelledIn, db: Session = Depends(get_db)):
    attr = services.cancel_booking(db, body.booking_ref, body.reason)
    return {"attributed": attr is not None, "status": attr.status if attr else None}


@events.post("/modified")
def booking_modified(body: ModifiedIn, db: Session = Depends(get_db), s=Depends(cfg)):
    attr = services.modify_booking(db, s, body.booking_ref, body.to_amounts())
    return {"attributed": attr is not None}


# ---------- admin: influencers ----------
class InfluencerIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    platform: Literal[PLATFORMS]  # type: ignore[valid-type]
    referral_code: str
    commission_rate: Decimal = Field(ge=0, le=100, decimal_places=2)
    handle: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=2000)
    active: bool = True

    @field_validator("referral_code")
    @classmethod
    def _code(cls, v: str) -> str:
        c = services.normalize_code(v)
        if not c:
            raise ValueError("Use 3-32 letters, digits, '-' or '_'")
        return c


class InfluencerPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    platform: Literal[PLATFORMS] | None = None  # type: ignore[valid-type]
    commission_rate: Decimal | None = Field(default=None, ge=0, le=100, decimal_places=2)
    handle: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=2000)
    active: bool | None = None
    # referral_code is deliberately not editable: links already shared must keep resolving to the same person.


def influencer_out(i: Influencer, base_url: str) -> dict:
    return {
        "id": i.id, "name": i.name, "platform": i.platform, "referral_code": i.referral_code,
        "referral_url": f"{base_url}/?ref={i.referral_code}", "commission_rate": float(i.commission_rate),
        "handle": i.handle, "email": i.email, "phone": i.phone, "notes": i.notes, "active": i.active,
        "created_at": i.created_at.isoformat() if i.created_at else None,
    }


@admin.get("/influencers")
def list_influencers(db: Session = Depends(get_db), s=Depends(cfg)):
    return [influencer_out(i, s.public_app_url) for i in db.scalars(select(Influencer).order_by(Influencer.name))]


@admin.post("/influencers", status_code=201)
def create_influencer(body: InfluencerIn, db: Session = Depends(get_db), s=Depends(cfg)):
    i = Influencer(**body.model_dump())
    db.add(i)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"Referral code {body.referral_code} is already in use")
    return influencer_out(i, s.public_app_url)


@admin.patch("/influencers/{influencer_id}")
def update_influencer(influencer_id: int, body: InfluencerPatch, db: Session = Depends(get_db), s=Depends(cfg)):
    i = db.get(Influencer, influencer_id)
    if not i:
        raise HTTPException(404, "Influencer not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None or k in ("handle", "email", "phone", "notes"):
            setattr(i, k, v)
    db.commit()
    return influencer_out(i, s.public_app_url)


# ---------- admin: commissions ----------
def commission_out(c: InfluencerCommission, with_events: bool = False) -> dict:
    a = c.attribution
    out = {
        "id": c.id, "influencer_id": c.influencer_id, "influencer": a.influencer.name, "referral_code": a.influencer.referral_code,
        "booking_ref": a.booking_ref, "booking_status": a.status, "campaign": a.campaign, "paid_at": a.paid_at.isoformat(),
        "visit_date": a.visit_date.isoformat() if a.visit_date else None, "tickets": a.tickets,
        "ticket_net_amount": float(a.ticket_net_amount), "addons_amount": float(a.addons_amount),
        "tax_amount": float(a.tax_amount), "total_amount": float(a.total_amount),
        "rate": float(c.rate), "basis": c.basis, "basis_amount": float(c.basis_amount), "amount": float(c.amount),
        "status": c.status, "approved_at": c.approved_at and c.approved_at.isoformat(), "paid_out_at": c.paid_at and c.paid_at.isoformat(),
        "payout_reference": c.payout_reference, "reversed_at": c.reversed_at and c.reversed_at.isoformat(), "reversal_reason": c.reversal_reason,
        "region": {"country_code": a.geo_country_code, "state": a.geo_region, "city": a.geo_city},
    }
    if with_events:
        out["events"] = [{"from": e.from_status, "to": e.to_status, "note": e.note, "at": e.created_at.isoformat()} for e in c.events]
    return out


_comm_load = (selectinload(InfluencerCommission.attribution).selectinload(BookingAttribution.influencer),)


@admin.get("/commissions")
def list_commissions(
    influencer_id: int | None = None, status: Literal["pending", "approved", "paid", "reversed"] | None = None,
    date_from: date | None = Query(default=None, alias="from"), date_to: date | None = Query(default=None, alias="to"),
    limit: int = Query(default=200, le=1000), db: Session = Depends(get_db),
):
    lo, hi = analytics._range(date_from, date_to)
    q = select(InfluencerCommission).join(BookingAttribution).options(*_comm_load).order_by(BookingAttribution.paid_at.desc()).limit(limit)
    if influencer_id:
        q = q.where(InfluencerCommission.influencer_id == influencer_id)
    if status:
        q = q.where(InfluencerCommission.status == status)
    q = q.where(*analytics._within(BookingAttribution.paid_at, lo, hi))
    return [commission_out(c) for c in db.scalars(q)]


@admin.get("/commissions/{commission_id}")
def get_commission(commission_id: int, db: Session = Depends(get_db)):
    c = db.scalar(select(InfluencerCommission).where(InfluencerCommission.id == commission_id).options(*_comm_load, selectinload(InfluencerCommission.events)))
    if not c:
        raise HTTPException(404, "Commission not found")
    return commission_out(c, with_events=True)


class PayoutIn(BaseModel):
    payout_reference: str = Field(min_length=2, max_length=120)


def _transition(fn, *args):
    try:
        return fn(*args)
    except services.NotFound as e:
        raise HTTPException(404, str(e))
    except services.InvalidTransition as e:
        raise HTTPException(409, str(e))


@admin.post("/commissions/{commission_id}/approve")
def approve(commission_id: int, db: Session = Depends(get_db)):
    _transition(services.approve_commission, db, commission_id)
    return get_commission(commission_id, db)


@admin.post("/commissions/{commission_id}/mark-paid")
def mark_paid(commission_id: int, body: PayoutIn, db: Session = Depends(get_db)):
    _transition(services.mark_commission_paid, db, commission_id, body.payout_reference)
    return get_commission(commission_id, db)


# ---------- admin: analytics ----------
@admin.get("/analytics")
def get_analytics(
    request: Request, influencer_id: int | None = None,
    date_from: date | None = Query(default=None, alias="from"), date_to: date | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
):
    data = analytics.compute(db, date_from, date_to, influencer_id)
    data["geoip_available"] = request.app.state.geo.available
    return data
