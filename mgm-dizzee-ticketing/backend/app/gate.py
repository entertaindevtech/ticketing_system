"""Gate validation. The admit is one conditional UPDATE (issued -> used, for today's date), so two gates scanning
the same ticket at the same moment cannot both admit it.

Group admission (Model A): one booking QR, several admission transactions. Each ticket row is one admission of
one category, so "admit 2 adults" flips two issued adult tickets to used inside one transaction that holds the
booking row lock; remaining quantities are simply the issued tickets per category."""
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import bookings, pricing, security
from .bookings import ist
from .config import Settings
from .models import Booking, GateAdmission, GateAdmissionLine, GateScan, Ticket, utcnow

TITLES = {"valid": "VALID TICKET", "duplicate": "THIS TICKET HAS ALREADY BEEN USED.", "invalid": "INVALID TICKET"}


def _result(db: Session, scan: GateScan, t: Ticket | None) -> dict:
    b = db.get(Booking, t.booking_id) if t else None
    out = {"kind": scan.result, "status": status_of(scan.result, scan.reason), "title": TITLES[scan.result], "reason": scan.reason,
           "at": ist(scan.at), "scanId": scan.id}
    if t and b:
        out["ticket"] = {"id": t.code, "catId": t.category_id, "label": t.label, "status": bookings.TICKET_STATUS[t.status],
                         "complimentary": t.complimentary, "offerId": t.offer_id}
        out["booking"] = {"id": b.ref, "visitDate": b.visit_date.isoformat(), "customer": {"name": b.name, "visitors": len(b.units)},
                          "tickets": len(b.tickets), "counterSale": b.channel == "counter"}
        if scan.result == "duplicate":
            out["previous"] = {"at": ist(t.used_at), "gate": t.used_gate or ""}
    return out


def scan(db: Session, cfg: Settings, *, raw: str, gate: str, staff_code: str, device_id: str | None, client_scan_id: str | None) -> dict:
    if client_scan_id and device_id:
        prev = db.scalar(select(GateScan).where(GateScan.device_id == device_id, GateScan.client_scan_id == client_scan_id))
        if prev:  # a retried request: same answer, not a second scan
            return _result(db, prev, db.get(Ticket, prev.ticket_id) if prev.ticket_id else None)
    today = pricing.today_ist(cfg.demo_today)
    code, signed_date, err = security.parse_qr(cfg.app_secret, raw)
    t = db.scalar(select(Ticket).where(Ticket.code == code)) if code else None
    if not err and not t:
        err = "Invalid QR code – ticket not found"
    result, reason = "invalid", err
    # Lock the booking before touching its tickets: group admission, cancellation and date changes take the same
    # booking -> tickets order, so they serialize instead of deadlocking. Then re-read the ticket under the lock.
    b = db.scalar(select(Booking).where(Booking.id == t.booking_id).with_for_update()) if t else None
    if t:
        db.refresh(t)
        vd = t.visit_date.isoformat()
        if b.status in ("pending_payment", "expired"):
            reason = "Payment not completed"
        elif t.status == "void" or b.status == "cancelled":
            reason = "Ticket cancelled"
        elif signed_date and signed_date != vd:
            reason = f"Outdated QR code – this booking was changed to {vd}; show the latest ticket"
        elif t.status == "used":
            result, reason = "duplicate", "Already used"
        elif vd < today:
            reason = f"Ticket expired – visit date was {vd}"
        elif vd > today:
            reason = f"Wrong visit date – valid on {vd}"
        else:
            admitted = db.execute(update(Ticket).where(Ticket.id == t.id, Ticket.status == "issued", Ticket.visit_date == t.visit_date)
                                  .values(status="used", used_at=utcnow(), used_gate=gate, used_by=staff_code)
                                  .execution_options(synchronize_session=False)).rowcount == 1
            result, reason = ("valid", "Entry approved") if admitted else ("duplicate", "Already used")
            if admitted:  # a one-person admission record, so both admission paths share one history and one correction path
                a = GateAdmission(ref=bookings._new_ref(db, "ADM", 8, GateAdmission, GateAdmission.ref), kind="admit", booking_id=b.id,
                                  booking_ref=b.ref, gate=gate, staff_code=staff_code, quantity=1, device_id=device_id,
                                  client_txn_id=client_scan_id)
                db.add(a)
                db.flush()
                db.add(GateAdmissionLine(admission_id=a.id, category_id=t.category_id, label=t.label, quantity=1))
                db.execute(update(Ticket).where(Ticket.id == t.id).values(admission_id=a.id).execution_options(synchronize_session=False))
            db.refresh(t)
    s = GateScan(ticket_id=t.id if t else None, ticket_code=(code or raw.strip())[:20], booking_ref=b.ref if b else None,
                 gate=gate, staff_code=staff_code, device_id=device_id, client_scan_id=client_scan_id, result=result, reason=reason[:200])
    try:
        with db.begin_nested():
            db.add(s)
    except IntegrityError:  # the same client scan id raced in: return the stored outcome
        prev = db.scalar(select(GateScan).where(GateScan.device_id == device_id, GateScan.client_scan_id == client_scan_id))
        return _result(db, prev, t)
    return _result(db, s, t)


