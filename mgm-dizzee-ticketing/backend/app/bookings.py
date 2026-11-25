"""Booking engine: the only code that creates bookings, takes payment, issues tickets and changes a booking's state.

Every public function runs inside the caller's transaction and leaves commit/rollback to it (the API layer commits
once per request), so a failure at any step leaves no partial booking, ticket, inventory or commission change.

State machine (bookings.status):
    pending_payment --capture--> confirmed --cancel/approve refund--> cancelled
    pending_payment --hold expires--> expired
A pending cancellation request does not change the state; the booking stays valid until an admin decides.
"""
import hashlib
import json
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import catalog, inventory, pricing, security, services
from .config import Settings
from .models import (
    AuditLog, Booking, BookingItem, Customer, Notification, Offer, Payment, PaymentEvent, Ticket, VisitorSession, as_utc, utcnow,
)

PHONE_RE = r"^[6-9]\d{9}$"


class BookingError(Exception):
    status = 400


class NotFound(BookingError):
    status = 404


class Conflict(BookingError):
    status = 409


class Invalid(BookingError):
    status = 422


def ist(dt: datetime | None) -> str:
    """Local park time without offset, the format the front-end uses throughout (YYYY-MM-DDTHH:MM:SS)."""
    return as_utc(dt).astimezone(pricing.IST).strftime("%Y-%m-%dT%H:%M:%S") if dt else ""


def audit(db: Session, actor: str, type_: str, ref: str | None, message: str, details: dict | None = None, notify: bool = True):
    db.add(AuditLog(actor=actor[:60], type=type_, ref=ref, message=message[:500], details=details))
    if notify:
        db.add(Notification(type=type_, ref=ref, message=message[:500]))


def today(cfg: Settings) -> str:
    return pricing.today_ist(cfg.demo_today)


def get_booking(db: Session, ref: str, lock: bool = False) -> Booking:
    q = select(Booking).where(Booking.ref == ref)
    b = db.scalar(q.with_for_update() if lock else q)
    if not b:
        raise NotFound("Booking not found")
    return b


# ---------- offers ----------
def _take_redemptions(db: Session, offer_ids: list[str]):
    for oid in sorted(set(offer_ids)):
        r = db.execute(update(Offer).where(Offer.id == oid, Offer.redemptions < Offer.max_redemptions)
                       .values(redemptions=Offer.redemptions + 1).execution_options(synchronize_session=False))
        if r.rowcount != 1:
            raise Conflict("This offer has just sold out. Please choose another option.")


def _return_redemptions(db: Session, offer_ids: list[str]):
    for oid in sorted(set(offer_ids)):
        db.execute(update(Offer).where(Offer.id == oid, Offer.redemptions > 0).values(redemptions=Offer.redemptions - 1)
                   .execution_options(synchronize_session=False))


# ---------- holds ----------
def expire_holds(db: Session, visit_date: str | None = None, now: datetime | None = None) -> int:
    """Expire unpaid bookings whose hold ran out, releasing their stock and offer redemptions. Rows another
    transaction is working on (e.g. a payment being captured) are skipped, not waited for."""
    now = now or utcnow()
    q = select(Booking).where(Booking.status == "pending_payment", Booking.hold_expires_at < now)
    if visit_date:
        q = q.where(Booking.visit_date == date.fromisoformat(visit_date))
    n = 0
    for b in db.scalars(q.with_for_update(skip_locked=True)):
        inventory.release_hold(db, b.visit_date.isoformat(), b.units)
        _return_redemptions(db, b.offer_ids)
        b.status, b.version = "expired", b.version + 1
        for p in b.payments:
            if p.status == "created":
                p.status, p.failure_reason = "failed", "Payment window expired"
        audit(db, "System", "booking", b.ref, f"Booking {b.ref} expired unpaid; held tickets released", notify=False)
        n += 1
    return n


# ---------- creation ----------
def _request_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def _upsert_customer(db: Session, phone: str, name: str, email: str | None) -> Customer:
    c = db.scalar(select(Customer).where(Customer.phone == phone))
    if c:
        c.name, c.email = name, email or c.email
        return c
    try:
        with db.begin_nested():
            c = Customer(phone=phone, name=name, email=email)
            db.add(c)
    except IntegrityError:  # created concurrently by another booking for the same number
        c = db.scalar(select(Customer).where(Customer.phone == phone))
    return c


