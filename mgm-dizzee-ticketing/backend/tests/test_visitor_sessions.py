from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.acquisition import classify, referrer_host
from app.models import BookingAttribution, InfluencerCommission, VisitorSession, utcnow

from .conftest import ADMIN, BOOKING, click, make_influencer, pay, visit

OWN = {"book.example.test"}


def session_of(db, tok):
    return db.scalar(select(VisitorSession).where(VisitorSession.token == tok))


# ---------- acquisition classification ----------
@pytest.mark.parametrize("kw,expected", [
    ({"influencer": True, "utm": {"utm_medium": "cpc"}}, "influencer"),
    ({}, "direct"),
    ({"ref_host": "book.example.test"}, "direct"),
    ({"ref_host": "google.co.in"}, "organic"),
    ({"ref_host": "bing.com"}, "organic"),
    ({"ref_host": "l.instagram.com"}, "social"),
    ({"ref_host": "t.co"}, "social"),
    ({"ref_host": "chennaitravelblog.in"}, "referral"),
    ({"utm": {"utm_medium": "cpc", "utm_source": "google"}}, "paid"),
    ({"utm": {"utm_medium": "social", "utm_source": "facebook"}}, "social"),
    ({"utm": {"utm_medium": "email", "utm_campaign": "diwali"}}, "paid"),  # any other tagged campaign
    ({"click_ids": {"gclid"}, "ref_host": "google.com"}, "paid"),
    ({"utm": {"utm_medium": "organic"}}, "organic"),
])
def test_classification_rules(kw, expected):
    args = {"influencer": False, "utm": {}, "click_ids": set(), "ref_host": None, "own_hosts": OWN, **kw}
    assert classify(**args) == expected


def test_referrer_is_reduced_to_host():
    assert referrer_host("https://www.google.co.in/search?q=mgm+tickets+chennai") == "google.co.in"
    assert referrer_host("not a url") is None and referrer_host(None) is None


# ---------- visitor sessions ----------
def test_direct_visitor_gets_session_with_region(client, db, app):
    r = visit(client).json()
    s = session_of(db, r["session_token"])
    assert r["tracked"] and r["created"] and r["source"] == "direct" and r["attributed_code"] is None
    assert (s.geo_region, s.geo_city, s.influencer_id) == ("Tamil Nadu", "Chennai", None)
    assert app.state.geo.calls == ["49.36.10.10"]


def test_influencer_visitor_gets_session_with_region_and_attribution(client, db):
    make_influencer(client)
    r = click(client, ip="49.36.20.20", campaign="summer").json()
    s = session_of(db, r["session_token"])
    assert (r["source"], r["attributed_code"], s.geo_city, s.campaign) == ("influencer", "RAHUL01", "Bengaluru", "summer")


def test_sources_and_utm_capture(client, db):
    assert visit(client, referrer="https://www.google.com/").json()["source"] == "organic"
    assert visit(client, referrer="https://someblog.example.org/post").json()["source"] == "referral"
    r = visit(client, utm_source="Google", utm_medium="CPC", utm_campaign="Xmas-2026", utm_content="banner1", utm_term="water park").json()
    s = session_of(db, r["session_token"])
    assert r["source"] == "paid"
    assert (s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term) == ("google", "cpc", "xmas-2026", "banner1", "water park")
    assert s.referrer_host is None


def test_session_persists_without_new_lookup_or_reclassification(client, db, app):
    tok = visit(client, referrer="https://www.google.com/").json()["session_token"]
    r = visit(client, token=tok, utm_medium="cpc").json()  # returning visitor, new campaign tag
    assert r["session_token"] == tok and not r["created"] and r["source"] == "organic"  # first touch kept
    assert len(app.state.geo.calls) == 1
    assert db.scalar(select(func.count()).select_from(VisitorSession)) == 1


def test_expired_session_is_replaced(client, db):
    tok = visit(client).json()["session_token"]
    s = session_of(db, tok)
    s.created_at, s.expires_at = utcnow() - timedelta(days=31), utcnow() - timedelta(days=1)
    db.commit()
    r = visit(client, token=tok).json()
    assert r["created"] and r["session_token"] != tok


def test_bots_are_not_tracked(client, db):
    r = client.post("/api/visits", json={}, headers={"User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)"}).json()
    assert r == {"session_token": None, "tracked": False}
    assert db.scalar(select(func.count()).select_from(VisitorSession)) == 0


def test_untrusted_ip_header_gives_unknown_region_not_spoofed_one(client, db, app):
    r = client.post("/api/visits", json={}, headers={"X-Forwarded-For": "not-an-ip"}).json()
    s = session_of(db, r["session_token"])
    assert r["tracked"] and s.geo_country_code is None and app.state.geo.calls == [None]


# ---------- influencer attribution unchanged ----------
def test_direct_return_visit_keeps_influencer_attribution(client, db):
    make_influencer(client)
    tok = click(client).json()["session_token"]
    r = visit(client, token=tok, referrer="https://www.google.com/").json()  # later comes back via search
    assert r["attributed_code"] == "RAHUL01" and r["source"] == "influencer"
    assert pay(client, "MGM-RET001", tok).json()["influencer_code"] == "RAHUL01"


def test_direct_first_then_influencer_link_attributes_but_keeps_first_touch(client, db):
    make_influencer(client)
    tok = visit(client).json()["session_token"]
    r = click(client, token=tok).json()
    assert r["session_token"] == tok and r["attributed_code"] == "RAHUL01" and r["source"] == "direct"
    b = pay(client, "MGM-DIR002", tok).json()
    assert b["attributed"] and b["source"] == "direct"  # channel = first touch; commission = influencer claim
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 1


