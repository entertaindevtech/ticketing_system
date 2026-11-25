"""Admin console data and configuration: the console's working set, catalog and settings edits, notifications,
audit log and the legacy browser-data import. All role-checked and audited."""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.orm import Session, selectinload

from . import bookings, catalog, gate, inventory, legacy
from .api import cfg, get_db
from .api_auth import user_out
from .auth import Actor, require_roles
from .models import AuditLog, Booking, GateScan, Notification, Offer, User

console = APIRouter(prefix="/api/admin")
ADMIN = require_roles("admin")
STATE_ROLES = require_roles("admin", "finance")


@console.get("/state")
def state(days_back: int = Query(default=90, ge=0, le=730), days_ahead: int = Query(default=366, ge=0, le=730),
          db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(STATE_ROLES)):
    """Everything the admin console renders, in the shape src/store.ts types it (DB): the full catalog
    (including drafts and coupons), bookings with visit dates in [today - days_back, today + days_ahead],
    gate scans for those days, staff (never passwords), notifications and the audit log."""
    t = date.fromisoformat(bookings.today(s))
    lo, hi = t - timedelta(days=days_back), t + timedelta(days=days_ahead)
    bookings.expire_holds(db)
    db.commit()
    ctx = catalog.load_ctx(db, include_inactive_addons=True)
    rows = db.scalars(select(Booking).where(Booking.visit_date.between(lo, hi)).order_by(Booking.created_at.desc())
                      .options(selectinload(Booking.items), selectinload(Booking.tickets), selectinload(Booking.payments)))
    scans = db.scalars(select(GateScan).order_by(GateScan.at.desc()).limit(5000))
    return {
        **ctx, "today": t.isoformat(), "version": 3, "window": {"from": lo.isoformat(), "to": hi.isoformat()},
        "bookings": [bookings.booking_dto(db, s, b, with_qr=False) for b in rows],
        "scans": [gate.scan_dto(x) for x in scans],
        "staff": [user_out(u) for u in db.scalars(select(User).order_by(User.code))],
        "notifications": [{"id": str(n.id), "type": n.type, "message": n.message, "ref": n.ref or "", "at": bookings.ist(n.at), "read": n.read}
                          for n in db.scalars(select(Notification).order_by(Notification.id.desc()).limit(500))],
        "auditLog": [{"id": str(x.id), "type": x.type, "message": x.message, "ref": x.ref or "", "at": bookings.ist(x.at), "actor": x.actor}
                     for x in db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(2000))],
        "me": {"id": a.code, "name": a.name, "roles": list(a.roles)},
    }


def _apply(db: Session, s, fn, *args, sync_from: str | None = None):
    try:
        out = fn(db, *args)
        if sync_from:
            db.flush()
            inventory.sync_capacity(db, catalog.load_ctx(db), sync_from)
        return out
    except (catalog.CatalogError, inventory.SoldOut) as e:
        db.rollback()
        raise HTTPException(422, str(e))


@console.put("/ticket-categories/{cat_id}")
def put_ticket_category(cat_id: str, body: dict, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(ADMIN)):
    out = _apply(db, s, catalog.upsert_ticket_category, {**body, "id": cat_id}, sync_from=bookings.today(s))
    bookings.audit(db, a.code, "ticket", cat_id, f'Ticket category "{out["name"]}" saved (₹{out["basePrice"]}, {out["dailyLimit"]}/day)')
    db.commit()
    return out


@console.put("/offers/{offer_id}")
def put_offer(offer_id: str, body: dict, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(ADMIN)):
    ids = {t["id"] for t in catalog.load_ctx(db)["tickets"]}
    out = _apply(db, s, catalog.upsert_offer, {**body, "id": offer_id}, ids)
    bookings.audit(db, a.code, "offer", offer_id, f'Offer "{out["name"]}" saved ({out["status"]})')
    db.commit()
    return out


@console.delete("/offers/{offer_id}")
def delete_offer(offer_id: str, db: Session = Depends(get_db), a: Actor = Depends(ADMIN)):
    o = db.get(Offer, offer_id)
    if not o:
        raise HTTPException(404, "Offer not found")
    # shortcut: scans offer_ids of all bookings; add a booking_offers link table if bookings grow past ~100k
    used = sum(1 for ids in db.scalars(select(Booking.offer_ids)) if offer_id in ids)
    if used or o.redemptions:
        raise HTTPException(409, "This offer has been used by bookings; pause it instead of deleting it")
    db.delete(o)
    bookings.audit(db, a.code, "offer", offer_id, f'Offer "{o.data.get("name")}" deleted')
    db.commit()
    return {"deleted": offer_id}


@console.put("/park-dates/{visit_date}")
def put_park_date(visit_date: date, body: dict, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(ADMIN)):
    out = _apply(db, s, catalog.set_park_date, visit_date, body, sync_from=visit_date.isoformat())
    bookings.audit(db, a.code, "calendar", visit_date.isoformat(), f"Calendar {visit_date.isoformat()} updated: {', '.join(f'{k}={v}' for k, v in body.items())}", notify=False)
    db.commit()
    return out


@console.patch("/settings")
def patch_settings(body: dict, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(ADMIN)):
    out = _apply(db, s, catalog.update_settings, body, sync_from=bookings.today(s) if "defaultCapacity" in body else None)
    bookings.audit(db, a.code, "settings", None, f"Settings updated: {', '.join(body)}")
    db.commit()
    return out


@console.post("/notifications/{nid}/read")
def read_notification(nid: int, db: Session = Depends(get_db), _: Actor = Depends(STATE_ROLES)):
    db.execute(update(Notification).where(Notification.id == nid).values(read=True))
    db.commit()
    return {"ok": True}


@console.post("/notifications/read-all")
def read_all(db: Session = Depends(get_db), _: Actor = Depends(STATE_ROLES)):
    db.execute(update(Notification).where(Notification.read.is_(False)).values(read=True))
    db.commit()
    return {"ok": True}


class LegacyIn(BaseModel):
    bookings: list[dict] = Field(max_length=5000)


@console.post("/legacy-import")
def legacy_import(body: LegacyIn, db: Session = Depends(get_db), s=Depends(cfg), a: Actor = Depends(ADMIN)):
    """Import bookings exported from a browser of the retired local-only prototype. Idempotent; never overwrites."""
    results = legacy.import_many(db, body.bookings, s, a.code)
    db.commit()
    counts = {k: sum(1 for r in results if r["result"] == k) for k in ("imported", "already_present", "conflict", "rejected")}
    bookings.audit(db, a.code, "import", None, "Legacy import: " + ", ".join(f"{v} {k}" for k, v in counts.items()))
    db.commit()
    return {"summary": counts, "results": results}
