"""Staff booking management: list/view bookings, cancellation decisions, admin cancel, modifications,
refunds and price differences. Every action is role-checked and audited."""
from datetime import date

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from . import bookings, lifecycle
from .api import cfg, get_db
from .api_booking import access, run
from .auth import Actor, require_roles
from .models import Booking

staff_bookings = APIRouter(prefix="/api/admin")
customer_lifecycle = APIRouter(prefix="/api")
FINANCE = require_roles("admin", "finance")


@customer_lifecycle.post("/bookings/{ref}/cancellation-request", status_code=201)
def customer_cancellation(ref: str, db: Session = Depends(get_db), s=Depends(cfg), x_booking_token: str | None = Header(default=None)):
    """Customer asks to cancel (access token required). The booking stays valid until an admin decides."""
    access(ref, x_booking_token, db, s)
    run(db, lifecycle.request_cancellation, db, s, ref)
    db.expire_all()
    return bookings.booking_dto(db, s, bookings.get_booking(db, ref))


class ReasonIn(BaseModel):
    reason: str = Field(min_length=3, max_length=255)


class ModifyIn(BaseModel):
    visit_date: date
    tickets: dict[str, int] = Field(default_factory=dict, max_length=20)
    addons: dict[str, int] = Field(default_factory=dict, max_length=20)
    dry_run: bool = False


class CollectIn(BaseModel):
    method: str = Field(default="Cash", max_length=32)


@staff_bookings.get("/bookings")
def list_bookings(date_from: date | None = Query(default=None, alias="from"), date_to: date | None = Query(default=None, alias="to"),
                  q: str | None = Query(default=None, max_length=60), limit: int = Query(default=500, le=5000),
                  db: Session = Depends(get_db), s=Depends(cfg), _: Actor = Depends(require_roles("admin", "finance", "counter"))):
    """Bookings by visit date (default: everything), newest first. Staff only: contains customer details."""
    stmt = select(Booking).order_by(Booking.created_at.desc()).limit(limit)
    if date_from:
        stmt = stmt.where(Booking.visit_date >= date_from)
    if date_to:
        stmt = stmt.where(Booking.visit_date <= date_to)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Booking.ref.ilike(like), Booking.name.ilike(like), Booking.phone.ilike(like)))
    return [bookings.booking_dto(db, s, b, with_qr=False) for b in db.scalars(stmt)]


@staff_bookings.get("/bookings/{ref}")
def get_booking(ref: str, db: Session = Depends(get_db), s=Depends(cfg), _: Actor = Depends(require_roles("admin", "finance", "counter"))):
    try:
        return bookings.booking_dto(db, s, bookings.get_booking(db, ref))
    except bookings.NotFound:
        raise HTTPException(404, "Booking not found")


def _after(db, s, ref):
    db.expire_all()
    return bookings.booking_dto(db, s, bookings.get_booking(db, ref), with_qr=False)


@staff_bookings.post("/bookings/{ref}/cancellation/approve")
def approve(ref: str, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(FINANCE)):
    run(db, lifecycle.approve_cancellation, db, s, ref, a.code)
    return _after(db, s, ref)


@staff_bookings.post("/bookings/{ref}/cancellation/reject")
def reject(ref: str, body: ReasonIn, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(FINANCE)):
    run(db, lifecycle.reject_cancellation, db, s, ref, body.reason, a.code)
    return _after(db, s, ref)


@staff_bookings.post("/bookings/{ref}/cancel")
def cancel(ref: str, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(FINANCE)):
    run(db, lifecycle.admin_cancel, db, s, ref, a.code)
    return _after(db, s, ref)


@staff_bookings.post("/bookings/{ref}/modify")
def modify(ref: str, body: ModifyIn, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(FINANCE)):
    try:
        out = lifecycle.modify_booking(db, s, ref, body.visit_date.isoformat(), body.tickets, body.addons, a.code)
    except bookings.BookingError as e:
        db.rollback()
        raise HTTPException(e.status, str(e))
    if body.dry_run:
        db.rollback()
        return {**out, "dryRun": True}
    db.commit()
    return {**out, "booking": _after(db, s, ref)}


@staff_bookings.post("/refunds/{refund_id}/process")
def process_refund(refund_id: int, db: Session = Depends(get_db), a: Actor = Depends(FINANCE)):
    r = run(db, lifecycle.process_refund, db, refund_id, a.code)
    return {"id": r.id, "status": r.status}


@staff_bookings.post("/payments/{payment_id}/collect")
def collect(payment_id: int, body: CollectIn, db: Session = Depends(get_db), a: Actor = Depends(require_roles("admin", "finance", "counter"))):
    p = run(db, lifecycle.collect_difference, db, payment_id, body.method, a.code)
    return {"id": p.id, "status": p.status}
