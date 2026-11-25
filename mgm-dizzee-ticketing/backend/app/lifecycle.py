"""Booking lifecycle after payment: cancellation requests and decisions, refunds, modifications.

Business rules are the prototype's (src/store.ts cancellationEligibility / modificationEligibility /
modifyBooking), now enforced on the server. Every function runs in the caller's transaction.
"""
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import bookings, catalog, inventory, pricing, services
from .bookings import Conflict, Invalid, audit, ist
from .config import Settings
from .models import Booking, BookingItem, BookingModification, CancellationRequest, Payment, Refund, Ticket, utcnow

IMMEDIATE_REFUND_PROVIDERS = ("simulated", "counter", "legacy")  # no gateway call needed; marked done at once


def _stocked(b: Booking, tickets: list[Ticket]) -> list[dict]:
    """The inventory these tickets actually hold: per category, never more than the booking's stocked admissions."""
    left = inventory.counts(b.units)
    out = []
    for t in tickets:
        if left[t.category_id] > 0:
            left[t.category_id] -= 1
            out.append({"catId": t.category_id})
    return out


def _charge(b: Booking) -> Payment | None:
    return next((p for p in b.payments if p.kind == "charge" and p.status in ("captured", "partially_refunded", "refunded")), None)


def _requests(db: Session, b: Booking) -> list[CancellationRequest]:
    return list(db.scalars(select(CancellationRequest).where(CancellationRequest.booking_id == b.id).order_by(CancellationRequest.id)))


def fee_for(b: Booking, settings: dict) -> Decimal:
    return Decimal(pricing.js_round(float(b.total) * settings["cancellationFeePct"] / 100))


# ---------- cancellation ----------
def cancellation_eligibility(db: Session, b: Booking, settings: dict, today: str) -> tuple[bool, str]:
    reqs = _requests(db, b)
    if b.status == "cancelled":
        return False, "This booking is already cancelled."
    if any(r.status == "pending" for r in reqs):
        return False, "A cancellation request is already pending review."
    if reqs:
        return False, "This booking's cancellation has already been reviewed."
    if b.status != "confirmed" or not _charge(b):
        return False, "Only paid bookings can be cancelled."
    if b.offer_ids:
        return False, "This booking used an offer and is not eligible for cancellation."
    if any(t.status == "used" for t in b.tickets):
        return False, "Tickets from this booking have already been used."
    hours = int(settings.get("cancelNoticeDays", 2)) * 24
    if b.visit_date.isoformat() < pricing.add_days(today, int(settings.get("cancelNoticeDays", 2))):
        return False, f"Less than {hours} hours remain before the visit — not eligible for cancellation."
    return True, ""


def request_cancellation(db: Session, cfg: Settings, ref: str, actor: str = "Customer") -> CancellationRequest:
    b = bookings.get_booking(db, ref, lock=True)
    settings = catalog.load_ctx(db)["settings"]
    ok, why = cancellation_eligibility(db, b, settings, bookings.today(cfg))
    if not ok:
        raise Conflict(why)
    fee = fee_for(b, settings)
    r = CancellationRequest(booking_id=b.id, requested_by="customer", fee=fee, refund_amount=b.total - fee, reason="Customer requested cancellation")
    db.add(r)
    db.flush()
    audit(db, actor, "cancellation", b.ref, f"Cancellation requested for {b.ref} (refund ₹{b.total - fee:,.0f} after {settings['cancellationFeePct']}% fee)")
    return r


def _cancel(db: Session, b: Booking, req: CancellationRequest, actor: str) -> Refund | None:
    """Cancel a paid booking: void unused tickets, release their stock, refund, reverse commission."""
    unused = [t for t in b.tickets if t.status == "issued"]
    for t in unused:
        t.status = "void"
    inventory.release_sold(db, b.visit_date.isoformat(), _stocked(b, unused))
    b.status, b.cancelled_at, b.version = "cancelled", utcnow(), b.version + 1
    charge = _charge(b)
    refund = None
    if charge and req.refund_amount > 0:
        refund = Refund(booking_id=b.id, payment_id=charge.id, cancellation_request_id=req.id, amount=req.refund_amount, fee=req.fee,
                        reason=req.reason, status="pending")
        db.add(refund)
        db.flush()
        if charge.provider in IMMEDIATE_REFUND_PROVIDERS:
            process_refund(db, refund.id, actor)
    services.cancel_booking(db, b.ref, req.reason or "Booking cancelled / refunded", commit=False)
    return refund


def approve_cancellation(db: Session, cfg: Settings, ref: str, actor: str) -> Booking:
    b = bookings.get_booking(db, ref, lock=True)
    req = next((r for r in _requests(db, b) if r.status == "pending"), None)
    if not req or b.status == "cancelled":
        raise Conflict("There is no pending cancellation request for this booking")
    req.status, req.decided_at, req.decided_by = "approved", utcnow(), actor
    _cancel(db, b, req, actor)
    audit(db, actor, "refund", b.ref, f"Refund of ₹{req.refund_amount:,.0f} approved for {b.ref}; tickets cancelled")
    return b