# ---------- validity (shared by single-ticket scans and group admission) ----------
def status_of(result: str, reason: str) -> str:
    """Machine-readable status for a recorded single-ticket scan, from the reasons scan() writes."""
    if result == "valid":
        return "VALID"
    if result == "duplicate":
        return "ALREADY_USED"
    for prefix, st in (("Ticket cancelled", "CANCELLED"), ("Booking cancelled", "CANCELLED"), ("Ticket expired", "EXPIRED"),
                       ("Wrong visit date", "NOT_YET_VALID"), ("Not valid yet", "NOT_YET_VALID"), ("Payment not completed", "UNPAID")):
        if reason.startswith(prefix):
            return st
    return "INVALID"


def validity(b: Booking, today: str, signed_date: str | None = None) -> tuple[str, str]:
    """(status, reason) for admitting anyone on this booking today, by the park's clock (IST), never the device's."""
    vd = b.visit_date.isoformat()
    if b.status in ("pending_payment", "expired"):
        return "UNPAID", "Payment not completed"
    if b.status == "cancelled":
        return "CANCELLED", "Booking cancelled"
    if signed_date and signed_date != vd:
        return "INVALID", f"Outdated QR code – this booking was changed to {vd}; show the latest ticket"
    if vd < today:
        return "EXPIRED", f"Ticket expired – visit date was {vd}"
    if vd > today:
        return "NOT_YET_VALID", f"Not valid yet – valid on {vd}"
    return "VALID", "Valid today"


# ---------- group admission (Model A) ----------
def _categories(db: Session, b: Booking) -> list[dict]:
    cats: dict[str, dict] = {}
    for t in db.scalars(select(Ticket).where(Ticket.booking_id == b.id, Ticket.status != "void").order_by(Ticket.category_id, Ticket.id)):
        c = cats.setdefault(t.category_id, {"catId": t.category_id, "label": t.label, "purchased": 0, "admitted": 0, "remaining": 0})
        c["purchased"] += 1
        c["admitted" if t.status == "used" else "remaining"] += 1
    return list(cats.values())


def _admission_dto(a: GateAdmission) -> dict:
    return {"ref": a.ref, "kind": a.kind, "at": ist(a.at), "gate": a.gate, "staffId": a.staff_code, "quantity": a.quantity,
            "reason": a.reason, "lines": [{"catId": x.category_id, "label": x.label, "quantity": x.quantity} for x in a.lines]}


def booking_view(db: Session, b: Booking, status: str, reason: str, admission: GateAdmission | None = None) -> dict:
    cats = _categories(db, b)
    total = {k: sum(c[k] for c in cats) for k in ("purchased", "admitted", "remaining")}
    history = db.scalars(select(GateAdmission).where(GateAdmission.booking_id == b.id).order_by(GateAdmission.id.desc()))
    return {"status": status, "reason": reason, "fullyRedeemed": total["purchased"] > 0 and total["remaining"] == 0,
            "booking": {"ref": b.ref, "visitDate": b.visit_date.isoformat(), "name": b.name, "counterSale": b.channel == "counter"},
            "categories": cats, "totals": total, "admission": _admission_dto(admission) if admission else None,
            "history": [_admission_dto(a) for a in history]}