def _new_ref(db: Session, prefix: str, n: int, model, col) -> str:
    while True:
        ref = f"{prefix}-{security.random_code(n)}"
        if not db.scalar(select(model.id).where(col == ref)):
            return ref


def _amounts(priced: dict) -> dict:
    return {"subtotal": priced["subtotal"], "discount": priced["offerSavings"] + priced["couponDiscount"],
            "addons_total": priced["addonsTotal"], "tax": priced["tax"], "total": priced["total"], "complimentary": priced["complimentary"]}


def price_for_booking(db: Session, cfg: Settings, visit_date: str, cart: dict, *, allow_closed: bool = False) -> tuple[dict, dict, list]:
    ctx = catalog.load_ctx(db)
    priced = pricing.price_cart(cart, visit_date, ctx, today(cfg))
    status = pricing.date_status(visit_date, ctx, today(cfg))
    if not status["open"] and not allow_closed:
        raise Invalid(f"{visit_date} is not available: {status['reason']}")
    if priced["issues"]:
        raise Invalid("; ".join(priced["issues"]))
    if priced["ticketCount"] == 0:
        raise Invalid("A booking needs at least one ticket")
    if cart.get("coupon") and priced["couponError"]:
        raise Invalid(priced["couponError"])
    return ctx, priced, pricing.ticket_units(priced, ctx)


def create_booking(db: Session, cfg: Settings, *, visit_date: str, cart: dict, customer: dict, channel: str = "web",
                   session_token: str | None = None, idempotency_key: str | None = None, created_by: str | None = None) -> tuple[Booking, bool]:
    """Price on the server, reserve stock and offer redemptions, and record a pending_payment booking.
    Returns (booking, created). Replaying the same Idempotency-Key returns the original booking."""
    req = _request_hash({"visit_date": visit_date, "cart": cart, "customer": customer, "channel": channel})
    if idempotency_key:
        prev = db.scalar(select(Booking).where(Booking.idempotency_key == idempotency_key))
        if prev:
            if prev.request_sha256 != req:
                raise Conflict("This Idempotency-Key was already used for a different booking")
            return prev, False
    expire_holds(db, visit_date)
    ctx, priced, units = price_for_booking(db, cfg, visit_date, cart)
    offer_ids = [ln["refId"] for ln in priced["lines"] if ln["kind"] == "offer"] + ([priced["couponOfferId"]] if priced["couponOfferId"] else [])
    _take_redemptions(db, offer_ids)
    try:
        inventory.hold(db, ctx, visit_date, units)
    except inventory.SoldOut as e:
        raise Conflict(str(e))
    session = None
    if channel == "web" and session_token:
        session = db.scalar(select(VisitorSession).where(VisitorSession.token == session_token))
    cust = _upsert_customer(db, customer["phone"], customer["name"], customer.get("email"))
    coupon = next((o["coupon"] for o in ctx["offers"] if o["id"] == priced["couponOfferId"]), None)
    b = Booking(
        ref=_new_ref(db, "MGM", 6, Booking, Booking.ref), customer=cust, channel=channel, visit_date=date.fromisoformat(visit_date),
        status="pending_payment", name=customer["name"], phone=customer["phone"], email=customer.get("email"), notes=customer.get("notes"),
        coupon=coupon, offer_ids=offer_ids, units=units, visitor_session_id=session.id if session else None,
        hold_expires_at=utcnow() + timedelta(minutes=int(ctx["settings"].get("holdMinutes", 15))),
        created_by=created_by, idempotency_key=idempotency_key, request_sha256=req, **_amounts(priced),
    )
    b.items = [BookingItem(kind=ln["kind"], ref_id=ln["refId"], label=ln["label"], detail=ln["detail"], qty=ln["qty"],
                           unit=ln["unit"], original=ln["original"], amount=ln["amount"]) for ln in priced["lines"]]
    db.add(b)
    db.flush()
    audit(db, created_by or "Customer", "booking", b.ref, f"Booking {b.ref} created for {visit_date}, awaiting payment of ₹{priced['total']}", notify=False)
    return b, True


