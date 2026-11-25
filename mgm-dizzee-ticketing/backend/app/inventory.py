"""Park-wide and per-category admission inventory.

Every change is a single conditional UPDATE (`... WHERE held + sold + n <= capacity`), so concurrent bookings
cannot oversell: on PostgreSQL the second writer waits for the first and re-checks the condition against the
committed row. Rows are always touched in one order (date row, then categories by id) to avoid deadlocks.
All functions run inside the caller's transaction; the caller commits or rolls back.
"""
from collections import Counter
from datetime import date

from sqlalchemy import select, update
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session

from .models import CategoryInventory, DateInventory


class SoldOut(Exception):
    pass


def date_capacity(ctx: dict, d: str) -> int:
    c = (ctx["dateCfg"].get(d) or {}).get("capacity")
    return int(c) if isinstance(c, (int, float)) and not isinstance(c, bool) else int(ctx["settings"]["defaultCapacity"])


def category_capacity(ctx: dict, cat_id: str) -> int:
    return next((int(t["dailyLimit"]) for t in ctx["tickets"] if t["id"] == cat_id), 0)


def _insert(db: Session, model, rows: list[dict]):
    ins = (postgresql.insert if db.get_bind().dialect.name == "postgresql" else sqlite.insert)(model)
    db.execute(ins.values(rows).on_conflict_do_nothing())


def ensure_rows(db: Session, ctx: dict, d: str, cat_ids) -> None:
    vd = date.fromisoformat(d)
    _insert(db, DateInventory, [{"visit_date": vd, "capacity": date_capacity(ctx, d), "held": 0, "sold": 0}])
    cats = sorted(set(cat_ids))
    if cats:
        _insert(db, CategoryInventory, [{"visit_date": vd, "category_id": c, "capacity": category_capacity(ctx, c), "held": 0, "sold": 0} for c in cats])


def counts(units: list[dict]) -> Counter:
    # stock=False marks admissions that never took inventory (legacy imports over capacity or for past dates)
    return Counter(u["catId"] for u in units if u.get("stock", True))


def _apply(db: Session, d: str, per_cat: Counter, *, held: int = 0, sold: int = 0, check: bool) -> None:
    """Add held/sold multiples of each count (negative = release). check=True enforces capacity."""
    vd = date.fromisoformat(d)
    total = sum(per_cat.values())
    targets = [(DateInventory, [DateInventory.visit_date == vd], total, "the park")]
    targets += [(CategoryInventory, [CategoryInventory.visit_date == vd, CategoryInventory.category_id == c], n, c) for c, n in sorted(per_cat.items())]
    for model, where, n, label in targets:
        if not n:
            continue
        dh, ds = held * n, sold * n
        cond = list(where)
        if check:
            cond.append(model.held + model.sold + dh + ds <= model.capacity)
        res = db.execute(update(model).where(*cond).values(held=model.held + dh, sold=model.sold + ds).execution_options(synchronize_session=False))
        if res.rowcount != 1:
            raise SoldOut(f"Not enough capacity left for {label} on {d}")


def hold(db: Session, ctx: dict, d: str, units: list[dict]) -> None:
    c = counts(units)
    ensure_rows(db, ctx, d, c)
    _apply(db, d, c, held=1, check=True)


def release_hold(db: Session, d: str, units: list[dict]) -> None:
    _apply(db, d, counts(units), held=-1, check=False)


def hold_to_sold(db: Session, d: str, units: list[dict]) -> None:
    c = counts(units)
    _apply(db, d, c, held=-1, sold=1, check=False)


def sell(db: Session, ctx: dict, d: str, units: list[dict]) -> None:
    """Direct sale without a hold (counter sale, modification to a new date)."""
    c = counts(units)
    ensure_rows(db, ctx, d, c)
    _apply(db, d, c, sold=1, check=True)


def release_sold(db: Session, d: str, units: list[dict]) -> None:
    _apply(db, d, counts(units), sold=-1, check=False)


def remaining(db: Session, ctx: dict, d: str) -> dict:
    vd = date.fromisoformat(d)
    row = db.get(DateInventory, vd)
    used = {r.category_id: r.held + r.sold for r in db.scalars(select(CategoryInventory).where(CategoryInventory.visit_date == vd))}
    total = (row.capacity - row.held - row.sold) if row else date_capacity(ctx, d)
    return {"total": max(0, total), **{t["id"]: max(0, min(category_capacity(ctx, t["id"]) - used.get(t["id"], 0), total)) for t in ctx["tickets"]}}


def sync_capacity(db: Session, ctx: dict, from_date: str) -> None:
    """After an admin changes a capacity or daily limit, apply it to existing inventory rows from from_date on.
    Refuses (SoldOut) a capacity below what is already held + sold for that date."""
    fd = date.fromisoformat(from_date)
    for r in db.scalars(select(DateInventory).where(DateInventory.visit_date >= fd)):
        cap = date_capacity(ctx, r.visit_date.isoformat())
        if cap < r.held + r.sold:
            raise SoldOut(f"{r.visit_date}: {r.held + r.sold} admissions are already booked; capacity cannot go below that")
        r.capacity = cap
    for r in db.scalars(select(CategoryInventory).where(CategoryInventory.visit_date >= fd)):
        cap = category_capacity(ctx, r.category_id)
        if cap < r.held + r.sold:
            raise SoldOut(f"{r.visit_date} {r.category_id}: {r.held + r.sold} already booked; the daily limit cannot go below that")
        r.capacity = cap
