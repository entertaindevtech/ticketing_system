"""Cancellation requests, admin decisions, refunds, modifications — and that each step is audited."""
from datetime import date

from sqlalchemy import select

from app.models import AuditLog, CategoryInventory, DateInventory, InfluencerCommission, Payment, Refund, Ticket, utcnow
from .conftest import ADMIN, book, click, make_influencer, paid_booking

D = date(2026, 12, 2)


def cancel_request(client, created):
    return client.post(f"/api/bookings/{created['booking']['id']}/cancellation-request", headers={"X-Booking-Token": created["accessToken"]})


def audit_types(db, ref):
    return [(a.type, a.actor) for a in db.scalars(select(AuditLog).where(AuditLog.ref == ref).order_by(AuditLog.id))]


def test_customer_request_then_admin_approval_cancels_refunds_and_reverses_commission(client, db):
    make_influencer(client, code="CXL001")
    created, b = paid_booking(client, session_token=click(client, code="CXL001").json()["session_token"])
    ref = b["id"]
    r = cancel_request(client, created)
    assert r.status_code == 201, r.text
    j = r.json()
    # 25% provisional fee: 3005 * 0.25 = 751.25 -> 751; refund 2254. Booking stays valid until decided.
    assert j["refund"]["status"] == "pending" and j["refund"]["deduction"] == 751 and j["refund"]["amount"] == 2254
    assert j["status"] == "confirmed" and all(t["status"] == "valid" for t in j["tickets"])
    assert cancel_request(client, created).status_code == 409  # one request only

    a = client.post(f"/api/admin/bookings/{ref}/cancellation/approve", headers=ADMIN)
    assert a.status_code == 200, a.text
    j = a.json()
    assert j["status"] == "cancelled" and j["payment"]["status"] == "refunded" and j["refund"]["status"] == "approved"
    assert {t["status"] for t in j["tickets"]} == {"cancelled"}
    assert j["refunds"][0]["status"] == "succeeded" and j["refunds"][0]["amount"] == 2254
    assert db.scalar(select(Payment.status).where(Payment.kind == "charge")) == "partially_refunded"
    assert db.get(DateInventory, D).sold == 0 and db.get(CategoryInventory, (D, "ga")).sold == 0
    assert db.scalar(select(InfluencerCommission.status)) == "reversed"
    assert audit_types(db, ref) == [("booking", "Customer"), ("booking", "System"), ("cancellation", "Customer"),
                                    ("refund", "ADMIN"), ("refund", "ADMIN")]
    assert client.post(f"/api/admin/bookings/{ref}/cancellation/approve", headers=ADMIN).status_code == 409


def test_rejection_keeps_booking_valid_and_records_reason(client):
    created, b = paid_booking(client)
    cancel_request(client, created)
    assert client.post(f"/api/admin/bookings/{b['id']}/cancellation/reject", json={"reason": "x"}, headers=ADMIN).status_code == 422
    j = client.post(f"/api/admin/bookings/{b['id']}/cancellation/reject", json={"reason": "Visit date is a peak day"}, headers=ADMIN).json()
    assert j["status"] == "confirmed" and j["refund"]["status"] == "rejected" and j["refund"]["rejectionReason"] == "Visit date is a peak day"
    assert cancel_request(client, created).status_code == 409  # already reviewed


def test_cancellation_eligibility_rules(client, db):
    soon, _ = paid_booking(client, visit_date="2026-11-21")  # inside 48 h of 20 Nov
    assert "48 hours" in cancel_request(client, soon).json()["detail"]
    offer, _ = paid_booking(client, cart={"offers": {"o-family": 1}})
    assert "offer" in cancel_request(client, offer).json()["detail"]
    unpaid = book(client).json()
    assert "paid" in cancel_request(client, unpaid).json()["detail"]
    used, b = paid_booking(client)
    t = db.scalar(select(Ticket).where(Ticket.code == b["tickets"][0]["id"]))
    t.status, t.used_at = "used", utcnow()
    db.commit()
    assert "used" in cancel_request(client, used).json()["detail"]


