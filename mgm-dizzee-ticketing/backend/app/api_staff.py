"""Counter sales and gate scanning (staff roles only)."""
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import bookings, gate
from .api import cfg, get_db
from .api_booking import CustomerIn, run
from .api_shop import CartIn
from .auth import Actor, require_roles
from .models import GateScan, Ticket

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


class BookingCodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=200)
    gate: str | None = Field(default=None, max_length=60)


class AdmitIn(BookingCodeIn):
    quantities: dict[str, int] = Field(max_length=20)
    device_id: str | None = Field(default=None, max_length=64)
    client_txn_id: str | None = Field(default=None, max_length=64)


class CorrectionIn(BaseModel):
    quantities: dict[str, int] = Field(max_length=20)
    reason: str = Field(min_length=1, max_length=255)


@staff_api.post("/gate/booking")
def booking_lookup(body: BookingCodeIn, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(require_roles("admin", "gate"))):
    """Group admission, step 1: what this booking QR allows today. Admits no one."""
    return run(db, gate.lookup, db, s, raw=body.code, gate=a.gate or body.gate or "Main Gate", staff_code=a.code)


@staff_api.post("/gate/booking/admit")
def booking_admit(body: AdmitIn, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(require_roles("admin", "gate"))):
    """Group admission, step 2: admit the selected number of people per ticket category, atomically."""
    args = dict(raw=body.code, quantities=body.quantities, gate=a.gate or body.gate or "Main Gate", staff_code=a.code,
                device_id=body.device_id, client_txn_id=body.client_txn_id)
    try:
        return run(db, gate.admit, db, s, **args)
    except IntegrityError:  # the same client transaction id raced in: return the stored outcome
        db.rollback()
        return run(db, gate.admit, db, s, **args)


@staff_api.post("/gate/admissions/{ref}/correct")
def correct_admission(ref: str, body: CorrectionIn, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(require_roles("admin"))):
    """Supervisor (admin) only: un-admit people from one admission transaction, with a reason. History is kept."""
    return run(db, gate.correct, db, s, admission_ref=ref, quantities=body.quantities, reason=body.reason, staff_code=a.code)


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


@staff_api.get("/gate/summary")
def scan_summary(db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(require_roles("admin", "gate"))):
    """This staff member's day: admission transactions (one per ticket scan or group admission), people currently
    admitted by them (a supervisor correction lowers it), and rejected scans."""
    rows = scans(day=None, mine=True, limit=2000, db=db, s=s, a=a)
    people = db.scalar(select(func.count()).select_from(Ticket).where(
        Ticket.used_by == a.code, Ticket.status == "used", Ticket.visit_date == date.fromisoformat(bookings.today(s))))
    return {"admissions": sum(r["result"] == "valid" for r in rows), "people": people,
            "rejected": sum(r["result"] != "valid" for r in rows)}
