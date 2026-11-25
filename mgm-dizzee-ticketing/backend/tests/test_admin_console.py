"""Admin console data, catalog/settings management, ledger-based analytics, legacy import, demo seed."""
from datetime import date

from sqlalchemy import func, select

from app import demo_seed
from app.models import Booking, BookingAttribution, CategoryInventory, User
from .conftest import ADMIN, TODAY, book, click, login, make_influencer, make_staff, paid_booking


def test_state_is_staff_only_and_contains_the_whole_console_dataset(client, db):
    paid_booking(client)
    make_staff(db, code="GATE09", roles="gate")
    st = client.get("/api/admin/state", headers=ADMIN).json()
    assert {o["id"] for o in st["offers"]} >= {"c-mgm30", "o-nye"}  # admins see coupons and drafts
    assert len(st["bookings"]) == 1 and st["bookings"][0]["totals"]["total"] == 3005
    assert st["staff"][0]["id"] == "GATE09" and "password" not in str(st["staff"])
    assert st["auditLog"] and st["notifications"] and st["today"] == TODAY
    login(client, code="GATE09")
    assert client.get("/api/admin/state").status_code == 403


def test_capacity_edits_sync_inventory_and_refuse_going_below_sold(client, db):
    paid_booking(client, cart={"tickets": {"fa": 3}})
    t = next(x for x in client.get("/api/admin/state", headers=ADMIN).json()["tickets"] if x["id"] == "fa")
    r = client.put("/api/admin/ticket-categories/fa", json={**t, "dailyLimit": 2}, headers=ADMIN)
    assert r.status_code == 422 and "already booked" in r.json()["detail"]
    assert client.put("/api/admin/ticket-categories/fa", json={**t, "dailyLimit": 5, "basePrice": 1899}, headers=ADMIN).status_code == 200
    db.expire_all()
    assert db.get(CategoryInventory, (date(2026, 12, 2), "fa")).capacity == 5
    assert book(client, cart={"tickets": {"fa": 3}}).status_code == 409
    q = client.post("/api/quote", json={"visit_date": "2026-12-02", "cart": {"tickets": {"fa": 1}}}).json()
    assert q["subtotal"] == 1899
    assert client.put("/api/admin/park-dates/2026-12-02", json={"capacity": 2}, headers=ADMIN).status_code == 422
    assert client.put("/api/admin/park-dates/2026-12-10", json={"capacity": 1, "note": "Event"}, headers=ADMIN).status_code == 200
    assert book(client, visit_date="2026-12-10").status_code == 409


def test_settings_and_offers_are_managed_through_the_api(client, db):
    assert client.patch("/api/admin/settings", json={"cancellationFeePct": 10}, headers=ADMIN).json()["cancellationFeePct"] == 10
    assert client.patch("/api/admin/settings", json={"gst": 150}, headers=ADMIN).status_code == 422
    assert client.patch("/api/admin/settings", json={"bogus": 1}, headers=ADMIN).status_code == 422
    created, b = paid_booking(client)
    r = client.post(f"/api/bookings/{b['id']}/cancellation-request", headers={"X-Booking-Token": created["accessToken"]}).json()
    assert r["refund"]["deduction"] == 301  # 10% of 3005 = 300.5, rounded half-up as in the prototype
    st = client.get("/api/admin/state", headers=ADMIN).json()
    fam = next(o for o in st["offers"] if o["id"] == "o-family")
    assert client.put("/api/admin/offers/o-family", json={**fam, "packagePrice": 3299}, headers=ADMIN).json()["packagePrice"] == 3299
    new = {**fam, "id": "o-new", "name": "Diwali Duo", "packageContents": {"ga": 2}, "packagePrice": 1999, "status": "draft"}
    assert client.put("/api/admin/offers/o-new", json=new, headers=ADMIN).status_code == 200
    assert client.put("/api/admin/offers/o-bad", json={**new, "id": "o-bad", "packageContents": {"zz": 1}}, headers=ADMIN).status_code == 422
    assert client.delete("/api/admin/offers/o-new", headers=ADMIN).status_code == 200
    paid_booking(client, cart={"offers": {"o-family": 1}})
    assert client.delete("/api/admin/offers/o-family", headers=ADMIN).status_code == 409
    n = client.get("/api/admin/state", headers=ADMIN).json()["notifications"]
    assert client.post("/api/admin/notifications/read-all", headers=ADMIN).status_code == 200
    assert all(x["read"] for x in client.get("/api/admin/state", headers=ADMIN).json()["notifications"]) and n


