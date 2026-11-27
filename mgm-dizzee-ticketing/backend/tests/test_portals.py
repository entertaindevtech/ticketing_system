"""Four portals: / (customer), /admin, /counter and /staff each serve their own page from the shared backend."""
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def web(settings, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "staff").mkdir()
    for f, text in (("index.html", "CUSTOMER"), ("admin.html", "ADMIN"), ("counter.html", "COUNTER"), ("staff.html", "STAFF"),
                    ("staff-sw.js", "SW"), ("staff/manifest.json", "{}"), ("assets/app.js", "JS")):
        (dist / f).write_text(text)
    (tmp_path / "secret.txt").write_text("outside dist")
    return TestClient(create_app(replace(settings, frontend_dist=str(dist))), follow_redirects=False)


@pytest.mark.parametrize("path,page", [
    ("/", "CUSTOMER"), ("/?ref=RAHUL01&campaign=diwali", "CUSTOMER"),  # influencer links stay on the customer site
    ("/admin", "ADMIN"), ("/admin/", "ADMIN"), ("/admin/bookings", "ADMIN"),
    ("/counter", "COUNTER"), ("/counter/", "COUNTER"), ("/counter/sale/2", "COUNTER"),
    ("/staff", "STAFF"), ("/staff/scan", "STAFF"), ("/staff.html", "STAFF"),  # /staff.html: existing PWA installs
    ("/unknown-page", "CUSTOMER"), ("/administrator", "CUSTOMER"), ("/counters", "CUSTOMER"),  # prefixes match whole segments
])
def test_each_portal_serves_its_own_page_on_direct_access_and_refresh(web, path, page):
    r = web.get(path)
    assert r.status_code == 200 and r.text == page, path


def test_static_files_service_worker_and_manifest_are_served_as_files(web):
    assert web.get("/staff-sw.js").text == "SW"
    assert web.get("/staff/manifest.json").text == "{}"
    assert web.get("/assets/app.js").text == "JS"


def test_api_routes_are_never_answered_by_a_page(web):
    assert web.get("/api/health").status_code == 200 and "status" in web.get("/api/health").json()
    for p in ("/api/nope", "/api", "/api/admin/state", "/api/gate/scans"):
        r = web.get(p)
        assert r.status_code in (401, 403, 404) and r.headers["content-type"].startswith("application/json"), p


def test_paths_outside_dist_are_not_served(web):
    assert web.get("/..%2Fsecret.txt").text != "outside dist"


def test_each_portals_apis_are_enforced_server_side_by_role(client, db):
    """Hiding a portal's links is not the protection: each account type gets 403 from the other portals' APIs."""
    from .conftest import CSRF, CUSTOMER, TODAY, login, make_staff
    sale = {"visit_date": TODAY, "cart": {"tickets": {"ga": 1}}, "customer": CUSTOMER, "method": "Cash"}
    probes = {
        "counter sale": lambda: client.post("/api/counter/sales", json=sale, headers=CSRF),
        "admin state": lambda: client.get("/api/admin/state", headers=CSRF),
        "staff accounts": lambda: client.get("/api/admin/users", headers=CSRF),
        "gate scan": lambda: client.post("/api/gate/scan", json={"code": "TKT-NOPE0000"}, headers=CSRF),
        "gate booking lookup": lambda: client.post("/api/gate/booking", json={"code": "MGM-NOPE00"}, headers=CSRF),
    }
    expected = {  # role -> probes it may use (everything else must be 403)
        "counter": {"counter sale"},
        "gate": {"gate scan", "gate booking lookup"},
        "finance": {"admin state"},
        "marketing": set(),
        "admin": set(probes),
    }
    for role, allowed in expected.items():
        make_staff(db, code=f"P{role[:3].upper()}01", roles=role)
        assert login(client, code=f"P{role[:3].upper()}01").status_code == 200
        for name, call in probes.items():
            code = call().status_code
            assert (code != 403) if name in allowed else (code == 403), (role, name, code)
        client.cookies.clear()
    for name, call in probes.items():
        assert call().status_code == 401, name  # signed out
