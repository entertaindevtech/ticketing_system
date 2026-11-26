import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from fastapi.testclient import TestClient

from app.catalog import seed_catalog
from app.config import Settings
from app.db import Base
from app.main import create_app

# Load backend/.env.test (git-ignored) without a dependency; a variable already set in the shell wins, empty values are skipped.
_env = os.path.join(os.path.dirname(__file__), "..", ".env.test")
if os.path.exists(_env):
    for _line in open(_env, encoding="utf-8-sig"):
        _k, _, _v = _line.strip().partition("=")
        if _k and not _k.startswith("#") and _v.strip():
            os.environ.setdefault(_k.strip(), _v.strip().strip("'\""))

TODAY = "2026-11-20"  # a Friday; the park's clock is pinned in tests (DEMO_TODAY)
ADMIN = {"X-Admin-Token": "test-admin-token-0123456789abcdef"}


class FakeGeo:
    """Stands in for the GeoLite2 reader: maps test IPs to records."""
    def __init__(self):
        self.table = {
            "49.36.10.10": {"geo_country_code": "IN", "geo_country": "India", "geo_region": "Tamil Nadu", "geo_city": "Chennai"},
            "49.36.20.20": {"geo_country_code": "IN", "geo_country": "India", "geo_region": "Karnataka", "geo_city": "Bengaluru"},
            "49.36.30.30": {"geo_country_code": "IN", "geo_country": "India", "geo_region": None, "geo_city": None},
            "8.8.8.8": {"geo_country_code": "US", "geo_country": "United States", "geo_region": "California", "geo_city": None},
        }
        self.calls = []
        self.available = True

    def lookup(self, ip):
        self.calls.append(ip)
        return dict(self.table.get(ip, {"geo_country_code": None, "geo_country": None, "geo_region": None, "geo_city": None}))


@pytest.fixture
def settings(tmp_path):
    # Set TEST_DATABASE_URL (e.g. a throwaway PostgreSQL database) to run the suite on Postgres; tables are dropped after each test.
    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / 'test.db'}"
    return Settings(database_url=url, admin_api_token="test-admin-token-0123456789abcdef",
                    public_app_url="https://book.example.test", frontend_dist=str(tmp_path / "nodist"), demo_today=TODAY)


@pytest.fixture
def app(settings):
    a = create_app(settings)
    Base.metadata.create_all(a.state.engine)
    with a.state.sessionmaker() as s:
        seed_catalog(s)
    a.state.geo = FakeGeo()
    yield a
    Base.metadata.drop_all(a.state.engine)
    a.state.engine.dispose()


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture
def db(app):
    # The test's own inspection session. On SQLite it uses a plain engine whose reads don't hold a transaction
    # open (the app's engine is fully transactional, and a long-lived reader would lock out its writes).
    eng = app.state.engine
    if eng.dialect.name == "sqlite":
        eng = create_engine(eng.url, connect_args={"check_same_thread": False})
    s = Session(eng, expire_on_commit=False)
    yield s
    s.close()
    if eng is not app.state.engine:
        eng.dispose()


def make_influencer(client, code="RAHUL01", rate=8, name="Rahul Sharma", platform="Instagram"):
    r = client.post("/api/admin/influencers", json={"name": name, "platform": platform, "referral_code": code, "commission_rate": rate}, headers=ADMIN)
    assert r.status_code == 201, r.text
    return r.json()


def click(client, code="RAHUL01", ip="49.36.10.10", token=None, campaign=None):
    return visit(client, ip=ip, token=token, ref=code, campaign=campaign)


def visit(client, ip="49.36.10.10", token=None, referrer=None, **params):
    """A page load as the front-end reports it (src/referral.ts captureVisit)."""
    return client.post("/api/visits", json={"session_token": token, "referrer": referrer, **params}, headers={"X-Real-IP": ip})


class Result:
    def __init__(self, status_code, data):
        self.status_code, self._data = status_code, data

    def json(self):
        return self._data


def pay(client, label, token, status="paid", cart=None):
    """A website booking made through the real engine (server pricing, simulated provider). `label` is the
    Idempotency-Key, so repeating a label replays the same booking (like a retried payment callback).
    Default cart: 2 adults on Wed 2 Dec + one meal = 2547, GST 458, total 3005. status: paid | failed | pending.
    Returns what was recorded for attribution: {recorded, attributed, influencer_code, source}."""
    from sqlalchemy import select as _select
    from app.models import BookingAttribution, Influencer
    r = book(client, cart=cart, session_token=token, key=label)
    if r.status_code != 201:
        return r
    created = r.json()
    ref = created["booking"]["id"]
    client.__dict__.setdefault("refs", {})[label] = ref
    if status != "pending" and created["booking"]["state"] == "pending_payment":
        pay_sim(client, created, "success" if status == "paid" else "decline")
    with client.app.state.sessionmaker() as s:
        a = s.scalar(_select(BookingAttribution).where(BookingAttribution.booking_ref == ref))
        code = s.get(Influencer, a.influencer_id).referral_code if a and a.influencer_id else None
        return Result(200, {"recorded": a is not None, "attributed": code is not None, "influencer_code": code, "source": a.source if a else None})


def ref_of(client, label):
    return client.__dict__["refs"][label]


def cancel(client, label):
    """Admin cancel & refund through the booking engine (reverses any commission)."""
    return client.post(f"/api/admin/bookings/{ref_of(client, label)}/cancel", headers=ADMIN)


def modify(client, label, tickets, addons=None, visit_date="2026-12-02"):
    return client.post(f"/api/admin/bookings/{ref_of(client, label)}/modify", headers=ADMIN,
                       json={"visit_date": visit_date, "tickets": tickets, "addons": {"food": 1} if addons is None else addons})


# ---------- booking engine helpers ----------
CUSTOMER = {"name": "Test Customer", "phone": "9876543210", "email": "test@example.com"}
CART = {"tickets": {"ga": 2}, "addons": {"food": 1}}  # Wed 2 Dec: 2198 + 349 = 2547, GST 458 -> 3005


def book(client, cart=None, visit_date="2026-12-02", session_token=None, key=None, customer=None):
    h = {"Idempotency-Key": key} if key else {}
    return client.post("/api/bookings", json={"visit_date": visit_date, "cart": cart or CART, "customer": customer or CUSTOMER,
                                              "session_token": session_token}, headers=h)


def pay_sim(client, created, outcome="success", method="UPI"):
    ref, tok = created["booking"]["id"], created["accessToken"]
    h = {"X-Booking-Token": tok}
    p = client.post(f"/api/bookings/{ref}/payments", json={"method": method}, headers=h)
    assert p.status_code == 201, p.text
    return client.post(f"/api/bookings/{ref}/payments/{p.json()['payment_id']}/simulate", json={"outcome": outcome}, headers=h)


def paid_booking(client, **kw):
    r = book(client, **kw)
    assert r.status_code == 201, r.text
    created = r.json()
    res = pay_sim(client, created)
    assert res.status_code == 200, res.text
    return created, res.json()


# ---------- staff accounts ----------
CSRF = {"X-Requested-With": "mgm-app"}
STAFF_PW = "correct-horse-battery"


def make_staff(db, code="STF2001", roles="gate", gate="Main Gate A", password=STAFF_PW, active=True):
    from app import auth
    from app.models import User
    u = User(code=code, name=f"Staff {code}", roles=roles, gate=gate, password_hash=auth.hash_password(password), active=active)
    db.add(u)
    db.commit()
    return u


def login(client, code="STF2001", password=STAFF_PW):
    return client.post("/api/auth/login", json={"code": code, "password": password})