def _record_scan(db: Session, *, ref: str | None, b: Booking | None, gate: str, staff_code: str, result: str, reason: str,
                 device_id: str | None = None, client_id: str | None = None):
    db.add(GateScan(ticket_id=None, ticket_code=(ref or "")[:20] or None, booking_ref=b.ref if b else None, gate=gate,
                    staff_code=staff_code, device_id=device_id, client_scan_id=client_id, result=result, reason=reason[:200]))


def lookup(db: Session, cfg: Settings, *, raw: str, gate: str, staff_code: str) -> dict:
    """Shows what a booking QR allows right now. Admits no one; rejected scans are recorded like ticket scans."""
    ref, signed_date, err = security.parse_booking_qr(cfg.app_secret, raw)
    b = db.scalar(select(Booking).where(Booking.ref == ref)) if ref else None
    if not err and not b:
        err = "Invalid QR code – booking not found"
    if err:
        _record_scan(db, ref=ref or raw.strip(), b=None, gate=gate, staff_code=staff_code, result="invalid", reason=err)
        return {"status": "INVALID", "reason": err, "booking": None, "categories": [], "totals": None, "admission": None,
                "history": [], "fullyRedeemed": False}
    status, reason = validity(b, pricing.today_ist(cfg.demo_today), signed_date)
    if status != "VALID":
        _record_scan(db, ref=b.ref, b=b, gate=gate, staff_code=staff_code, result="invalid", reason=reason)
    return booking_view(db, b, status, reason)


def _quantities(q: dict[str, int]) -> dict[str, int]:
    if any(not isinstance(n, int) or n < 0 for n in q.values()):
        raise bookings.Invalid("Quantities must be whole numbers, zero or more")
    q = {k: n for k, n in q.items() if n}
    if not q:
        raise bookings.Invalid("Select at least one person")
    return q


def admit(db: Session, cfg: Settings, *, raw: str, quantities: dict[str, int], gate: str, staff_code: str,
          device_id: str | None, client_txn_id: str | None) -> dict:
    """Admit some of a booking's people, per category, in one transaction.

    The booking row is locked first (FOR UPDATE), so admissions, cancellations and date changes for one booking run
    one at a time; the tickets are then locked, re-counted and flipped with a conditional UPDATE whose row count must
    match, so a concurrent single-ticket scan can't be double-counted either. Any shortfall raises, and the caller
    rolls the whole transaction back."""
    q = _quantities(quantities)
    ref, signed_date, err = security.parse_booking_qr(cfg.app_secret, raw)
    if err:
        raise bookings.Invalid(err)
    b = bookings.get_booking(db, ref, lock=True)
    today = pricing.today_ist(cfg.demo_today)
    if device_id and client_txn_id:  # a retried request: same answer, not a second admission
        prev = db.scalar(select(GateAdmission).where(GateAdmission.device_id == device_id, GateAdmission.client_txn_id == client_txn_id))
        if prev:
            return booking_view(db, b, *validity(b, today), admission=prev)
    status, reason = validity(b, today, signed_date)
    if status != "VALID":
        raise bookings.Conflict(reason)
    a = GateAdmission(ref=bookings._new_ref(db, "ADM", 8, GateAdmission, GateAdmission.ref), kind="admit", booking_id=b.id,
                      booking_ref=b.ref, gate=gate, staff_code=staff_code, quantity=sum(q.values()), device_id=device_id,
                      client_txn_id=client_txn_id)
    db.add(a)
    db.flush()
    now = utcnow()
    for cat, n in sorted(q.items()):
        ts = db.scalars(select(Ticket).where(Ticket.booking_id == b.id, Ticket.category_id == cat, Ticket.status == "issued")
                        .order_by(Ticket.id).limit(n).with_for_update()).all()
        if len(ts) < n:
            label = db.scalar(select(Ticket.label).where(Ticket.booking_id == b.id, Ticket.category_id == cat).limit(1))
            if not label:
                raise bookings.Invalid(f"This booking has no '{cat}' tickets")
            raise bookings.Conflict(f"Only {len(ts)} {label} admission{'' if len(ts) == 1 else 's'} remaining on {b.ref}")
        done = db.execute(update(Ticket).where(Ticket.id.in_([t.id for t in ts]), Ticket.status == "issued", Ticket.visit_date == b.visit_date)
                          .values(status="used", used_at=now, used_gate=gate, used_by=staff_code, admission_id=a.id)
                          .execution_options(synchronize_session=False)).rowcount
        if done != n:
            raise bookings.Conflict("These tickets changed while admitting – scan the booking again")
        db.add(GateAdmissionLine(admission_id=a.id, category_id=cat, label=ts[0].label, quantity=n))
    db.flush()
    db.expire_all()
    a = db.get(GateAdmission, a.id)
    summary = ", ".join(f"{x.quantity} × {x.label}" for x in a.lines)
    _record_scan(db, ref=b.ref, b=b, gate=gate, staff_code=staff_code, result="valid", reason=f"Group admission {a.ref}: {summary}",
                 device_id=device_id, client_id=client_txn_id)
    return booking_view(db, b, status, reason, admission=a)