# ---------- payments ----------
def start_payment(db: Session, b: Booking, provider: str, method: str | None) -> Payment:
    if b.status != "pending_payment":
        raise Conflict(f"Booking {b.ref} is {b.status.replace('_', ' ')}; nothing to pay")
    open_p = next((p for p in b.payments if p.status == "created" and p.provider == provider and p.kind == "charge"), None)
    if open_p:
        open_p.method = method or open_p.method
        return open_p
    p = Payment(booking_id=b.id, provider=provider, method=method, amount=b.total, status="created")
    db.add(p)
    db.flush()
    p.provider_order_id = f"{provider}_order_{p.id}"
    return p


def _record_event(db: Session, provider: str, event_id: str, type_: str, payment_id: int | None, payload: dict | None) -> bool:
    """False if this provider event was already processed (replay / concurrent duplicate)."""
    if db.scalar(select(PaymentEvent.id).where(PaymentEvent.provider == provider, PaymentEvent.event_id == event_id)):
        return False
    try:
        with db.begin_nested():
            db.add(PaymentEvent(provider=provider, event_id=event_id, type=type_, payment_id=payment_id,
                                payload_sha256=hashlib.sha256(json.dumps(payload or {}, sort_keys=True).encode()).hexdigest()))
    except IntegrityError:
        return False
    return True


def capture_payment(db: Session, cfg: Settings, *, payment_id: int, provider: str, provider_payment_id: str, amount: Decimal,
                    event_id: str, payload: dict | None = None, actor: str = "System") -> Booking:
    """The single entry point that confirms a booking: idempotent per provider event and per provider payment.
    Converts the hold to a sale, issues tickets, consumes nothing twice, records attribution/commission."""
    p = db.scalar(select(Payment).where(Payment.id == payment_id).with_for_update())
    if not p or p.provider != provider:
        raise NotFound("Payment not found")
    b = db.scalar(select(Booking).where(Booking.id == p.booking_id).with_for_update())
    if not _record_event(db, provider, event_id, "payment.captured", p.id, payload) or p.status == "captured":
        return b  # duplicate delivery: nothing happens twice
    if Decimal(amount) != b.total or p.amount != b.total:
        raise Conflict(f"Captured amount {amount} does not match booking total {b.total}")
    if b.status == "expired":
        # Paid after the hold was released: re-reserve if stock and offers still allow it.
        # shortcut: with a real gateway an unconfirmable capture must be refunded automatically (milestone: Razorpay)
        try:
            with db.begin_nested():
                ctx = catalog.load_ctx(db)
                _take_redemptions(db, b.offer_ids)
                inventory.sell(db, ctx, b.visit_date.isoformat(), b.units)
        except (inventory.SoldOut, Conflict):
            p.status, p.failure_reason = "failed", "Paid after the reservation expired and the tickets are no longer available"
            audit(db, actor, "payment", b.ref, f"Late payment for expired booking {b.ref} could not be confirmed")
            return b
    elif b.status == "pending_payment":
        inventory.hold_to_sold(db, b.visit_date.isoformat(), b.units)
    else:
        raise Conflict(f"Booking {b.ref} is {b.status}; payment cannot be applied")
    now = utcnow()
    p.status, p.provider_payment_id, p.captured_at = "captured", provider_payment_id, now
    for u in b.units:
        db.add(Ticket(code=_new_ref(db, "TKT", 8, Ticket, Ticket.code), booking_id=b.id, category_id=u["catId"], label=u["label"],
                      visit_date=b.visit_date, offer_id=u["offerId"], complimentary=u["complimentary"]))
    b.status, b.confirmed_at, b.hold_expires_at, b.version = "confirmed", now, None, b.version + 1
    session = db.get(VisitorSession, b.visitor_session_id) if b.visitor_session_id else None
    services.confirm_payment(db, cfg, b.ref, None, "paid", attribution_amounts(b), provider_payment_id, now,
                             session=session, booking_id=b.id, channel=b.channel, commit=False)
    label = "Counter sale" if b.channel == "counter" else "New online booking"
    audit(db, actor, "booking", b.ref, f"{label} {b.ref} · ₹{b.total:,.0f} paid ({p.method or provider})")
    db.flush()
    return b


