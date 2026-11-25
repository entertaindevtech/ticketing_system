"""Gate validation. The admit is one conditional UPDATE (issued -> used, for today's date), so two gates scanning
the same ticket at the same moment cannot both admit it."""
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import bookings, pricing, security
from .bookings import ist
from .config import Settings
from .models import Booking, GateScan, Ticket, utcnow

TITLES = {"valid": "VALID TICKET", "duplicate": "THIS TICKET HAS ALREADY BEEN USED.", "invalid": "INVALID TICKET"}


def _result(db: Session, scan: GateScan, t: Ticket | None) -> dict:
    b = db.get(Booking, t.booking_id) if t else None
    out = {"kind": scan.result, "title": TITLES[scan.result], "reason": scan.reason, "at": ist(scan.at), "scanId": scan.id}
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
    b = db.get(Booking, t.booking_id) if t else None
    if t:
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


def scan_dto(s: GateScan) -> dict:
    return {"id": str(s.id), "at": ist(s.at), "ticketId": s.ticket_code or "", "bookingId": s.booking_ref or "-", "gate": s.gate,
            "staffId": s.staff_code, "result": s.result, "reason": s.reason}
