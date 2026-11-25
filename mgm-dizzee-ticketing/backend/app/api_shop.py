"""Public catalog, availability and quote API (no customer data here)."""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from . import catalog, pricing
from .api import cfg, get_db

shop = APIRouter(prefix="/api")
MAX_QTY = 100


class CartIn(BaseModel):
    tickets: dict[str, int] = Field(default_factory=dict, max_length=20)
    offers: dict[str, int] = Field(default_factory=dict, max_length=20)
    addons: dict[str, int] = Field(default_factory=dict, max_length=20)
    coupon: str = Field(default="", max_length=32)

    @field_validator("tickets", "offers", "addons")
    @classmethod
    def _qty(cls, v: dict[str, int]) -> dict[str, int]:
        if any(not 0 <= q <= MAX_QTY or len(k) > 32 for k, q in v.items()):
            raise ValueError(f"quantities must be between 0 and {MAX_QTY}")
        return {k: q for k, q in v.items() if q}


class QuoteIn(BaseModel):
    visit_date: date
    cart: CartIn


def public_ctx(ctx: dict) -> dict:
    """Catalog for anyone: no draft/paused offers and no coupon codes (coupons are validated by /api/quote)."""
    return {**ctx, "offers": [o for o in ctx["offers"] if o["status"] in ("active", "scheduled") and not o["coupon"]]}


def today(s) -> str:
    return pricing.today_ist(s.demo_today)


def quote(db: Session, s, visit_date: str, cart: dict, booked_on: str | None = None) -> tuple[dict, dict, dict]:
    ctx = catalog.load_ctx(db)
    t = booked_on or today(s)
    priced = pricing.price_cart(cart, visit_date, ctx, t)
    status = pricing.date_status(visit_date, ctx, t)
    return ctx, priced, status


def quote_out(ctx: dict, priced: dict, status: dict) -> dict:
    coupon = next((o for o in ctx["offers"] if o["id"] == priced["couponOfferId"]), None)
    return {**priced, "couponOffer": coupon, "dateStatus": status}


@shop.get("/catalog")
def get_catalog(db: Session = Depends(get_db), s=Depends(cfg)):
    return {**public_ctx(catalog.load_ctx(db)), "today": today(s)}


@shop.get("/availability")
def availability(date_from: date = Query(alias="from"), date_to: date = Query(alias="to"), db: Session = Depends(get_db), s=Depends(cfg)):
    if (date_to - date_from).days > 92 or date_to < date_from:
        raise HTTPException(422, "Range must be 0-92 days")
    from . import inventory
    ctx, t = catalog.load_ctx(db), today(s)
    return [{"date": d, **pricing.date_status(d, ctx, t), "priceAdj": pricing.price_adj(d, ctx), "remaining": inventory.remaining(db, ctx, d)}
            for d in (pricing.add_days(date_from.isoformat(), i) for i in range((date_to - date_from).days + 1))]


@shop.post("/quote")
def post_quote(body: QuoteIn, db: Session = Depends(get_db), s=Depends(cfg)):
    return quote_out(*quote(db, s, body.visit_date.isoformat(), body.cart.model_dump()))
