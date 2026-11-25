"""Staff authentication, sessions, roles and CSRF; no unauthenticated access to customer records."""
from dataclasses import replace

import pytest
from sqlalchemy import select

from app.models import AuthSession, User
from .conftest import ADMIN, CSRF, STAFF_PW, TODAY, login, make_staff, paid_booking


def test_passwords_are_argon2id_and_never_returned(client, db):
    make_staff(db, roles="admin")
    u = db.scalar(select(User))
    assert u.password_hash.startswith("$argon2id$") and STAFF_PW not in u.password_hash
    r = login(client)
    assert r.status_code == 200 and "password" not in r.text and r.json()["roles"] == ["admin"]
    assert "httponly" in r.headers["set-cookie"].lower() and "samesite=lax" in r.headers["set-cookie"].lower()
    assert db.scalar(select(AuthSession.token_hash)) not in r.headers["set-cookie"]  # only a hash is stored


def test_login_failures_lock_the_account(client, db):
    make_staff(db)
    assert login(client, password="wrong-password").status_code == 401
    assert login(client, code="NOBODY1").status_code == 401
    for _ in range(4):
        login(client, password="wrong-password")
    r = login(client)  # correct password, but locked after 5 failures
    assert r.status_code == 401 and "Too many" in r.json()["detail"]


def test_roles_are_enforced(client, db):
    make_staff(db, code="GATE01", roles="gate")
    login(client, code="GATE01")
    assert client.get("/api/auth/me").json()["roles"] == ["gate"]
    assert client.get("/api/admin/bookings").status_code == 403
    assert client.get("/api/admin/influencers").status_code == 403
    assert client.post("/api/counter/sales", json={}, headers=CSRF).status_code == 403
    assert client.get("/api/gate/scans").status_code == 200


def test_session_cookie_writes_need_csrf_header(client, db):
    make_staff(db, code="GATE02", roles="gate")
    _, b = paid_booking(client, visit_date=TODAY)
    login(client, code="GATE02")
    assert client.post("/api/gate/scan", json={"code": b["tickets"][0]["qr"]}).status_code == 403
    r = client.post("/api/gate/scan", json={"code": b["tickets"][0]["qr"]}, headers=CSRF)
    assert r.status_code == 200 and r.json()["kind"] == "valid"


def test_logout_and_deactivation_end_sessions(client, db):
    make_staff(db, code="ADM100", roles="admin")
    make_staff(db, code="CNT100", roles="counter")
    login(client, code="CNT100")
    assert client.get("/api/admin/bookings").status_code == 200
    client.post("/api/auth/logout")
    assert client.get("/api/admin/bookings").status_code == 401
    login(client, code="CNT100")
    other = client.__class__(client.app)
    login(other, code="ADM100")
    assert other.patch("/api/admin/users/CNT100", json={"active": False}, headers=CSRF).status_code == 200
    assert client.get("/api/admin/bookings").status_code == 401
    assert login(client, code="CNT100").status_code == 401


def test_admin_manages_users_and_passwords(client, db):
    make_staff(db, code="ADM200", roles="admin")
    login(client, code="ADM200")
    r = client.post("/api/admin/users", json={"code": "stf3001", "name": "Priya", "roles": ["gate"], "gate": "Water Park Gate",
                                             "password": "short"}, headers=CSRF)
    assert r.status_code == 422
    r = client.post("/api/admin/users", json={"code": "stf3001", "name": "Priya", "roles": ["gate", "owner"], "password": "long-enough-pw"}, headers=CSRF)
    assert r.status_code == 422
    r = client.post("/api/admin/users", json={"code": "stf3001", "name": "Priya", "roles": ["gate"], "gate": "Water Park Gate",
                                             "password": "long-enough-pw"}, headers=CSRF)
    assert r.status_code == 201 and r.json()["id"] == "STF3001" and "password" not in r.json()
    assert client.post("/api/admin/users", json={"code": "STF3001", "name": "Dup", "roles": ["gate"], "password": "long-enough-pw"},
                       headers=CSRF).status_code == 409
    assert [u["id"] for u in client.get("/api/admin/users").json()] == ["ADM200", "STF3001"]
    assert client.post("/api/auth/password", json={"current": "nope", "new": "another-long-pw"}, headers=CSRF).status_code == 403
    assert client.post("/api/auth/password", json={"current": STAFF_PW, "new": "another-long-pw"}, headers=CSRF).status_code == 204
    assert client.get("/api/auth/me").status_code == 200  # this browser stays signed in
    client.post("/api/auth/logout")
    assert login(client, code="ADM200", password="another-long-pw").status_code == 200


def test_admin_token_is_break_glass_only_when_strong(app, client):
    assert client.get("/api/admin/bookings", headers=ADMIN).status_code == 200
    app.state.settings = replace(app.state.settings, admin_api_token="")
    assert client.get("/api/admin/bookings", headers=ADMIN).status_code == 401


STAFF_PREFIXES = ("/api/admin", "/api/counter", "/api/gate")
# FastAPI 0.16x wraps included routers, so the route table is read from the OpenAPI schema.
STAFF_ROUTES = [(m.upper(), path) for path, ops in __import__("app.main", fromlist=["app"]).app.openapi()["paths"].items()
                if path.startswith(STAFF_PREFIXES) for m in ops]


def test_route_table_was_found():
    assert len(STAFF_ROUTES) >= 20


@pytest.mark.parametrize("method,path", STAFF_ROUTES, ids=lambda x: str(x))
def test_every_staff_route_requires_authentication(client, method, path):
    r = client.request(method, path.replace("{", "").replace("}", ""), json={})  # any placeholder value
    assert r.status_code == 401, (method, path, r.status_code)


def test_customer_records_are_not_reachable_without_credentials(client):
    created, b = paid_booking(client)
    assert client.get(f"/api/bookings/{b['id']}").status_code == 404
    assert client.get("/api/admin/bookings").status_code == 401
    assert "9876543210" not in client.get("/api/catalog").text
