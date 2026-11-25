"""Authoritative date & price engine: a line-for-line port of src/store.ts (dateStatus, priceAdj, offerApplies,
offerUnit, validateCoupon, priceCart).

The browser keeps its copy only to preview prices while the customer builds a cart; every booking is re-priced
here. tests/test_pricing_parity.py replays a fixture produced by the TypeScript engine
(scripts/pricing-fixture.ts) so the two cannot drift silently.

Arithmetic deliberately mirrors JavaScript: prices are whole rupees, intermediate percentages are IEEE doubles,
and js_round() is Math.round (half-up), not Python's banker's rounding.
"""
import math
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
HOLIDAY_SEASON_FROM = "2026-12-20"  # same constant as store.ts priceAdj


def js_round(x: float) -> int:
    return math.floor(x + 0.5)


def today_ist(demo_today: str | None = None) -> str:
    """The park's 'today' (ISO date). DEMO_TODAY pins it for demos and tests; never set it in production."""
    return demo_today or datetime.now(IST).date().isoformat()


def parse(d: str) -> date:
    return date.fromisoformat(d)


def add_days(d: str, n: int) -> str:
    return (parse(d) + timedelta(days=n)).isoformat()


def dow(d: str) -> int:
    return (parse(d).weekday() + 1) % 7  # JS getDay(): Sunday = 0


def is_weekend(d: str) -> bool:
    return dow(d) in (0, 6)


def date_status(d: str, ctx: dict, today: str) -> dict:
    c = ctx["dateCfg"].get(d) or {}
    s = ctx["settings"]
    if d < today:
        return {"open": False, "reason": "Past date"}
    if d < s["saleStart"] or d > s["saleEnd"]:
        return {"open": False, "reason": "Not on sale"}
    if c.get("enabled") is False:
        return {"open": False, "reason": c.get("note") or "Park closed"}
    if c.get("blackout"):
        return {"open": False, "reason": c.get("note") or "Blackout date"}
    return {"open": True, "reason": ""}


def price_adj(d: str, ctx: dict) -> float:
    c = ctx["dateCfg"].get(d)
    if c and isinstance(c.get("priceAdj"), (int, float)) and not isinstance(c.get("priceAdj"), bool):
        return c["priceAdj"]
    if d >= HOLIDAY_SEASON_FROM:
        return 15
    if is_weekend(d):
        return 10
    return 0


def ticket_price(cat: dict, d: str, ctx: dict) -> int:
    return js_round((cat["basePrice"] * (100 + price_adj(d, ctx))) / 100)


def offer_applies(o: dict, d: str, booked_on: str) -> bool:
    if not (o["status"] == "active" or (o["status"] == "scheduled" and o["bookingStart"] <= booked_on)):
        return False
    if booked_on < o["bookingStart"] or booked_on > o["bookingEnd"]:
        return False
    if d < o["visitStart"] or d > o["visitEnd"]:
        return False
    if o["weekdays"] and dow(d) not in o["weekdays"]:
        return False
    if o["dates"] and d not in o["dates"]:
        return False
    if o["redemptions"] >= o["maxRedemptions"]:
        return False
    return True


def eligible_offers(offers: list, d: str, booked_on: str) -> list:
    return sorted((o for o in offers if offer_applies(o, d, booked_on)), key=lambda o: o["priority"])


def _inr(n: float) -> str:
    return "₹" + f"{js_round(n):,}"  # labels only; never compared by the parity test


def offer_unit(o: dict, d: str, ctx: dict) -> dict | None:
    cats = {t["id"]: t for t in ctx["tickets"]}
    if o["type"] == "package":
        orig, ts = 0, []
        for cid, q in o["packageContents"].items():
            c = cats.get(cid)
            if not c or not q:
                continue
            orig += ticket_price(c, d, ctx) * q
            ts.append({"catId": cid, "qty": q})
        if not ts:
            return None
        return {"original": orig, "price": o["packagePrice"], "tickets": ts,
                "label": " + ".join(f"{t['qty']}× {cats[t['catId']]['name']}" for t in ts), "benefit": f"Save {_inr(orig - o['packagePrice'])}"}
    c = cats.get(o["categories"][0]) if o["categories"] else None
    if not c:
        return None
    p = ticket_price(c, d, ctx)
    if o["type"] == "bxgy":
        n = o["buyX"] + o["getY"]
        return {"original": p * n, "price": p * o["buyX"], "tickets": [{"catId": c["id"], "qty": n, "free": o["getY"]}],
                "label": f"{n}× {c['name']} ({o['getY']} free)", "benefit": f"{o['getY']} tickets free"}
    if o["type"] == "percent":
        return {"original": p, "price": js_round(p * (1 - o["value"] / 100)), "tickets": [{"catId": c["id"], "qty": 1}],
                "label": f"1× {c['name']}", "benefit": f"{o['value']}% off"}
    return {"original": p, "price": max(0, p - o["value"]), "tickets": [{"catId": c["id"], "qty": 1}],
            "label": f"1× {c['name']}", "benefit": f"{_inr(o['value'])} off"}


