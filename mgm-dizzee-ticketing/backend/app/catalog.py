"""Catalog and park configuration: reading it in the shape the pricing engine and the front-end use, seeding it,
and the admin edits (validated here, never trusted from the browser)."""
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import catalog_seed as seed
from .models import Addon, Offer, ParkDate, ParkSettings, TicketCategory

OFFER_TYPES = ("bxgy", "percent", "flat", "package")
OFFER_STATUSES = ("draft", "scheduled", "active", "paused", "expired")


class CatalogError(ValueError):
    pass


def offer_dto(o: Offer) -> dict:
    return {**o.data, "id": o.id, "status": o.status, "coupon": o.coupon or "", "maxRedemptions": o.max_redemptions, "redemptions": o.redemptions}


def load_ctx(db: Session, *, include_inactive_addons: bool = False) -> dict:
    """{tickets, offers, addons, dateCfg, settings} exactly as src/store.ts types them."""
    st = db.get(ParkSettings, 1)
    if not st:
        raise CatalogError("Park settings are missing: run the database migrations (alembic upgrade head)")
    addons = db.scalars(select(Addon).order_by(Addon.sort, Addon.id))
    return {
        "settings": dict(st.data),
        "tickets": [{**t.data, "id": t.id, "active": t.active, "dailyLimit": t.daily_limit}
                    for t in db.scalars(select(TicketCategory).order_by(TicketCategory.sort, TicketCategory.id))],
        "offers": [offer_dto(o) for o in db.scalars(select(Offer).order_by(Offer.id))],
        "addons": [{**a.data, "id": a.id, "active": a.active} for a in addons if include_inactive_addons or a.active],
        "dateCfg": {p.visit_date.isoformat(): dict(p.data) for p in db.scalars(select(ParkDate))},
    }


def seed_rows() -> dict[str, list[dict]]:
    """Plain rows per table; used by migration 0003 (bulk_insert) and by tests."""
    return {
        "park_settings": [{"id": 1, "data": seed.SETTINGS}],
        "ticket_categories": [{"id": t["id"], "sort": i, "active": t["active"], "daily_limit": t["dailyLimit"], "data": t} for i, t in enumerate(seed.TICKETS)],
        "addons": [{"id": a["id"], "sort": i, "active": True, "data": a} for i, a in enumerate(seed.ADDONS)],
        "offers": [{"id": o["id"], "coupon": o["coupon"].upper() or None, "status": o["status"], "max_redemptions": o["maxRedemptions"],
                    "redemptions": 0, "data": o} for o in seed.OFFERS],
        "park_dates": [{"visit_date": date.fromisoformat(d), "data": c} for d, c in seed.DATES.items()],
    }


def seed_catalog(db: Session) -> None:
    if db.get(ParkSettings, 1):
        return
    models = {"park_settings": ParkSettings, "ticket_categories": TicketCategory, "addons": Addon, "offers": Offer, "park_dates": ParkDate}
    for table, rows in seed_rows().items():
        db.add_all(models[table](**r) for r in rows)
    db.commit()


# ---------- admin edits ----------
def _num(v, name, lo=0, hi=10_000_000):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
        raise CatalogError(f"{name} must be a number between {lo} and {hi}")
    return v


def _iso(v, name):
    try:
        return date.fromisoformat(v).isoformat()
    except (TypeError, ValueError):
        raise CatalogError(f"{name} must be a date (YYYY-MM-DD)")


SETTINGS_FIELDS = {"gst": (0, 100), "defaultCapacity": (0, 1_000_000), "cancellationFeePct": (0, 100), "cancelNoticeDays": (0, 60), "holdMinutes": (1, 120)}
SETTINGS_TEXT = ("openTime", "closeTime", "parkName", "phone", "email")


def update_settings(db: Session, patch: dict) -> dict:
    st = db.get(ParkSettings, 1)
    data = dict(st.data)
    for k, v in patch.items():
        if k in SETTINGS_FIELDS:
            data[k] = _num(v, k, *SETTINGS_FIELDS[k])
        elif k in SETTINGS_TEXT:
            data[k] = str(v)[:120]
        elif k in ("saleStart", "saleEnd"):
            data[k] = _iso(v, k)
        else:
            raise CatalogError(f"Unknown setting {k}")
    if data["saleStart"] > data["saleEnd"]:
        raise CatalogError("saleStart must be on or before saleEnd")
    st.data = data
    return data


