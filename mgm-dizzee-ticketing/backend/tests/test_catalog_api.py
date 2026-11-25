from app import catalog
from app.models import Offer


def test_catalog_is_public_but_hides_coupons_and_drafts(client):
    c = client.get("/api/catalog").json()
    assert c["today"] == "2026-11-20" and c["settings"]["cancellationFeePct"] == 25
    assert [t["id"] for t in c["tickets"]] == ["ga", "gc", "fa", "fc"]
    ids = {o["id"] for o in c["offers"]}
    assert "o-family" in ids and not ids & {"c-mgm30", "c-fast150", "c-dizzee10", "o-nye"}
    assert all(not o["coupon"] for o in c["offers"])
    assert c["dateCfg"]["2026-12-03"]["blackout"] is True


def test_quote_is_server_priced_and_validates_coupons(client):
    # 2 adults on a Wednesday (no adjustment) + a meal: 2198 + 349 = 2547, GST 18% = 458 -> 3005
    q = client.post("/api/quote", json={"visit_date": "2026-12-02", "cart": {"tickets": {"ga": 2}, "addons": {"food": 1}}}).json()
    assert (q["subtotal"], q["tax"], q["total"], q["ticketCount"]) == (2547, 458, 3005, 2)
    assert q["dateStatus"] == {"open": True, "reason": ""}
    q = client.post("/api/quote", json={"visit_date": "2026-12-02", "cart": {"tickets": {"ga": 2}, "coupon": "mgm30"}}).json()
    assert q["couponDiscount"] == 659 and q["couponOffer"]["id"] == "c-mgm30"
    q = client.post("/api/quote", json={"visit_date": "2026-12-02", "cart": {"tickets": {"ga": 2}, "coupon": "DIZZEE10"}}).json()
    assert q["couponDiscount"] == 0 and q["couponError"]
    assert client.post("/api/quote", json={"visit_date": "2026-12-03", "cart": {"tickets": {"ga": 1}}}).json()["dateStatus"]["open"] is False
    assert client.post("/api/quote", json={"visit_date": "2026-11-19", "cart": {"tickets": {"ga": 1}}}).json()["dateStatus"]["reason"] == "Past date"


def test_quote_rejects_bad_quantities(client):
    for bad in ({"ga": -1}, {"ga": 101}, {"x" * 40: 1}):
        assert client.post("/api/quote", json={"visit_date": "2026-12-02", "cart": {"tickets": bad}}).status_code == 422


def test_availability_reports_closed_dates_and_tiers(client):
    days = {d["date"]: d for d in client.get("/api/availability", params={"from": "2026-11-23", "to": "2026-12-26"}).json()}
    assert days["2026-11-24"]["open"] is False and days["2026-11-24"]["reason"] == "Annual ride maintenance"
    assert days["2026-11-28"]["priceAdj"] == 10 and days["2026-12-22"]["priceAdj"] == 15 and days["2026-12-25"]["priceAdj"] == 25
    assert client.get("/api/availability", params={"from": "2026-11-01", "to": "2027-03-01"}).status_code == 422


def test_offer_edit_keeps_server_redemption_counter(db):
    o = db.get(Offer, "o-family")
    o.redemptions = 7
    db.commit()
    dto = catalog.offer_dto(o)
    dto.update(redemptions=0, maxRedemptions=50, name="Family Fun")
    out = catalog.upsert_offer(db, dto, {"ga", "gc", "fa", "fc"})
    db.commit()
    assert out["redemptions"] == 7 and out["maxRedemptions"] == 50 and db.get(Offer, "o-family").data["name"] == "Family Fun"