def reject_cancellation(db: Session, cfg: Settings, ref: str, reason: str, actor: str) -> Booking:
    b = bookings.get_booking(db, ref, lock=True)
    req = next((r for r in _requests(db, b) if r.status == "pending"), None)
    if not req:
        raise Conflict("There is no pending cancellation request for this booking")
    req.status, req.decided_at, req.decided_by = "rejected", utcnow(), actor
    req.rejection_reason = (reason or "").strip()[:255] or "Not eligible per policy"
    audit(db, actor, "refund", b.ref, f"Refund rejected for {b.ref}: {req.rejection_reason}")
    return b


def admin_cancel(db: Session, cfg: Settings, ref: str, actor: str) -> Booking:
    """One-step admin cancel & refund (fee applies). Also settles a pending customer request."""
    b = bookings.get_booking(db, ref, lock=True)
    if b.status != "confirmed" or not _charge(b):
        raise Conflict("Only paid, active bookings can be cancelled")
    settings = catalog.load_ctx(db)["settings"]
    req = next((r for r in _requests(db, b) if r.status == "pending"), None)
    if not req:
        fee = fee_for(b, settings)
        req = CancellationRequest(booking_id=b.id, requested_by="admin", fee=fee, refund_amount=b.total - fee,
                                  reason=f"Cancelled by admin ({settings['cancellationFeePct']}% fee)")
        db.add(req)
        db.flush()
    req.status, req.decided_at, req.decided_by = "approved", utcnow(), actor
    _cancel(db, b, req, actor)
    audit(db, actor, "refund", b.ref, f"Booking {b.ref} cancelled and refunded by admin (₹{req.refund_amount:,.0f})")
    return b


# ---------- refunds and price differences ----------
def process_refund(db: Session, refund_id: int, actor: str) -> Refund:
    r = db.scalar(select(Refund).where(Refund.id == refund_id).with_for_update())
    if not r:
        raise bookings.NotFound("Refund not found")
    if r.status == "succeeded":
        return r
    if r.status not in ("pending", "failed"):
        raise Conflict(f"Refund is {r.status}")
    p = db.get(Payment, r.payment_id)
    # shortcut: simulated / counter / legacy refunds are recorded as done; a gateway refund goes to 'processing'
    # and is completed by its webhook (Razorpay milestone).
    r.status, r.processed_at, r.processed_by = "succeeded", utcnow(), actor
    r.provider_refund_id = r.provider_refund_id or f"{p.provider}_refund_{r.id}"
    refunded = sum((x.amount for x in db.scalars(select(Refund).where(Refund.payment_id == p.id, Refund.status == "succeeded"))), Decimal(0))
    if refunded > p.amount:
        raise Conflict("Refunds would exceed the amount paid")
    p.status = "refunded" if refunded == p.amount else "partially_refunded"
    b = db.get(Booking, r.booking_id)
    audit(db, actor, "refund", b.ref, f"Refund of ₹{r.amount:,.0f} for {b.ref} processed", notify=False)
    return r


def collect_difference(db: Session, payment_id: int, method: str, actor: str) -> Payment:
    p = db.scalar(select(Payment).where(Payment.id == payment_id).with_for_update())
    if not p or p.kind != "difference":
        raise bookings.NotFound("Payment not found")
    if p.status != "created":
        raise Conflict(f"This difference is already {p.status}")
    p.status, p.method, p.captured_at, p.provider_payment_id = "captured", method, utcnow(), f"diff_{p.id}"
    b = db.get(Booking, p.booking_id)
    audit(db, actor, "payment", b.ref, f"Price difference ₹{p.amount:,.0f} collected for {b.ref} ({method})")
    return p


# ---------- modification ----------
def modification_eligibility(db: Session, b: Booking, today: str) -> tuple[bool, str]:
    if b.status == "cancelled":
        return False, "Cancelled bookings can't be modified."
    if b.status != "confirmed" or not _charge(b):
        return False, "Only paid bookings can be modified."
    if any(r.status == "pending" for r in _requests(db, b)):
        return False, "Resolve the pending cancellation request first."
    if b.offer_ids or b.coupon:
        return False, "Bookings with offers or coupons can't be modified — offer pricing is tied to the original date."
    if any(t.status == "used" for t in b.tickets):
        return False, "Tickets have already been used at the gate."
    if b.visit_date.isoformat() < today:
        return False, "The visit date has passed."
    return True, ""


def _snapshot(b: Booking) -> dict:
    return {"visitDate": b.visit_date.isoformat(), "total": float(b.total), "tickets": [t.code for t in b.tickets if t.status == "issued"],
            "items": [{"kind": i.kind, "refId": i.ref_id, "qty": i.qty, "amount": float(i.amount)} for i in b.items]}


