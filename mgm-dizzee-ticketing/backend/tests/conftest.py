import os

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Base
from app.main import create_app

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
                    public_app_url="https://book.example.test", frontend_dist=str(tmp_path / "nodist"))


@pytest.fixture
def app(settings):
    a = create_app(settings)
    Base.metadata.create_all(a.state.engine)
    a.state.geo = FakeGeo()
    yield a
    Base.metadata.drop_all(a.state.engine)
    a.state.engine.dispose()


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture
def db(app):
    s = app.state.sessionmaker()
    yield s
    s.close()


def make_influencer(client, code="RAHUL01", rate=8, name="Rahul Sharma", platform="Instagram"):
    r = client.post("/api/admin/influencers", json={"name": name, "platform": platform, "referral_code": code, "commission_rate": rate}, headers=ADMIN)
    assert r.status_code == 201, r.text
    return r.json()


def click(client, code="RAHUL01", ip="49.36.10.10", token=None, campaign=None):
    return client.post("/api/referrals/click", json={"code": code, "session_token": token, "campaign": campaign}, headers={"X-Forwarded-For": ip})


# A booking as the front-end reports it: 2 adults @1099 (2198) + one add-on 349, 18% GST.
BOOKING = {"tickets": 2, "subtotal": 2547, "discount": 0, "addons": 349, "tax": 458, "total": 3005, "visit_date": "2026-12-05"}


def pay(client, ref, token, status="paid", **over):
    return client.post("/api/booking-events/paid", json={**BOOKING, "booking_ref": ref, "session_token": token, "payment_status": status, "payment_ref": "pay_X", **over})
