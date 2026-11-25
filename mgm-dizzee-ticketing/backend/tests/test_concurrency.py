"""Real concurrency against PostgreSQL (skipped on SQLite, which serializes writers and so proves nothing here).

Each worker uses its own session/connection and starts together on a barrier, then commits or rolls back exactly
as the API does.
"""
import threading
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app import bookings
from app.models import BookingAttribution, Booking, CategoryInventory, InfluencerCommission, Offer, PaymentEvent, Ticket, TicketCategory
from .conftest import CUSTOMER

pytestmark = pytest.mark.usefixtures("app")


@pytest.fixture(autouse=True)
def _postgres_only(app):
    if app.state.engine.dialect.name != "postgresql":
        pytest.skip("concurrency tests need PostgreSQL (set TEST_DATABASE_URL)")


def race(app, n, fn):
    """Run fn(session, i) in n threads at once; returns list of results or exceptions."""
    barrier, out = threading.Barrier(n), [None] * n

    def worker(i):
        s = app.state.sessionmaker()
        try:
            barrier.wait()
            out[i] = fn(s, i)
            s.commit()
        except Exception as e:  # noqa: BLE001 - collected for assertions
            s.rollback()
            out[i] = e
        finally:
            s.close()
    ts = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    return out


def create(s, settings, cart, key=None, phone="9876543210"):
    return bookings.create_booking(s, settings, visit_date="2026-12-02", cart=cart, customer={**CUSTOMER, "phone": phone},
                                   idempotency_key=key)[0].ref


def test_concurrent_bookings_never_oversell_category_or_park(app, db, settings):
    db.get(TicketCategory, "fa").daily_limit = 10
    db.commit()
    res = race(app, 30, lambda s, i: create(s, settings, {"tickets": {"fa": 1}, "offers": {}, "addons": {}, "coupon": ""}, phone=f"98765{i:05d}"))
    ok = [r for r in res if isinstance(r, str)]
    assert len(ok) == 10 and all(isinstance(r, bookings.Conflict) for r in res if not isinstance(r, str))
    db.expire_all()
    inv = db.get(CategoryInventory, (__import__("datetime").date(2026, 12, 2), "fa"))
    assert inv.held == 10 and inv.held + inv.sold <= inv.capacity


def test_concurrent_duplicate_captures_issue_once(app, db, settings):
    s = app.state.sessionmaker()
    ref = create(s, settings, {"tickets": {"ga": 3}, "offers": {}, "addons": {}, "coupon": ""})
    b = bookings.get_booking(s, ref)
    p = bookings.start_payment(s, b, "simulated", "UPI")
    s.commit()
    pid, total = p.id, Decimal(b.total)
    s.close()
    res = race(app, 10, lambda s, i: bookings.capture_payment(s, settings, payment_id=pid, provider="simulated",
                                                              provider_payment_id=f"simpay_{pid}", amount=total, event_id=f"sim:{pid}:captured").status)
    assert all(r == "confirmed" for r in res), res
    assert db.scalar(select(func.count()).select_from(Ticket)) == 3
    assert db.scalar(select(func.count()).select_from(PaymentEvent)) == 1
    assert db.scalar(select(func.count()).select_from(BookingAttribution)) == 1


def test_last_offer_redemption_goes_to_exactly_one_booking(app, db, settings):
    db.get(Offer, "o-family").max_redemptions = 1
    db.commit()
    res = race(app, 6, lambda s, i: create(s, settings, {"tickets": {}, "offers": {"o-family": 1}, "addons": {}, "coupon": ""}, phone=f"91234{i:05d}"))
    assert sum(isinstance(r, str) for r in res) == 1
    assert all(isinstance(r, (bookings.Conflict, bookings.Invalid)) for r in res if not isinstance(r, str))
    db.expire_all()
    assert db.get(Offer, "o-family").redemptions == 1


def test_same_idempotency_key_concurrently_creates_one_booking(app, db, settings):
    res = race(app, 5, lambda s, i: create(s, settings, {"tickets": {"ga": 1}, "offers": {}, "addons": {}, "coupon": ""}, key="same-key"))
    refs = {r for r in res if isinstance(r, str)}
    assert len(refs) == 1  # losers hit the unique key (the API then returns the winner's booking)
    assert db.scalar(select(func.count()).select_from(Booking)) == 1
    db.expire_all()
    assert db.get(CategoryInventory, (__import__("datetime").date(2026, 12, 2), "ga")).held == 1


def test_commission_created_once_under_concurrent_capture(app, db, settings, client):
    from .conftest import click, make_influencer
    make_influencer(client, code="CONC01")
    tok = click(client, code="CONC01").json()["session_token"]
    s = app.state.sessionmaker()
    b, _ = bookings.create_booking(s, settings, visit_date="2026-12-02", cart={"tickets": {"ga": 2}, "offers": {}, "addons": {}, "coupon": ""},
                                   customer=CUSTOMER, session_token=tok)
    p = bookings.start_payment(s, b, "simulated", "UPI")
    s.commit()
    pid, total = p.id, Decimal(b.total)
    s.close()
    race(app, 8, lambda s, i: bookings.capture_payment(s, settings, payment_id=pid, provider="simulated", provider_payment_id=f"simpay_{pid}",
                                                       amount=total, event_id=f"evt-{i % 2}"))
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 1
    assert db.scalar(select(func.count()).select_from(Ticket)) == 2


def test_concurrent_scans_admit_a_ticket_exactly_once(app, db, settings, client):
    from app import gate
    from .conftest import TODAY, paid_booking
    _, b = paid_booking(client, visit_date=TODAY)
    qr = b["tickets"][0]["qr"]
    res = race(app, 8, lambda s, i: gate.scan(s, settings, raw=qr, gate=f"Gate {i}", staff_code=f"STF{i}", device_id=f"d{i}", client_scan_id="1")["kind"])
    assert sorted(res).count("valid") == 1 and res.count("duplicate") == 7, res