def fail_payment(db: Session, *, payment_id: int, provider: str, event_id: str, reason: str, actor: str = "Customer") -> Booking:
    p = db.scalar(select(Payment).where(Payment.id == payment_id).with_for_update())
    if not p or p.provider != provider:
        raise NotFound("Payment not found")
    b = db.get(Booking, p.booking_id)
    if _record_event(db, provider, event_id, "payment.failed", p.id, None) and p.status == "created":
        p.status, p.failure_reason = "failed", reason[:255]
        audit(db, actor, "payment", b.ref, f"Payment declined for {b.ref} (₹{b.total:,.0f}); booking still awaiting payment")
    return b


def attribution_amounts(b: Booking) -> services.BookingAmounts:
    return services.BookingAmounts(tickets=len(b.units), subtotal=b.subtotal, discount=b.discount, addons=b.addons_total,
                                   tax=b.tax, total=b.total, visit_date=b.visit_date)


# ---------- views ----------
TICKET_STATUS = {"issued": "valid", "used": "used", "void": "cancelled"}


def booking_dto(db: Session, cfg: Settings, b: Booking, *, with_qr: bool = True) -> dict:
    """The booking in the shape the front-end's Booking type uses (src/store.ts), plus server state."""
    charge = next((p for p in reversed(b.payments) if p.kind == "charge" and p.status in ("captured", "refunded", "partially_refunded")), None) \
        or next((p for p in reversed(b.payments) if p.kind == "charge"), None)
    if b.status == "pending_payment":
        pay_status = "pending"
    elif b.status == "expired" or (charge and charge.status == "failed" and b.status != "confirmed"):
        pay_status = "failed"
    elif charge and charge.status in ("refunded", "partially_refunded"):
        pay_status = "refunded"
    else:
        pay_status = "paid"
    out = {
        "id": b.ref, "createdAt": ist(b.created_at), "visitDate": b.visit_date.isoformat(), "state": b.status, "channel": b.channel,
        "origin": b.origin, "holdExpiresAt": ist(b.hold_expires_at) or None,
        "customer": {"name": b.name, "phone": b.phone, "email": b.email or "", "visitors": len(b.units), "notes": b.notes or ""},
        "items": [{"label": f"{i.label} ({i.detail})" if i.kind == "offer" else i.label, "qty": i.qty, "amount": float(i.amount),
                   "kind": i.kind, "refId": i.ref_id} for i in b.items],
        "offerIds": list(b.offer_ids), "coupon": b.coupon or "",
        "totals": {"subtotal": float(b.subtotal), "discount": float(b.discount), "addons": float(b.addons_total), "tax": float(b.tax),
                   "total": float(b.total), "complimentary": b.complimentary},
        "payment": {"txnId": (charge.provider_payment_id or charge.provider_order_id) if charge else "", "method": charge.method or "" if charge else "",
                    "status": pay_status, "gateway": _gateway(charge), "at": ist(charge.captured_at or charge.created_at) if charge else ""},
        "status": "confirmed" if b.status in ("confirmed", "pending_payment") else "cancelled",
        "tickets": [{"id": t.code, "catId": t.category_id, "label": t.label, "status": TICKET_STATUS[t.status], "scannedAt": ist(t.used_at) or None,
                     "gate": t.used_gate, "offerId": t.offer_id, "complimentary": t.complimentary,
                     "qr": security.qr_payload(cfg.app_secret, t.code, b.ref, b.visit_date.isoformat()) if with_qr else None} for t in b.tickets],
        "live": True, "counterSale": b.channel == "counter", "modifiedAt": ist(b.modified_at) or None,
    }
    from . import lifecycle  # refund / modification history (milestone C)
    out.update(lifecycle.dto_extras(db, b))
    return out


def _gateway(p: Payment | None) -> str:
    if not p:
        return ""
    return {"simulated": "Simulated (no real payment)", "counter": "Counter (simulated)", "razorpay": "Razorpay", "legacy": "Legacy browser record"}.get(p.provider, p.provider)
