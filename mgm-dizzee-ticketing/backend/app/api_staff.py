"""Counter sales and gate scanning (staff roles only)."""
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import bookings, gate
from .api import cfg, get_db
from .api_booking import CustomerIn, run
from .api_shop import CartIn
from .auth import Actor, require_roles
from .models import GateScan

staff_api = APIRouter(prefix="/api")


class CounterSaleIn(BaseModel):
    visit_date: date
    cart: CartIn
    customer: CustomerIn
    method: Literal["Cash", "UPI", "Card"]


def counter_sale(db: Session, s, *, visit_date: str, cart: dict, customer: dict, method: str, actor: Actor, key: str | None):
    """Same engine as the website: server price, shared inventory, then the counter payment captured in the same
    transaction. Counter bookings have no visitor session, so they can never earn influencer commission."""
    b, created = bookings.create_booking(db, s, visit_date=visit_date, cart=cart, customer=customer, channel="counter",
                                         idempotency_key=key, created_by=actor.code)
    if b.status == "pending_payment":
        p = bookings.start_payment(db, b, "counter", method)
        bookings.capture_payment(db, s, payment_id=p.id, provider="counter", provider_payment_id=f"counter_{p.id}",
                                 amount=p.amount, event_id=f"counter:{p.id}", actor=actor.code)
    return b


@staff_api.post("/counter/sales", status_code=201)
def create_counter_sale(body: CounterSaleIn, db: Session = Depends(get_db), s=Depends(cfg),
                        a: Actor = Depends(require_roles("admin", "counter")), idempotency_key: str | None = Header(default=None, max_length=80)):
    args = dict(visit_date=body.visit_date.isoformat(), cart=body.cart.model_dump(), customer=body.customer.model_dump(),
                method=body.method, actor=a, key=idempotency_key)
    try:
        b = run(db, counter_sale, db, s, **args)
    except IntegrityError:
        db.rollback()
        b = run(db, counter_sale, db, s, **args)
    db.expire_all()
    return bookings.booking_dto(db, s, bookings.get_booking(db, b.ref))


class ScanIn(BaseModel):
    code: str = Field(min_length=1, max_length=200)
    device_id: str | None = Field(default=None, max_length=64)
    client_scan_id: str | None = Field(default=None, max_length=64)
    gate: str | None = Field(default=None, max_length=60)


@staff_api.post("/gate/scan")
def scan(body: ScanIn, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(require_roles("admin", "gate"))):
    return run(db, gate.scan, db, s, raw=body.code, gate=a.gate or body.gate or "Main Gate", staff_code=a.code,
               device_id=body.device_id, client_scan_id=body.client_scan_id)


@staff_api.get("/gate/scans")
def scans(day: date | None = Query(default=None, alias="date"), mine: bool = True, limit: int = Query(default=200, le=2000),
          db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(require_roles("admin", "gate"))):
    q = select(GateScan).order_by(GateScan.at.desc()).limit(limit)
    if mine:
        q = q.where(GateScan.staff_code == a.code)
    rows = [gate.scan_dto(x) for x in db.scalars(q)]
    # Scan times are real clock times; with DEMO_TODAY pinned they would never match the demo date, so the
    # default "today" filter applies only on the real clock.
    d = day.isoformat() if day else None if s.demo_today else bookings.today(s)
    return [r for r in rows if not d or r["at"][:10] == d]
