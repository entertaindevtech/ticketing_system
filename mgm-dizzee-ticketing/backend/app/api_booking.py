"""Customer booking API: create a booking, pay (simulated provider for now), view it with its access token."""
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import bookings, security
from .api import cfg, get_db
from .api_shop import CartIn

booking_api = APIRouter(prefix="/api")
EMAIL = r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}$"


class CustomerIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    phone: str = Field(pattern=bookings.PHONE_RE)
    email: str | None = Field(default=None, max_length=200, pattern=EMAIL)
    notes: str | None = Field(default=None, max_length=500)


class BookingIn(BaseModel):
    visit_date: date
    cart: CartIn
    customer: CustomerIn
    session_token: str | None = Field(default=None, max_length=64)


class PayIn(BaseModel):
    method: str = Field(default="UPI", max_length=32)


class SimulateIn(BaseModel):
    outcome: Literal["success", "decline"]


def run(db: Session, fn, *args, **kw):
    """Run one booking-engine operation as one transaction; map engine errors to HTTP errors."""
    try:
        out = fn(*args, **kw)
        db.commit()
        return out
    except bookings.BookingError as e:
        db.rollback()
        raise HTTPException(e.status, str(e))


def access(ref: str, token: str | None, db: Session, s) -> bookings.Booking:
    # Same answer for an unknown booking and a wrong token, so references can't be probed.
    if not security.check_access(s.app_secret, ref, token):
        raise HTTPException(404, "Booking not found")
    return bookings.get_booking(db, ref)


def created_out(db, s, b) -> dict:
    tok = security.access_token(s.app_secret, b.ref)
    return {"booking": bookings.booking_dto(db, s, b), "accessToken": tok, "accessUrl": f"{s.public_app_url}/customer#booking/{b.ref}/{tok}"}


@booking_api.post("/bookings", status_code=201)
def create(body: BookingIn, db: Session = Depends(get_db), s=Depends(cfg),
           idempotency_key: str | None = Header(default=None, max_length=80)):
    args = dict(visit_date=body.visit_date.isoformat(), cart=body.cart.model_dump(), customer=body.customer.model_dump(),
                session_token=body.session_token, idempotency_key=idempotency_key)
    try:
        b, _ = run(db, bookings.create_booking, db, s, **args)
    except IntegrityError:  # the same Idempotency-Key raced in concurrently: return the winner's booking
        db.rollback()
        b, _ = run(db, bookings.create_booking, db, s, **args)
    return created_out(db, s, b)


@booking_api.get("/bookings/{ref}")
def get(ref: str, db: Session = Depends(get_db), s=Depends(cfg), x_booking_token: str | None = Header(default=None)):
    b = access(ref, x_booking_token, db, s)
    if b.status == "pending_payment":
        run(db, bookings.expire_holds, db, b.visit_date.isoformat())
        db.refresh(b)
    return bookings.booking_dto(db, s, b)


@booking_api.post("/bookings/{ref}/payments", status_code=201)
def start_payment(ref: str, body: PayIn, db: Session = Depends(get_db), s=Depends(cfg), x_booking_token: str | None = Header(default=None)):
    b = access(ref, x_booking_token, db, s)
    provider = "simulated" if s.simulated_payments else None
    if not provider:
        raise HTTPException(503, "Online payment is not available yet")
    p = run(db, bookings.start_payment, db, b, provider, body.method)
    return {"payment_id": p.id, "provider": p.provider, "order_id": p.provider_order_id, "amount": float(p.amount), "currency": "INR"}


@booking_api.post("/bookings/{ref}/payments/{payment_id}/simulate")
def simulate(ref: str, payment_id: int, body: SimulateIn, db: Session = Depends(get_db), s=Depends(cfg),
             x_booking_token: str | None = Header(default=None)):
    """Demo payment provider. Disabled unless SIMULATED_PAYMENTS is on; it goes through the same capture path a
    verified gateway webhook will use, and the amount comes from the server's own payment record."""
    if not s.simulated_payments:
        raise HTTPException(404, "Not found")
    b = access(ref, x_booking_token, db, s)
    p = next((x for x in b.payments if x.id == payment_id), None)
    if not p:
        raise HTTPException(404, "Payment not found")
    if body.outcome == "decline":
        run(db, bookings.fail_payment, db, payment_id=p.id, provider="simulated", event_id=f"sim:{p.id}:declined", reason="Declined (simulated)")
    else:
        run(db, bookings.capture_payment, db, s, payment_id=p.id, provider="simulated", provider_payment_id=f"simpay_{p.id}",
            amount=p.amount, event_id=f"sim:{p.id}:captured")
    db.expire_all()
    return bookings.booking_dto(db, s, bookings.get_booking(db, ref))
