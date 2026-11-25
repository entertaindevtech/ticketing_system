"""Counter sales (shared inventory, never attributed) and gate validation (signed QR, atomic admit)."""
from dataclasses import replace

from sqlalchemy import func, select

from app import security
from app.models import BookingAttribution, GateScan, InfluencerCommission, TicketCategory
from .conftest import ADMIN, CUSTOMER, TODAY, book, click, make_influencer, paid_booking


def counter(client, cart=None, visit_date=TODAY, key=None, method="Cash"):
    h = {**ADMIN, **({"Idempotency-Key": key} if key else {})}
    return client.post("/api/counter/sales", json={"visit_date": visit_date, "cart": cart or {"tickets": {"ga": 2}},
                                                   "customer": CUSTOMER, "method": method}, headers=h)


def scan(client, code, **kw):
    return client.post("/api/gate/scan", json={"code": code, **kw}, headers=ADMIN)


def test_counter_sale_is_confirmed_reported_and_never_attributed(client, db):
    make_influencer(client, code="WALKIN")
    click(client, code="WALKIN")  # an influencer session exists in the system; counter sales cannot use it
    r = counter(client, cart={"tickets": {"ga": 2}, "addons": {"food": 1}}, method="UPI")
    assert r.status_code == 201, r.text
    b = r.json()
    assert b["state"] == "confirmed" and b["counterSale"] and b["payment"]["method"] == "UPI" and len(b["tickets"]) == 2
    a = db.scalar(select(BookingAttribution))
    assert a.channel == "counter" and a.source == "counter" and a.influencer_id is None and a.session_id is None
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 0
    assert client.post("/api/counter/sales", json={}).status_code in (401, 422)
    assert client.post("/api/counter/sales", json={"visit_date": TODAY, "cart": {"tickets": {"ga": 1}}, "customer": CUSTOMER,
                                                   "method": "Cash"}).status_code == 401


def test_counter_and_website_share_inventory(client, db):
    db.get(TicketCategory, "fa").daily_limit = 3
    db.commit()
    assert book(client, cart={"tickets": {"fa": 1}}, visit_date=TODAY).status_code == 201
    assert counter(client, cart={"tickets": {"fa": 3}}).status_code == 409
    assert counter(client, cart={"tickets": {"fa": 2}}).status_code == 201
    assert book(client, cart={"tickets": {"fa": 1}}, visit_date=TODAY).status_code == 409


def test_counter_sale_idempotency(client, db):
    a, b = counter(client, key="till-7-0001").json(), counter(client, key="till-7-0001").json()
    assert a["id"] == b["id"] and len(b["tickets"]) == 2


def test_gate_admits_once_then_reports_duplicate_with_previous_entry(client, db):
    _, b = paid_booking(client, visit_date=TODAY)
    qr = b["tickets"][0]["qr"]
    r = scan(client, qr, gate="Main Gate B").json()
    assert r["kind"] == "valid" and r["booking"]["id"] == b["id"] and r["ticket"]["status"] == "used"
    r2 = scan(client, qr).json()
    assert r2["kind"] == "duplicate" and r2["previous"]["gate"] == "Main Gate B"
    assert scan(client, b["tickets"][1]["id"].lower()).json()["kind"] == "valid"  # typed code works too


def test_gate_rejects_forged_tampered_cancelled_unpaid_and_wrong_day(app, client, db, settings):
    _, b = paid_booking(client, visit_date=TODAY)
    t = b["tickets"][0]
    forged = security.qr_payload("someone-elses-secret-0000000000000000", t["id"], b["id"], TODAY)
    assert "signature" in scan(client, forged).json()["reason"]
    assert "signature" in scan(client, t["qr"].replace(TODAY, "2026-11-21")).json()["reason"]
    assert "not found" in scan(client, "TKT-ZZZZZZZZ").json()["reason"]
    unpaid = book(client, visit_date=TODAY).json()
    assert unpaid["booking"]["tickets"] == []  # no tickets exist before payment, so there is nothing to scan
    _, future = paid_booking(client, visit_date="2026-12-02")
    assert "Wrong visit date" in scan(client, future["tickets"][0]["qr"]).json()["reason"]
    app.state.settings = replace(app.state.settings, demo_today="2026-12-05")
    assert "expired" in scan(client, future["tickets"][0]["qr"]).json()["reason"]
    app.state.settings = replace(app.state.settings, demo_today=TODAY)
    client.post(f"/api/admin/bookings/{b['id']}/cancel", headers=ADMIN)
    assert scan(client, t["qr"]).json()["reason"] == "Ticket cancelled"
    assert db.scalar(select(func.count()).select_from(GateScan).where(GateScan.result == "valid")) == 0


def test_modified_booking_invalidates_old_qr_but_keeps_ticket(client, db):
    _, b = paid_booking(client, visit_date="2026-12-02")
    old = b["tickets"][0]
    client.post(f"/api/admin/bookings/{b['id']}/modify", json={"visit_date": TODAY, "tickets": {"ga": 2}, "addons": {"food": 1}}, headers=ADMIN)
    assert "Outdated QR" in scan(client, old["qr"]).json()["reason"]
    fresh = client.get(f"/api/admin/bookings/{b['id']}", headers=ADMIN).json()["tickets"][0]
    assert fresh["id"] == old["id"] and scan(client, fresh["qr"]).json()["kind"] == "valid"


def test_scanner_retry_with_same_client_scan_id_is_not_a_second_scan(client, db):
    _, b = paid_booking(client, visit_date=TODAY)
    qr = b["tickets"][0]["qr"]
    a = scan(client, qr, device_id="dev-1", client_scan_id="s-1").json()
    again = scan(client, qr, device_id="dev-1", client_scan_id="s-1").json()
    assert a["kind"] == again["kind"] == "valid" and a["scanId"] == again["scanId"]
    assert db.scalar(select(func.count()).select_from(GateScan)) == 1
    mine = client.get("/api/gate/scans", headers=ADMIN).json()
    assert len(mine) == 1 and mine[0]["result"] == "valid" and mine[0]["bookingId"] == b["id"]