def test_admin_cancel_applies_fee_and_needs_admin(client):
    _, b = paid_booking(client)
    assert client.post(f"/api/admin/bookings/{b['id']}/cancel").status_code == 401
    j = client.post(f"/api/admin/bookings/{b['id']}/cancel", headers=ADMIN).json()
    assert j["status"] == "cancelled" and j["refund"]["deduction"] == 751 and j["refund"]["status"] == "approved"
    assert client.post(f"/api/admin/bookings/{b['id']}/cancel", headers=ADMIN).status_code == 409


def test_modification_keeps_ticket_codes_moves_inventory_and_records_difference(client, db):
    make_influencer(client, code="MOD777", rate=10)
    _, b = paid_booking(client, session_token=click(client, code="MOD777").json()["session_token"])
    old_codes = {t["id"] for t in b["tickets"]}
    url = f"/api/admin/bookings/{b['id']}/modify"
    body = {"visit_date": "2026-12-09", "tickets": {"ga": 3}, "addons": {"food": 1}}
    dry = client.post(url, json={**body, "dry_run": True}, headers=ADMIN).json()
    assert dry["dryRun"] and dry["difference"] == 1297  # +1 adult 1099 + GST 198
    assert db.get(DateInventory, D).sold == 2  # dry run changed nothing
    r = client.post(url, json=body, headers=ADMIN).json()
    nb = r["booking"]
    assert r["settlement"] == "collect" and nb["visitDate"] == "2026-12-09" and nb["totals"]["total"] == 4302
    codes = {t["id"] for t in nb["tickets"] if t["status"] == "valid"}
    assert old_codes < codes and len(codes) == 3 and set(r["keptTickets"]) == old_codes
    db.expire_all()
    assert db.get(DateInventory, D).sold == 0 and db.get(DateInventory, date(2026, 12, 9)).sold == 3
    diff = db.scalar(select(Payment).where(Payment.kind == "difference"))
    assert diff.status == "created" and float(diff.amount) == 1297
    assert nb["modifications"][0]["previousTotal"] == 3005 and nb["modifications"][0]["newTotal"] == 4302
    assert float(db.scalar(select(InfluencerCommission.amount))) == 329.7  # 3297 ticket net * 10%, never a second commission
    assert client.post(f"/api/admin/payments/{diff.id}/collect", json={"method": "Cash"}, headers=ADMIN).json()["status"] == "captured"
    # lowering the booking creates a refund for the difference
    r2 = client.post(url, json={"visit_date": "2026-12-09", "tickets": {"ga": 1}, "addons": {}}, headers=ADMIN).json()
    assert r2["settlement"] == "refund" and r2["booking"]["refunds"][-1]["status"] == "pending"
    rid = db.scalar(select(Refund.id).where(Refund.modification_id.is_not(None)))
    assert client.post(f"/api/admin/refunds/{rid}/process", headers=ADMIN).json()["status"] == "succeeded"


def test_modification_rules(client):
    _, coupon = paid_booking(client, cart={"tickets": {"ga": 2}, "coupon": "MGM30"})
    r = client.post(f"/api/admin/bookings/{coupon['id']}/modify", json={"visit_date": "2026-12-09", "tickets": {"ga": 2}}, headers=ADMIN)
    assert r.status_code == 409 and "coupon" in r.json()["detail"]
    _, b = paid_booking(client)
    r = client.post(f"/api/admin/bookings/{b['id']}/modify", json={"visit_date": "2026-12-03", "tickets": {"ga": 2}}, headers=ADMIN)
    assert r.status_code == 422  # blackout date
    r = client.post(f"/api/admin/bookings/{b['id']}/modify", json={"visit_date": "2026-12-09", "tickets": {}}, headers=ADMIN)
    assert r.status_code == 422


def test_staff_booking_list_requires_auth_and_hides_nothing_from_staff(client):
    paid_booking(client)
    assert client.get("/api/admin/bookings").status_code == 401
    rows = client.get("/api/admin/bookings", headers=ADMIN).json()
    assert len(rows) == 1 and rows[0]["customer"]["phone"] == "9876543210" and rows[0]["tickets"][0]["qr"] is None
