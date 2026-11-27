"""Centralized booking engine: server pricing, holds, simulated payment capture, tickets, idempotency, attribution."""
from datetime import date, timedelta

import pytest
from sqlalchemy import func, select

from app import bookings, security, services
from app.models import (
    BookingAttribution, Booking, CategoryInventory, DateInventory, InfluencerCommission, Offer, ParkDate, Payment, PaymentEvent, Ticket,
    TicketCategory, utcnow,
)
from .conftest import ADMIN, CART, book, click, make_influencer, paid_booking, pay_sim

D = date(2026, 12, 2)


def inv(db, cat="ga", d=D):
    db.expire_all()
    r, c = db.get(DateInventory, d), db.get(CategoryInventory, (d, cat))
    return (r.held, r.sold, c.held, c.sold) if r else None


def test_booking_is_priced_held_and_pending_until_paid(client, db):
    r = book(client)
    assert r.status_code == 201, r.text
    b = r.json()["booking"]
    assert b["state"] == "pending_payment" and b["payment"]["status"] == "pending" and b["tickets"] == []
    assert b["totals"]["total"] == 3005 and b["totals"]["tax"] == 458 and b["customer"]["visitors"] == 2
    assert b["id"].startswith("MGM-") and len(b["id"]) == 10
    assert inv(db) == (2, 0, 2, 0)


def test_client_supplied_prices_are_ignored(client):
    r = client.post("/api/bookings", json={"visit_date": "2026-12-02", "cart": {**CART, "price": 1}, "total": 1, "customer": {
        "name": "X Y", "phone": "9876543210"}, "totals": {"total": 1}})
    assert r.status_code == 201 and r.json()["booking"]["totals"]["total"] == 3005


def test_payment_capture_confirms_issues_signed_tickets_and_records_attribution(client, db, settings):
    created, b = paid_booking(client)
    assert b["state"] == "confirmed" and b["payment"]["status"] == "paid" and len(b["tickets"]) == 2
    t = b["tickets"][0]
    assert t["status"] == "valid" and t["qr"] == security.qr_payload(settings.app_secret, t["id"], b["id"], "2026-12-02")
    assert inv(db) == (0, 2, 0, 2)
    a = db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == b["id"]))
    assert a.booking_id is not None and a.channel == "web" and float(a.total_amount) == 3005 and a.influencer_id is None


def test_access_token_required_to_view_or_pay(client, settings):
    created = book(client).json()
    ref = created["booking"]["id"]
    assert client.get(f"/api/bookings/{ref}").status_code == 404
    assert client.get(f"/api/bookings/{ref}", headers={"X-Booking-Token": "wrong"}).status_code == 404
    assert client.post(f"/api/bookings/{ref}/payments", json={}, headers={"X-Booking-Token": "wrong"}).status_code == 404
    assert client.get(f"/api/bookings/{ref}", headers={"X-Booking-Token": created["accessToken"]}).json()["id"] == ref
    assert created["accessUrl"] == f"https://book.example.test/customer#booking/{ref}/{created['accessToken']}"


def test_browser_cannot_confirm_payment_when_simulation_is_off(app, client, db):
    from dataclasses import replace
    created = book(client).json()
    app.state.settings = replace(app.state.settings, simulated_payments=False)
    h = {"X-Booking-Token": created["accessToken"]}
    ref = created["booking"]["id"]
    assert client.post(f"/api/bookings/{ref}/payments", json={}, headers=h).status_code == 503
    assert client.post(f"/api/bookings/{ref}/payments/1/simulate", json={"outcome": "success"}, headers=h).status_code == 404
    # the retired browser event path cannot confirm anything either
    client.post("/api/booking-events/paid", json={"booking_ref": ref, "payment_status": "paid", "tickets": 2, "subtotal": 1,
                                                  "discount": 0, "addons": 0, "tax": 0, "total": 1})
    db.expire_all()
    assert db.scalar(select(Booking).where(Booking.ref == ref)).status == "pending_payment"
    assert db.scalar(select(func.count()).select_from(Ticket)) == 0


def test_duplicate_payment_events_issue_tickets_and_commission_once(client, db):
    make_influencer(client, code="DUP001")
    tok = click(client, code="DUP001").json()["session_token"]
    created = book(client, session_token=tok).json()
    first = pay_sim(client, created).json()
    pid = db.scalar(select(Payment.id))
    again = client.post(f"/api/bookings/{created['booking']['id']}/payments/{pid}/simulate", json={"outcome": "success"},
                        headers={"X-Booking-Token": created["accessToken"]})
    assert again.status_code == 200 and again.json()["tickets"] == first["tickets"]
    assert db.scalar(select(func.count()).select_from(Ticket)) == 2
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 1
    assert db.scalar(select(func.count()).select_from(PaymentEvent)) == 1
    # a second capture call for the same payment with a different event id is still a no-op
    bookings.capture_payment(db, client.app.state.settings, payment_id=pid, provider="simulated", provider_payment_id=f"simpay_{pid}",
                             amount=first["totals"]["total"], event_id="replayed-elsewhere")
    db.commit()
    assert db.scalar(select(func.count()).select_from(Ticket)) == 2