def correct(db: Session, cfg: Settings, *, admission_ref: str, quantities: dict[str, int], reason: str, staff_code: str) -> dict:
    """Supervisor correction: return some people of one admission transaction to 'not yet admitted'. The original
    admission row is kept; the correction is a new row with its reason, plus an audit-log entry."""
    q = _quantities(quantities)
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise bookings.Invalid("Give a reason for the correction (at least 5 characters)")
    orig = db.scalar(select(GateAdmission).where(GateAdmission.ref == admission_ref.strip().upper(), GateAdmission.kind == "admit"))
    if not orig:
        raise bookings.NotFound("Admission not found")
    b = bookings.get_booking(db, orig.booking_ref, lock=True)
    # Only on the visit day of an active booking: un-admitting tickets of a cancelled or past booking would hand back
    # "unused" tickets that cancellation, stock release and refunds have already accounted for.
    if b.status != "confirmed":
        raise bookings.Conflict("Admissions on a cancelled or unpaid booking cannot be corrected")
    if b.visit_date.isoformat() != pricing.today_ist(cfg.demo_today):
        raise bookings.Conflict("Admissions can only be corrected on the visit day")
    c = GateAdmission(ref=bookings._new_ref(db, "ADM", 8, GateAdmission, GateAdmission.ref), kind="correction", booking_id=b.id,
                      booking_ref=b.ref, gate=orig.gate, staff_code=staff_code, quantity=sum(q.values()), corrects_id=orig.id,
                      reason=reason[:255])
    db.add(c)
    db.flush()
    for cat, n in sorted(q.items()):
        ts = db.scalars(select(Ticket).where(Ticket.admission_id == orig.id, Ticket.category_id == cat, Ticket.status == "used")
                        .order_by(Ticket.id.desc()).limit(n).with_for_update()).all()
        if len(ts) < n:
            raise bookings.Conflict(f"{orig.ref} has only {len(ts)} '{cat}' admission{'' if len(ts) == 1 else 's'} left to correct")
        db.execute(update(Ticket).where(Ticket.id.in_([t.id for t in ts]), Ticket.status == "used")
                   .values(status="issued", used_at=None, used_gate=None, used_by=None, admission_id=None)
                   .execution_options(synchronize_session=False))
        db.add(GateAdmissionLine(admission_id=c.id, category_id=cat, label=ts[0].label, quantity=n))
    db.flush()
    db.expire_all()
    c = db.get(GateAdmission, c.id)
    summary = ", ".join(f"{x.quantity} × {x.label}" for x in c.lines)
    bookings.audit(db, staff_code, "gate_correction", b.ref,
                   f"Admission {orig.ref} corrected by {staff_code}: {summary} returned to not admitted. Reason: {reason}"[:500],
                   {"admission": orig.ref, "correction": c.ref, "lines": {x.category_id: x.quantity for x in c.lines}, "reason": reason})
    return booking_view(db, b, *validity(b, pricing.today_ist(cfg.demo_today)), admission=c)


def scan_dto(s: GateScan) -> dict:
    return {"id": str(s.id), "at": ist(s.at), "ticketId": s.ticket_code or "", "bookingId": s.booking_ref or "-", "gate": s.gate,
            "staffId": s.staff_code, "result": s.result, "reason": s.reason}