def test_non_influencer_bookings_never_create_commission(client, db):
    for i, kw in enumerate(({}, {"referrer": "https://www.google.com/"}, {"utm_medium": "cpc"})):
        tok = visit(client, **kw).json()["session_token"]
        assert pay(client, f"MGM-NOC00{i}", tok).json() == {"recorded": True, "attributed": False, "influencer_code": None, "source": ["direct", "organic", "paid"][i]}
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 0
    assert db.scalar(select(func.count()).select_from(BookingAttribution)) == 3


# ---------- booking snapshots ----------
def test_booking_snapshot_copies_region_source_and_campaign(client, db):
    tok = visit(client, ip="8.8.8.8", utm_source="newsletter", utm_medium="email", utm_campaign="dec").json()["session_token"]
    pay(client, "MGM-SNP001", tok)
    s = session_of(db, tok)
    s.geo_region = "Changed later (new GeoLite release)"
    db.commit()
    b = db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == "MGM-SNP001"))
    assert (b.source, b.geo_country_code, b.geo_region, b.utm_campaign, b.utm_medium) == ("paid", "US", "California", "dec", "email")


def test_booking_without_session_is_recorded_as_unknown(client, db):
    assert pay(client, "MGM-NOS001", None).json()["recorded"]
    b = db.scalar(select(BookingAttribution))
    assert (b.source, b.session_id, b.geo_country_code, b.influencer_id) == ("unknown", None, None, None)


def test_modifying_a_direct_booking_never_duplicates_it(client, db):
    tok = visit(client).json()["session_token"]
    pay(client, "MGM-MOD010", tok)
    pay(client, "MGM-MOD010", tok)  # repeated callback
    client.post("/api/booking-events/modified", json={**BOOKING, "booking_ref": "MGM-MOD010", "tickets": 3, "subtotal": 3646, "tax": 656, "total": 4302})
    rows = db.scalars(select(BookingAttribution)).all()
    assert len(rows) == 1 and rows[0].tickets == 3 and rows[0].total_amount == Decimal("4302.00")


# ---------- all-traffic analytics ----------
def test_regional_and_source_aggregates(client):
    make_influencer(client)
    t_dir = visit(client).json()["session_token"]                                                  # Chennai, direct
    visit(client, ip="49.36.20.20")                                                                 # Bengaluru, direct, no booking
    t_org = visit(client, ip="49.36.20.20", referrer="https://www.google.com/").json()["session_token"]  # Bengaluru, organic
    t_inf = click(client, ip="8.8.8.8").json()["session_token"]                                     # outside India, influencer
    pay(client, "MGM-AGG001", t_dir)
    pay(client, "MGM-AGG002", t_org)
    pay(client, "MGM-AGG003", t_inf)
    pay(client, "MGM-AGG004", None)                                                                 # no session at all
    client.post("/api/booking-events/cancelled", json={"booking_ref": "MGM-AGG002"})

    r = client.get("/api/admin/regional", headers=ADMIN).json()
    s = r["summary"]
    assert (s["sessions"], s["bookings"], s["paid_bookings"], s["tickets"], s["revenue"]) == (4, 4, 3, 6, 3005 * 3)
    assert s["conversion_rate"] == 75.0 and s["unknown_location_bookings"] == 1
    src = {x["source"]: x for x in r["sources"]}
    assert [x["source"] for x in r["sources"]] == ["influencer", "direct", "organic", "paid", "social", "referral", "unknown", "counter"]
    assert (src["direct"]["sessions"], src["direct"]["bookings"], src["direct"]["paid_bookings"], src["direct"]["conversion_rate"]) == (2, 1, 1, 50.0)
    assert (src["organic"]["bookings"], src["organic"]["paid_bookings"], src["organic"]["revenue"]) == (1, 0, 0)  # cancelled excluded
    assert (src["unknown"]["sessions"], src["unknown"]["paid_bookings"]) == (0, 1)
    states = {x["state"]: x for x in r["states"]}
    assert (states["Karnataka"]["sessions"], states["Karnataka"]["bookings"], states["Karnataka"]["paid_bookings"]) == (2, 1, 0)
    assert (states["Tamil Nadu"]["paid_bookings"], states["Tamil Nadu"]["conversion_rate"]) == (1, 100.0)
    assert states["Outside India"]["paid_bookings"] == 1 and states["Unknown"]["paid_bookings"] == 1
    assert {c["country"] for c in r["countries"]} >= {"India", "United States", "Unknown"}
    assert any(c["city"] == "Chennai" and c["state"] == "Tamil Nadu" for c in r["cities"])
    assert client.get("/api/admin/regional?from=2099-01-01", headers=ADMIN).json()["summary"]["sessions"] == 0

    # influencer report stays influencer-only
    a = client.get("/api/admin/analytics", headers=ADMIN).json()
    assert (a["summary"]["paid_bookings"], a["summary"]["sessions"]) == (1, 1)
    assert a["regions"]["states"] == [{"state": "Outside India", "paid_bookings": 1, "tickets": 2, "revenue": 3005.0}]
    assert a["regions"]["city_influencers"][0]["influencer"] == "Rahul Sharma"


def test_regional_endpoint_requires_admin(client):
    assert client.get("/api/admin/regional").status_code == 401
