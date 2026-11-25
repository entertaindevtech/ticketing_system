"""Import of bookings that were made in the retired browser-only prototype (localStorage).

Only explicitly exported, *live* (customer- or counter-made, not demo-seeded) bookings are accepted, one by one,
with a per-booking outcome. Nothing is overwritten: an existing reference is reported as already_present (same
data) or conflict. Imported bookings keep their original reference and ticket codes so printed QR codes still
scan (the legacy QR signature proves nothing, so the gate accepts MGMDW1 codes only for tickets in the database).
They are marked origin='legacy_import' and their payment provider 'legacy' (the prototype never took real money).
"""
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import catalog, inventory, pricing
from .bookings import _upsert_customer, audit
from .models import Booking, BookingAttribution, BookingItem, Payment, Ticket, utcnow

REF_RE = r"^[A-Z0-9][A-Z0-9-]{2,15}$"


def _num(v) -> Decimal:
    d = Decimal(str(v))
    if d < 0 or d > 10_000_000:
        raise ValueError("amount out of range")
    return d


def import_one(db: Session, raw: dict, today: str, actor: str) -> dict:
    import re
    ref = str(raw.get("id") or "")
    if not re.match(REF_RE, ref):
        return {"ref": ref[:20], "result": "rejected", "reason": "Invalid booking reference"}
    if not raw.get("live"):
        return {"ref": ref, "result": "rejected", "reason": "Demo (seeded) booking; only real bookings are imported"}
    pay = raw.get("payment") or {}
    if pay.get("status") not in ("paid", "refunded"):
        return {"ref": ref, "result": "rejected", "reason": f"Payment {pay.get('status') or 'missing'}; only paid bookings are imported"}
    existing = db.scalar(select(Booking).where(Booking.ref == ref))
    if existing:
        same = existing.origin == "legacy_import" and float(existing.total) == float((raw.get("totals") or {}).get("total", -1))
        return {"ref": ref, "result": "already_present" if same else "conflict",
                "reason": "" if same else "A different booking already uses this reference; nothing was changed"}
    try:
        cust = raw["customer"]
        phone = re.sub(r"\D", "", str(cust["phone"]))[-10:]
        if not re.match(r"^[6-9]\d{9}$", phone) or len(str(cust["name"]).strip()) < 2:
            raise ValueError("customer name/phone")
        t = raw["totals"]
        totals = {k: _num(t.get(k, 0)) for k in ("subtotal", "discount", "addons", "tax", "total")}
        vd = date.fromisoformat(raw["visitDate"])
        tickets = raw.get("tickets") or []
        codes = [str(x["id"]).upper() for x in tickets]
        if not codes or len(codes) > 200 or any(not re.match(r"^TKT-[A-Z0-9]{4,12}$", c) for c in codes):
            raise ValueError("tickets")
    except (KeyError, TypeError, ValueError) as e:
        return {"ref": ref, "result": "rejected", "reason": f"Incomplete or invalid booking data ({e})"}
    clash = db.scalar(select(Ticket.code).where(Ticket.code.in_(codes)))
    if clash:
        return {"ref": ref, "result": "conflict", "reason": f"Ticket {clash} already exists; nothing was changed"}

    cancelled = raw.get("status") == "cancelled" or pay.get("status") == "refunded"
    status = "cancelled" if cancelled else "confirmed"
    with db.begin_nested():
        c = _upsert_customer(db, phone, str(cust["name"])[:120], (cust.get("email") or None))
        units = [{"catId": str(x.get("catId", ""))[:16], "label": str(x.get("label", ""))[:120], "offerId": x.get("offerId"),
                  "complimentary": bool(x.get("complimentary"))} for x in tickets]
        b = Booking(ref=ref, customer=c, channel="counter" if raw.get("counterSale") else "web", origin="legacy_import", visit_date=vd,
                    status=status, name=str(cust["name"])[:120], phone=phone, email=cust.get("email") or None,
                    notes=(str(cust.get("notes") or "")[:400] + " [imported from browser storage]").strip(),
                    subtotal=totals["subtotal"], discount=totals["discount"], addons_total=totals["addons"], tax=totals["tax"],
                    total=totals["total"], complimentary=int((raw.get("totals") or {}).get("complimentary") or 0),
                    coupon=str(raw.get("coupon") or "")[:32] or None, offer_ids=[str(o)[:32] for o in raw.get("offerIds") or []][:10],
                    units=units, confirmed_at=utcnow(), cancelled_at=utcnow() if cancelled else None, created_by=actor)
        b.items = [BookingItem(kind=i.get("kind") if i.get("kind") in ("ticket", "offer", "addon") else "ticket", ref_id=str(i.get("refId", ""))[:32],
                               label=str(i.get("label", ""))[:200], qty=max(1, int(i.get("qty") or 1)), unit=_num(i.get("amount", 0)) / max(1, int(i.get("qty") or 1)),
                               original=_num(i.get("amount", 0)), amount=_num(i.get("amount", 0))) for i in raw.get("items") or []]
        db.add(b)
        db.flush()
        tstatus = {"valid": "issued", "used": "used", "cancelled": "void"}
        for x in tickets:
            st = tstatus.get(x.get("status"), "issued")
            st = "void" if cancelled and st == "issued" else st
            db.add(Ticket(code=str(x["id"]).upper(), booking_id=b.id, category_id=str(x.get("catId", ""))[:16], label=str(x.get("label", ""))[:120],
                          visit_date=vd, status=st, complimentary=bool(x.get("complimentary")), offer_id=x.get("offerId"),
                          used_at=utcnow() if st == "used" else None, used_gate=x.get("gate") if st == "used" else None))
        db.add(Payment(booking_id=b.id, provider="legacy", method=str(pay.get("method") or "")[:32], provider_payment_id=f"legacy_{ref}",
                       amount=totals["total"], status="refunded" if cancelled else "captured", captured_at=utcnow()))
        note = ""
        valid = [x.get("status") == "valid" for x in tickets]
        stocked = False
        if status == "confirmed" and vd.isoformat() >= today:
            try:
                with db.begin_nested():
                    inventory.sell(db, catalog.load_ctx(db), vd.isoformat(), [u for u, v in zip(units, valid) if v])
                    stocked = True
            except inventory.SoldOut:
                note = "imported over capacity: inventory for that date was not reduced"
        # record which admissions hold inventory, so a later cancellation or change releases exactly that
        b.units = [{**u, "stock": stocked and v} for u, v in zip(units, valid)]
        attr = db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == ref))
        if attr and attr.booking_id is None:
            attr.booking_id = b.id
        audit(db, actor, "import", ref, f"Legacy browser booking {ref} imported ({status})" + (f"; {note}" if note else ""), notify=False)
    return {"ref": ref, "result": "imported", "reason": note}


def import_many(db: Session, items: list[dict], cfg, actor: str) -> list[dict]:
    today = pricing.today_ist(cfg.demo_today)
    out = []
    for raw in items:
        try:
            out.append(import_one(db, raw if isinstance(raw, dict) else {}, today, actor))
        except Exception as e:  # noqa: BLE001 - one bad record must not block the rest
            out.append({"ref": str((raw or {}).get("id", ""))[:20] if isinstance(raw, dict) else "", "result": "rejected", "reason": f"Could not import ({type(e).__name__})"})
    return out