def upsert_ticket_category(db: Session, dto: dict) -> dict:
    cid = str(dto.get("id") or "").strip()
    if not cid or len(cid) > 16:
        raise CatalogError("Ticket category id is required (max 16 characters)")
    if dto.get("kind") not in ("general", "fasttrack") or dto.get("audience") not in ("adult", "child"):
        raise CatalogError("kind must be general/fasttrack and audience adult/child")
    if not str(dto.get("name") or "").strip():
        raise CatalogError("Name is required")
    data = {k: dto.get(k) for k in ("name", "kind", "audience", "description", "eligibility", "validityNote", "restrictions")}
    data.update(id=cid, basePrice=_num(dto.get("basePrice"), "basePrice", 0, 1_000_000), reEntry=bool(dto.get("reEntry")),
                active=bool(dto.get("active", True)), dailyLimit=int(_num(dto.get("dailyLimit"), "dailyLimit", 0, 1_000_000)))
    t = db.get(TicketCategory, cid) or TicketCategory(id=cid, sort=len(list(db.scalars(select(TicketCategory.id)))))
    t.active, t.daily_limit, t.data = data["active"], data["dailyLimit"], data
    db.add(t)
    return data


def upsert_offer(db: Session, dto: dict, ticket_ids: set[str]) -> dict:
    oid = str(dto.get("id") or "").strip()
    if not oid or len(oid) > 32:
        raise CatalogError("Offer id is required (max 32 characters)")
    if dto.get("type") not in OFFER_TYPES or dto.get("status") not in OFFER_STATUSES:
        raise CatalogError("Invalid offer type or status")
    if not str(dto.get("name") or "").strip():
        raise CatalogError("Name is required")
    cats = list(dto.get("categories") or [])
    contents = {k: int(_num(v, "package quantity", 0, 100)) for k, v in (dto.get("packageContents") or {}).items()}
    if not set(cats) <= ticket_ids or not set(contents) <= ticket_ids:
        raise CatalogError("Offer refers to an unknown ticket category")
    if dto["type"] == "package" and not any(contents.values()):
        raise CatalogError("A package needs at least one ticket")
    if dto["type"] != "package" and not cats:
        raise CatalogError("Choose at least one ticket category")
    for k in ("bookingStart", "bookingEnd", "visitStart", "visitEnd"):
        dto[k] = _iso(dto.get(k), k)
    o = db.get(Offer, oid)
    used = o.redemptions if o else 0
    maxr = int(_num(dto.get("maxRedemptions"), "maxRedemptions", 0, 10_000_000))
    data = {**seed.OFFER_DEFAULTS, **{k: v for k, v in dto.items() if k in seed.OFFER_DEFAULTS or k in ("name", "type")}}
    data.update(id=oid, categories=cats, packageContents=contents,
                weekdays=[int(w) for w in dto.get("weekdays") or [] if 0 <= int(w) <= 6], dates=[_iso(x, "dates") for x in dto.get("dates") or []],
                **{k: _num(dto.get(k, 0), k) for k in ("minQty", "value", "buyX", "getY", "packagePrice", "priority")})
    if data["type"] == "percent" and data["value"] > 100:
        raise CatalogError("A percentage cannot exceed 100")
    coupon = str(dto.get("coupon") or "").strip().upper() or None
    if o and o.data.get("image"):
        data["image"] = o.data["image"]
    o = o or Offer(id=oid)
    o.coupon, o.status, o.max_redemptions, o.redemptions = coupon, data["status"], maxr, used
    data.pop("redemptions", None)
    o.data = data
    db.add(o)
    return offer_dto(o)


def set_park_date(db: Session, d: date, patch: dict) -> dict:
    p = db.get(ParkDate, d) or ParkDate(visit_date=d, data={})
    data = dict(p.data)
    for k, v in patch.items():
        if k in ("enabled", "blackout"):
            data[k] = bool(v)
        elif k in ("capacity", "priceAdj"):
            if v is None:
                data.pop(k, None)
            else:
                data[k] = _num(v, k, -100 if k == "priceAdj" else 0, 1_000_000)
        elif k == "note":
            data[k] = str(v or "")[:200]
        else:
            raise CatalogError(f"Unknown date setting {k}")
    p.data = data
    db.add(p)
    return data