def modify_booking(db: Session, cfg: Settings, ref: str, visit_date: str, ticket_qty: dict, addon_qty: dict, actor: str) -> dict:
    """Re-price a regular booking. Existing ticket codes are kept per category; only added tickets get new codes.
    Returns the price change; the caller commits (or rolls back for a dry run)."""
    b = bookings.get_booking(db, ref, lock=True)
    t = bookings.today(cfg)
    ok, why = modification_eligibility(db, b, t)
    if not ok:
        raise Conflict(why)
    ctx, priced, units = bookings.price_for_booking(db, cfg, visit_date, {"tickets": ticket_qty, "offers": {}, "addons": addon_qty, "coupon": ""})
    before = _snapshot(b)
    old_date, old_total = b.visit_date, b.total
    issued = [x for x in b.tickets if x.status == "issued"]
    inventory.release_sold(db, old_date.isoformat(), _stocked(b, issued))
    try:
        inventory.sell(db, ctx, visit_date, units)
    except inventory.SoldOut as e:
        raise Conflict(str(e))
    vd = date.fromisoformat(visit_date)
    keep: list[Ticket] = []
    pool = {c: [x for x in issued if x.category_id == c] for c in {x.category_id for x in issued}}
    for u in units:
        existing = pool.get(u["catId"]) or []
        if existing:
            keep.append(existing.pop(0))
        else:
            nt = Ticket(code=bookings._new_ref(db, "TKT", 8, Ticket, Ticket.code), booking_id=b.id, category_id=u["catId"], label=u["label"], visit_date=vd)
            db.add(nt)
            keep.append(nt)
    for x in issued:
        if x not in keep:
            x.status = "void"
    for x in keep:
        x.visit_date = vd
    b.visit_date, b.units = vd, units
    for k, v in bookings._amounts(priced).items():
        setattr(b, k, v)
    b.items.clear()
    db.flush()
    b.items.extend(BookingItem(kind=ln["kind"], ref_id=ln["refId"], label=ln["label"], detail=ln["detail"], qty=ln["qty"], unit=ln["unit"],
                               original=ln["original"], amount=ln["amount"]) for ln in priced["lines"])
    b.modified_at, b.version = utcnow(), b.version + 1
    diff = b.total - old_total
    settlement = "collect" if diff > 0 else "refund" if diff < 0 else "none"
    db.flush()
    m = BookingModification(booking_id=b.id, by=actor, previous_visit_date=old_date, visit_date=vd, previous_total=old_total,
                            new_total=b.total, settlement=settlement, before=before, after=_snapshot(b))
    db.add(m)
    db.flush()
    if diff > 0:
        db.add(Payment(booking_id=b.id, kind="difference", provider="counter", amount=diff, status="created"))
    elif diff < 0:
        charge = _charge(b)
        db.add(Refund(booking_id=b.id, payment_id=charge.id, modification_id=m.id, amount=-diff, reason="Booking modified to a lower price"))
    services.modify_booking(db, cfg, b.ref, bookings.attribution_amounts(b), commit=False)
    word = "no price change" if diff == 0 else f"collect ₹{diff:,.0f}" if diff > 0 else f"refund ₹{-diff:,.0f}"
    audit(db, actor, "modification", b.ref, f"Booking {b.ref} modified ({word})")
    return {"previousTotal": float(old_total), "newTotal": float(b.total), "difference": float(diff), "settlement": settlement,
            "keptTickets": [x.code for x in keep if x.code in before["tickets"]]}


# ---------- views ----------
def dto_extras(db: Session, b: Booking) -> dict:
    reqs = _requests(db, b)
    refunds = list(db.scalars(select(Refund).where(Refund.booking_id == b.id).order_by(Refund.id)))
    mods = list(db.scalars(select(BookingModification).where(BookingModification.booking_id == b.id).order_by(BookingModification.id)))
    out: dict = {
        "refunds": [{"id": r.id, "amount": float(r.amount), "fee": float(r.fee), "status": r.status, "reason": r.reason,
                     "createdAt": ist(r.created_at), "processedAt": ist(r.processed_at) or None, "kind": "modification" if r.modification_id else "cancellation"} for r in refunds],
        "differences": [{"id": p.id, "amount": float(p.amount), "status": p.status, "method": p.method, "at": ist(p.captured_at or p.created_at)}
                        for p in b.payments if p.kind == "difference"],
    }
    if mods:
        out["modifications"] = [{"at": ist(m.at), "by": m.by, "previousVisitDate": m.previous_visit_date.isoformat(), "visitDate": m.visit_date.isoformat(),
                                 "previousTotal": float(m.previous_total), "newTotal": float(m.new_total)} for m in mods]
    if reqs:
        r = reqs[-1]
        out["refund"] = {"amount": float(r.refund_amount), "deduction": float(r.fee), "reason": r.reason or "", "status": r.status,
                         "requestedAt": ist(r.requested_at), "at": ist(r.decided_at or r.requested_at),
                         "approvedAt": ist(r.decided_at) if r.status == "approved" else None,
                         "rejectedAt": ist(r.decided_at) if r.status == "rejected" else None, "rejectionReason": r.rejection_reason}
    return out
