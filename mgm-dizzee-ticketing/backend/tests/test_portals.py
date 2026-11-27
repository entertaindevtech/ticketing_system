"""Separate portals: /customer, /admin and /staff each serve their own page; / redirects to /customer."""
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def web(settings, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "staff").mkdir()
    for f, text in (("index.html", "CUSTOMER"), ("admin.html", "ADMIN"), ("staff.html", "STAFF"), ("staff-sw.js", "SW"),
                    ("staff/manifest.json", "{}"), ("assets/app.js", "JS")):
        (dist / f).write_text(text)
    (tmp_path / "secret.txt").write_text("outside dist")
    return TestClient(create_app(replace(settings, frontend_dist=str(dist))), follow_redirects=False)


def test_root_redirects_to_customer_and_keeps_referral_query(web):
    r = web.get("/")
    assert r.status_code == 302 and r.headers["location"] == "/customer"
    assert web.get("/?ref=RAHUL01&campaign=diwali").headers["location"] == "/customer?ref=RAHUL01&campaign=diwali"


@pytest.mark.parametrize("path,page", [
    ("/customer", "CUSTOMER"), ("/customer/anything/deep", "CUSTOMER"),
    ("/admin", "ADMIN"), ("/admin/bookings", "ADMIN"),
    ("/staff", "STAFF"), ("/staff/scan", "STAFF"), ("/staff.html", "STAFF"),
    ("/unknown-page", "CUSTOMER"),
])
def test_each_portal_serves_its_own_page_on_direct_access_and_refresh(web, path, page):
    r = web.get(path)
    assert r.status_code == 200 and r.text == page


def test_static_files_service_worker_and_manifest_are_served_as_files(web):
    assert web.get("/staff-sw.js").text == "SW"
    assert web.get("/staff/manifest.json").text == "{}"
    assert web.get("/assets/app.js").text == "JS"


def test_api_routes_are_never_answered_by_a_page(web):
    assert web.get("/api/health").status_code == 200 and "status" in web.get("/api/health").json()
    for p in ("/api/nope", "/api", "/api/admin/state"):
        r = web.get(p)
        assert r.status_code in (401, 403, 404) and r.headers["content-type"].startswith("application/json"), p


def test_paths_outside_dist_are_not_served(web):
    assert web.get("/..%2Fsecret.txt").text != "outside dist"