def validate_coupon(code: str, cart: dict, d: str, ctx: dict, booked_on: str) -> tuple[dict | None, str]:
    if not code:
        return None, ""
    o = next((x for x in ctx["offers"] if x["coupon"] and x["coupon"].upper() == code.strip().upper()), None)
    if not o:
        return None, "This coupon code is not valid."
    if o["status"] in ("paused", "draft"):
        return None, "This coupon is currently not active."
    if not offer_applies(o, d, booked_on):
        return None, f"{o['coupon']} is not valid for this date."
    eligible_qty = sum(cart["tickets"].get(cid, 0) for cid in o["categories"])
    if eligible_qty == 0:
        return None, f"Add eligible tickets to use {o['coupon']}."
    if eligible_qty < o["minQty"]:
        return None, f"{o['coupon']} needs at least {o['minQty']} eligible tickets."
    if any(q > 0 for q in cart["offers"].values()) and o["categories"]:
        offers = {x["id"]: x for x in ctx["offers"]}
        blocking = next((offers[i] for i, q in cart["offers"].items() if q > 0 and i in offers and offers[i]["type"] == "bxgy"), None)
        if blocking:
            return None, f"{o['coupon']} can't be combined with {blocking['name']}."
    return o, ""


def price_cart(cart: dict, d: str, ctx: dict, booked_on: str) -> dict:
    """Same result shape as store.ts Priced (camelCase), minus couponOffer which is returned as couponOfferId."""
    lines, issues = [], []
    ticket_count = complimentary = offer_savings = 0
    for c in ctx["tickets"]:
        q = cart["tickets"].get(c["id"], 0)
        if not q or not c["active"]:
            continue
        u = ticket_price(c, d, ctx)
        lines.append({"kind": "ticket", "refId": c["id"], "label": c["name"], "detail": "Fast Track" if c["kind"] == "fasttrack" else "General",
                      "qty": q, "unit": u, "original": u * q, "amount": u * q})
        ticket_count += q
    offers = {x["id"]: x for x in ctx["offers"]}
    for oid, q in cart["offers"].items():
        if not q:
            continue
        o = offers.get(oid)
        if not o:
            continue
        if not offer_applies(o, d, booked_on):
            issues.append(f"{o['name']} is not available on this date")
            continue
        u = offer_unit(o, d, ctx)
        if not u:
            continue
        if o["type"] in ("percent", "flat") and q < o["minQty"]:
            issues.append(f"{o['name']} needs minimum {o['minQty']} tickets")
        lines.append({"kind": "offer", "refId": o["id"], "label": o["name"], "detail": u["label"], "qty": q, "unit": u["price"],
                      "original": u["original"] * q, "amount": u["price"] * q})
        offer_savings += (u["original"] - u["price"]) * q
        for t in u["tickets"]:
            ticket_count += t["qty"] * q
            complimentary += t.get("free", 0) * q
    addons_total = 0
    for a in ctx["addons"]:
        q = cart["addons"].get(a["id"], 0)
        if not q:
            continue
        lines.append({"kind": "addon", "refId": a["id"], "label": a["name"], "detail": "Add-on", "qty": q, "unit": a["price"],
                      "original": a["price"] * q, "amount": a["price"] * q})
        addons_total += a["price"] * q
    coupon, coupon_error = validate_coupon(cart.get("coupon", ""), cart, d, ctx, booked_on)
    coupon_discount = 0
    if coupon:
        for ln in lines:
            if ln["kind"] == "ticket" and ln["refId"] in coupon["categories"]:
                coupon_discount += (js_round((ln["amount"] * coupon["value"]) / 100) if coupon["type"] == "percent"
                                    else min(ln["unit"], coupon["value"]) * ln["qty"])
    ticket_gross = sum(ln["original"] for ln in lines if ln["kind"] != "addon")
    subtotal = ticket_gross + addons_total
    taxable = subtotal - offer_savings - coupon_discount
    tax = js_round((taxable * ctx["settings"]["gst"]) / 100)
    return {"lines": lines, "ticketGross": ticket_gross, "offerSavings": offer_savings, "couponDiscount": coupon_discount,
            "couponOfferId": coupon["id"] if coupon else None, "couponError": coupon_error, "addonsTotal": addons_total,
            "subtotal": subtotal, "taxable": taxable, "tax": tax, "total": taxable + tax, "complimentary": complimentary,
            "ticketCount": ticket_count, "issues": issues}


def ticket_units(priced: dict, ctx: dict) -> list[dict]:
    """The admissions a priced cart issues, in buildBooking's order: [{catId, label, offerId, complimentary}]."""
    cats = {t["id"]: t for t in ctx["tickets"]}
    offers = {o["id"]: o for o in ctx["offers"]}
    out = []
    for ln in priced["lines"]:
        if ln["kind"] == "ticket":
            out += [{"catId": ln["refId"], "label": ln["label"], "offerId": None, "complimentary": False}] * ln["qty"]
        elif ln["kind"] == "offer":
            o = offers[ln["refId"]]
            if o["type"] == "package":
                contents = [{"catId": c, "qty": q, "free": 0} for c, q in o["packageContents"].items()]
            elif o["type"] == "bxgy":
                contents = [{"catId": o["categories"][0], "qty": o["buyX"] + o["getY"], "free": o["getY"]}]
            else:
                contents = [{"catId": o["categories"][0], "qty": 1, "free": 0}]
            for _ in range(ln["qty"]):
                for c in contents:
                    for i in range(c["qty"]):
                        name = cats[c["catId"]]["name"] if c["catId"] in cats else c["catId"]
                        out.append({"catId": c["catId"], "label": name, "offerId": o["id"], "complimentary": bool(c["free"]) and i >= c["qty"] - c["free"]})
    return out