def test_failure_mid_capture_leaves_no_partial_state(client, db, monkeypatch):
    created = book(client).json()

    def boom(*a, **k):
        raise RuntimeError("attribution store down")
    monkeypatch.setattr(services, "confirm_payment", boom)
    with pytest.raises(RuntimeError):
        pay_sim(client, created)
    db.expire_all()
    b = db.scalar(select(Booking))
    assert b.status == "pending_payment" and b.tickets == [] and inv(db) == (2, 0, 2, 0)
    assert db.scalar(select(Payment.status)) == "created" and db.scalar(select(func.count()).select_from(PaymentEvent)) == 0
    monkeypatch.undo()
    assert pay_sim(client, created).json()["state"] == "confirmed"  # the retry succeeds cleanly


def test_declined_payment_keeps_booking_pending_and_auditable(client, db):
    created = book(client).json()
    r = pay_sim(client, created, outcome="decline").json()
    assert r["state"] == "pending_payment" and r["tickets"] == []
    assert db.scalar(select(Payment.status)) == "failed"
    assert pay_sim(client, created).json()["state"] == "confirmed"  # customer retries with a new payment attempt


def test_category_limit_and_park_capacity_prevent_overselling(client, db):
    db.get(TicketCategory, "fa").daily_limit = 3
    db.add(ParkDate(visit_date=date(2026, 12, 9), data={"capacity": 5}))
    db.commit()
    assert book(client, cart={"tickets": {"fa": 2}}).status_code == 201
    r = book(client, cart={"tickets": {"fa": 2}})
    assert r.status_code == 409 and "fa" in r.json()["detail"]
    assert book(client, cart={"tickets": {"fa": 1}}).status_code == 201
    assert book(client, cart={"tickets": {"ga": 4}}, visit_date="2026-12-09").status_code == 201
    assert book(client, cart={"tickets": {"gc": 2}}, visit_date="2026-12-09").status_code == 409  # park-wide 5
    assert inv(db, "fa") == (3, 0, 3, 0)
    avail = {d["date"]: d for d in client.get("/api/availability", params={"from": "2026-12-02", "to": "2026-12-09"}).json()}
    assert avail["2026-12-02"]["remaining"]["fa"] == 0 and avail["2026-12-09"]["remaining"]["total"] == 1


def test_expired_hold_releases_stock_and_offer_and_late_payment_rereserves(client, db):
    created = book(client, cart={"tickets": {}, "offers": {"o-family": 1}}).json()
    assert db.get(Offer, "o-family").redemptions == 1 and inv(db, "gc") == (4, 0, 2, 0)
    b = db.scalar(select(Booking))
    b.hold_expires_at = utcnow() - timedelta(minutes=1)
    db.commit()
    assert bookings.expire_holds(db) == 1
    db.commit()
    assert db.get(Booking, b.id).status == "expired" and inv(db, "gc") == (0, 0, 0, 0)
    assert db.get(Offer, "o-family").redemptions == 0
    # payment arriving after expiry is accepted only because the stock is still there
    r = client.post(f"/api/bookings/{created['booking']['id']}/payments", json={}, headers={"X-Booking-Token": created["accessToken"]})
    assert r.status_code == 409  # no new payment can be started for an expired booking
    p = Payment(booking_id=b.id, provider="simulated", amount=b.total, status="created")
    db.add(p)
    db.commit()
    bookings.capture_payment(db, client.app.state.settings, payment_id=p.id, provider="simulated", provider_payment_id="late1",
                             amount=b.total, event_id="late-1")
    db.commit()
    db.expire_all()
    assert db.get(Booking, b.id).status == "confirmed" and inv(db, "gc") == (0, 4, 0, 2) and db.get(Offer, "o-family").redemptions == 1


def test_offer_redemption_limit_is_enforced(client, db):
    db.get(Offer, "o-family").max_redemptions = 1
    db.commit()
    assert book(client, cart={"offers": {"o-family": 1}}).status_code == 201
    r = book(client, cart={"offers": {"o-family": 1}})
    assert r.status_code == 422 and "not available" in r.json()["detail"]  # exhausted offers are no longer offered
    # (two bookings racing for the last redemption get 409 for the loser: tests/test_concurrency.py)


def test_idempotency_key_replays_and_rejects_reuse(client, db):
    a = book(client, key="checkout-123")
    b = book(client, key="checkout-123")
    assert a.status_code == b.status_code == 201 and a.json()["booking"]["id"] == b.json()["booking"]["id"]
    assert inv(db) == (2, 0, 2, 0)  # held once
    assert book(client, key="checkout-123", cart={"tickets": {"ga": 3}}).status_code == 409


def test_invalid_bookings_are_rejected(client):
    assert book(client, visit_date="2026-12-03").status_code == 422  # blackout
    assert book(client, visit_date="2026-11-19").status_code == 422  # past
    assert book(client, cart={"tickets": {"ga": 2}, "coupon": "NOPE"}).status_code == 422
    assert book(client, cart={"addons": {"food": 1}}).status_code == 422  # no ticket
    assert book(client, customer={"name": "X Y", "phone": "12345"}).status_code == 422


def test_influencer_booking_through_engine_earns_commission_on_server_amounts(client, db):
    make_influencer(client, code="ENG001", rate=10)
    tok = click(client, code="ENG001").json()["session_token"]
    paid_booking(client, session_token=tok, cart={"tickets": {"ga": 2}, "addons": {"food": 1}, "coupon": "MGM30"})
    c = db.scalar(select(InfluencerCommission))
    # ticket net = 2198 - 659 (MGM30) = 1539; 10% = 153.90
    assert float(c.basis_amount) == 1539 and float(c.amount) == 153.9