def test_regional_analytics_follow_the_booking_ledger_including_counter_sales(client, db):
    make_influencer(client, code="LEDG01")
    tok = click(client, code="LEDG01", ip="49.36.20.20").json()["session_token"]
    _, web = paid_booking(client, session_token=tok)                       # Karnataka, influencer, 3005
    _, other = paid_booking(client, cart={"tickets": {"ga": 1}})           # no session -> unknown, 1297
    client.post("/api/counter/sales", json={"visit_date": TODAY, "cart": {"tickets": {"ga": 2}}, "method": "Cash",
                                            "customer": {"name": "Walk In", "phone": "9123456789"}}, headers=ADMIN)  # 2594
    client.post(f"/api/admin/bookings/{other['id']}/cancel", headers=ADMIN)  # cancelled: no longer revenue
    r = client.get("/api/admin/regional", headers=ADMIN).json()
    ledger = db.scalar(select(func.sum(Booking.total)).where(Booking.status == "confirmed"))
    assert r["summary"]["revenue"] == float(ledger) == 3005 + 2594
    assert r["summary"]["paid_bookings"] == 2 and r["summary"]["bookings"] == 3
    assert r["summary"]["counter"]["revenue"] == 2594 and r["summary"]["website"]["revenue"] == 3005
    assert r["summary"]["unknown_location_bookings"] == 0  # the cancelled one isn't paid; counter isn't website traffic
    src = {x["source"]: x for x in r["sources"]}
    assert src["counter"]["paid_bookings"] == 1 and src["influencer"]["paid_bookings"] == 1
    assert {x["state"] for x in r["states"] if x["paid_bookings"]} == {"Karnataka"}
    assert db.scalar(select(func.count()).select_from(BookingAttribution).where(BookingAttribution.booking_id.is_(None))) == 0
    inf = client.get("/api/admin/analytics", headers=ADMIN).json()
    assert inf["summary"]["paid_bookings"] == 1 and inf["summary"]["revenue"] == 3005  # influencer report stays influencer-only


LEGACY = {
    "id": "MGM-OLD777", "live": True, "createdAt": "2026-11-18T10:00:00", "visitDate": TODAY, "status": "confirmed",
    "customer": {"name": "Legacy Guest", "phone": "9840012345", "email": "", "visitors": 2, "notes": ""},
    "items": [{"label": "General Adult", "qty": 2, "amount": 2198, "kind": "ticket", "refId": "ga"}],
    "offerIds": [], "coupon": "", "totals": {"subtotal": 2198, "discount": 0, "addons": 0, "tax": 396, "total": 2594, "complimentary": 0},
    "payment": {"txnId": "pay_X", "method": "UPI", "status": "paid", "gateway": "Razorpay", "at": "2026-11-18T10:00:00"},
    "tickets": [{"id": "TKT-LEGACY01", "catId": "ga", "label": "General Adult", "status": "valid"},
                {"id": "TKT-LEGACY02", "catId": "ga", "label": "General Adult", "status": "used"}],
}


def test_legacy_import_is_idempotent_never_overwrites_and_keeps_tickets_scannable(client, db):
    # an attribution row reported by the retired browser events for the same booking gets linked, not duplicated
    db.add(BookingAttribution(booking_ref="MGM-OLD777", source="direct", paid_at=__import__("app.models", fromlist=["x"]).utcnow(),
                              tickets=2, ticket_net_amount=2198, addons_amount=0, tax_amount=396, total_amount=2594))
    db.commit()
    _, existing = paid_booking(client)
    batch = [LEGACY, {**LEGACY, "id": existing["id"]}, {**LEGACY, "id": "MGM-DEMO01", "live": False},
             {**LEGACY, "id": "MGM-UNPAID", "payment": {"status": "pending"}}, {**LEGACY, "id": "MGM-BAD01", "customer": {}}]
    r = client.post("/api/admin/legacy-import", json={"bookings": batch}, headers=ADMIN).json()
    assert [x["result"] for x in r["results"]] == ["imported", "conflict", "rejected", "rejected", "rejected"]
    again = client.post("/api/admin/legacy-import", json={"bookings": [LEGACY]}, headers=ADMIN).json()
    assert again["results"][0]["result"] == "already_present"
    b = client.get("/api/admin/bookings/MGM-OLD777", headers=ADMIN).json()
    assert b["origin"] == "legacy_import" and [t["status"] for t in b["tickets"]] == ["valid", "used"]
    assert db.scalar(select(BookingAttribution.booking_id).where(BookingAttribution.booking_ref == "MGM-OLD777")) is not None
    legacy_qr = f"MGMDW1|TKT-LEGACY01|MGM-OLD777|{TODAY}|ABCD"
    assert client.post("/api/gate/scan", json={"code": legacy_qr}, headers=ADMIN).json()["kind"] == "valid"
    assert client.post("/api/gate/scan", json={"code": "MGMDW1|TKT-NOTREAL1|X|Y|Z"}, headers=ADMIN).json()["kind"] == "invalid"
    assert client.get("/api/admin/bookings", params={"q": existing["id"]}, headers=ADMIN).json()[0]["origin"] == "live"


def test_demo_seed_creates_role_accounts_and_engine_bookings(db, settings):
    out = demo_seed.seed_demo(db, settings, bookings_per_day=2, days=5)
    assert "ADM001" in out and "password:" in out
    assert {u.roles for u in db.scalars(select(User))} == {"admin", "finance", "counter", "marketing", "gate"}
    n = db.scalar(select(func.count()).select_from(Booking).where(Booking.origin == "demo_seed", Booking.status == "confirmed"))
    assert n >= 8
    assert "already present" in demo_seed.seed_demo(db, settings)
