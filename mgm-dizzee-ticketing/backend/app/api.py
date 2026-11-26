from urllib.parse import urlsplit
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import analytics, services
from .auth import require_roles
from .geo import client_ip
from .models import BookingAttribution, Influencer, InfluencerCommission

PLATFORMS = ("Instagram", "YouTube", "Facebook", "X", "TikTok", "Blog", "Other")
EMAIL_RE = r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}$"
PHONE_RE = r"^\+?[0-9 ()-]{7,20}$"


# ---------- dependencies (overridable in tests) ----------
def get_db(request: Request):
    db = request.app.state.sessionmaker()
    try:
        yield db
    finally:
        db.close()


def cfg(request: Request):
    return request.app.state.settings


public = APIRouter(prefix="/api")
events = APIRouter(prefix="/api/booking-events")
# Influencer & regional intelligence screens: admins and marketing staff (or the break-glass ADMIN_API_TOKEN).
admin = APIRouter(prefix="/api/admin", dependencies=[Depends(require_roles("admin", "marketing"))])


# ---------- public: visitor sessions ----------
# shortcut: user-agent keyword match only; switch to a maintained bot list if crawler traffic shows up in analytics
BOT_HINTS = ("bot", "crawl", "spider", "slurp", "preview", "headless", "lighthouse", "facebookexternalhit", "curl", "python-requests")


class VisitIn(BaseModel):
    session_token: str | None = Field(default=None, max_length=64)
    ref: str | None = Field(default=None, max_length=64)
    campaign: str | None = Field(default=None, max_length=128)
    utm_source: str | None = Field(default=None, max_length=200)
    utm_medium: str | None = Field(default=None, max_length=200)
    utm_campaign: str | None = Field(default=None, max_length=200)
    utm_content: str | None = Field(default=None, max_length=200)
    utm_term: str | None = Field(default=None, max_length=200)
    click_ids: list[str] = Field(default_factory=list, max_length=5)  # names only (e.g. "gclid"), never their values
    referrer: str | None = Field(default=None, max_length=2000)


@public.post("/visits")
def visit(body: VisitIn, request: Request, db: Session = Depends(get_db)):
    """Get or create the anonymous visitor session (and record an influencer click when ?ref is valid)."""
    ua = (request.headers.get("user-agent") or "").lower()
    if not ua or any(h in ua for h in BOT_HINTS):
        return {"session_token": None, "tracked": False}
    s = request.app.state.settings
    ip = client_ip(request.headers.get("x-real-ip"), request.client.host if request.client else None, s.trusted_proxy_hops)
    own = {h for h in (urlsplit(s.public_app_url).hostname, request.url.hostname) if h}
    r = services.record_visit(
        db, s, request.app.state.geo, existing_token=body.session_token, ip=ip, ref=body.ref, campaign=body.campaign,
        utm={k: getattr(body, k) for k in services.UTM_KEYS}, click_ids=set(body.click_ids), referrer=body.referrer,
        own_hosts={h[4:] if h.startswith("www.") else h for h in own},
    )
    live = r.session.influencer_id and services.as_utc(r.session.attribution_expires_at) > services.utcnow()
    return {
        "tracked": True, "session_token": r.session.token, "expires_at": r.session.expires_at.isoformat(), "created": r.created,
        "source": r.session.source, "attributed_code": r.session.influencer.referral_code if live else None, "kept_existing": r.kept_existing,
    }


# ---------- retired: browser-reported booking events ----------
@events.api_route("/{kind}", methods=["POST"], include_in_schema=False)
def retired_booking_event(kind: str):
    """Old front-end builds reported payments from the browser. Bookings, payments, cancellations and changes are
    now recorded by the booking engine itself, so these reports are refused (and never trusted)."""
    raise HTTPException(410, "Booking events are recorded by the server; this endpoint is retired")


# ---------- admin: influencers ----------
class InfluencerIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    platform: Literal[PLATFORMS]  # type: ignore[valid-type]
    referral_code: str
    commission_rate: Decimal = Field(ge=0, le=100, decimal_places=2)
    handle: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=200, pattern=EMAIL_RE)
    phone: str | None = Field(default=None, max_length=40, pattern=PHONE_RE)
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
    email: str | None = Field(default=None, max_length=200, pattern=EMAIL_RE)
    phone: str | None = Field(default=None, max_length=40, pattern=PHONE_RE)
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
    limit: int = Query(default=200, ge=1, le=100_000), db: Session = Depends(get_db),
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


@admin.get("/regional")
def get_regional(
    request: Request,
    date_from: date | None = Query(default=None, alias="from"), date_to: date | None = Query(default=None, alias="to"),
    db: Session = Depends(get_db),
):
    """All website visitors and bookings by acquisition source and region (not just influencer traffic)."""
    data = analytics.compute_regional(db, date_from, date_to)
    data["geoip_available"] = request.app.state.geo.available
    return data
