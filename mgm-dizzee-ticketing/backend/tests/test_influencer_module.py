from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select

from app.geo import GeoLookup, client_ip, region_bucket
from app.models import BookingAttribution, InfluencerCommission, ReferralClick, VisitorSession, utcnow

from .conftest import ADMIN, cancel, click, make_influencer, modify, pay


# ---------- influencer management & referral validation ----------
def test_admin_api_requires_token(client):
    assert client.get("/api/admin/influencers").status_code == 401
    assert client.get("/api/admin/influencers", headers={"X-Admin-Token": "wrong"}).status_code == 401


def test_create_influencer_generates_url_and_rejects_duplicate_code(client):
    inf = make_influencer(client, code="rahul01")
    assert inf["referral_code"] == "RAHUL01"
    assert inf["referral_url"] == "https://book.example.test/?ref=RAHUL01"
    r = client.post("/api/admin/influencers", json={"name": "Other", "platform": "YouTube", "referral_code": "RAHUL01", "commission_rate": 5}, headers=ADMIN)
    assert r.status_code == 409
    bad = client.post("/api/admin/influencers", json={"name": "Bad", "platform": "YouTube", "referral_code": "a b", "commission_rate": 5}, headers=ADMIN)
    assert bad.status_code == 422


def test_unknown_and_inactive_codes_are_rejected(client, db):
    # The visit is still tracked (geography for all visitors) but never attributed or counted as a click.
    inf = make_influencer(client)
    for code in ("NOPE99", "<script>"):
        r = click(client, code=code).json()
        assert r["tracked"] and r["attributed_code"] is None and r["source"] != "influencer"
    client.patch(f"/api/admin/influencers/{inf['id']}", json={"active": False}, headers=ADMIN)
    assert click(client).json()["attributed_code"] is None
    assert db.scalar(select(func.count()).select_from(ReferralClick)) == 0


# ---------- clicks, sessions, first-click attribution ----------
def test_click_records_session_and_geo_snapshot(client, db, app):
    make_influencer(client)
    r = click(client, campaign="Summer2026")
    assert r.status_code == 200
    token = r.json()["session_token"]
    s = db.scalar(select(VisitorSession).where(VisitorSession.token == token))
    assert (s.geo_region, s.geo_city, s.campaign) == ("Tamil Nadu", "Chennai", "summer2026")
    assert db.scalar(select(func.count()).select_from(ReferralClick)) == 1
    assert app.state.geo.calls == ["49.36.10.10"]


def test_first_click_wins_within_window(client, db):
    make_influencer(client, code="AAA111")
    make_influencer(client, code="BBB222", name="Second")
    tok = click(client, code="AAA111").json()["session_token"]
    r = click(client, code="BBB222", token=tok).json()
    assert r["session_token"] == tok and r["kept_existing"] and r["attributed_code"] == "AAA111"
    # B still gets credit for the click, but not the session
    clicks = db.execute(select(ReferralClick.influencer_id, ReferralClick.kept_existing_attribution)).all()
    assert len(clicks) == 2 and clicks[1][1] is True
    assert db.scalar(select(func.count()).select_from(VisitorSession)) == 1
    assert pay(client, "MGM-AAA001", tok).json()["influencer_code"] == "AAA111"


def test_geo_lookup_only_once_per_session(client, app):
    make_influencer(client)
    tok = click(client).json()["session_token"]
    click(client, token=tok)
    click(client, token=tok)
    assert len(app.state.geo.calls) == 1


def test_expired_attribution_is_replaced_and_not_paid_out(client, db):
    make_influencer(client, code="AAA111")
    make_influencer(client, code="BBB222", name="Second")
    tok = click(client, code="AAA111").json()["session_token"]
    s = db.scalar(select(VisitorSession).where(VisitorSession.token == tok))
    s.created_at = s.attributed_at = utcnow() - timedelta(days=31)
    s.expires_at = s.attribution_expires_at = utcnow() - timedelta(days=1)
    db.commit()
    r = pay(client, "MGM-OLD001", tok).json()
    assert r["attributed"] is False and r["recorded"] is True  # past the 30-day window: sale counted, no commission
    r = click(client, code="BBB222", token=tok).json()
    assert r["session_token"] != tok and r["attributed_code"] == "BBB222" and not r["kept_existing"]


def test_session_window_is_30_days(client, db):
    make_influencer(client)
    tok = click(client).json()["session_token"]
    s = db.scalar(select(VisitorSession).where(VisitorSession.token == tok))
    assert abs((s.expires_at - s.created_at) - timedelta(days=30)) < timedelta(seconds=1)


# ---------- geolocation ----------
def test_unknown_and_foreign_locations_are_bucketed(client):
    make_influencer(client)
    for ref, ip in (("MGM-IN0001", "49.36.10.10"), ("MGM-PART01", "49.36.30.30"), ("MGM-US0001", "8.8.8.8"), ("MGM-UNK001", "203.0.113.99")):
        assert pay(client, ref, click(client, ip=ip).json()["session_token"]).json()["attributed"]
    states = {s["state"]: s["paid_bookings"] for s in client.get("/api/admin/analytics", headers=ADMIN).json()["regions"]["states"]}
    assert states == {"Tamil Nadu": 1, "Unknown": 2, "Outside India": 1}


def test_client_ip_trusts_only_proxy_hops():
    assert client_ip("1.2.3.4, 49.36.10.10", "10.0.0.1", 1) == "49.36.10.10"  # spoofed left entry ignored
    assert client_ip(None, "49.36.10.10", 0) == "49.36.10.10"
    assert client_ip("10.1.1.1", "10.0.0.1", 1) is None  # private address -> no lookup
    assert client_ip("not-an-ip", None, 1) is None
    assert client_ip("::ffff:49.36.10.10", None, 1) == "49.36.10.10"


def test_geolookup_without_database_degrades_to_unknown(tmp_path):
    g = GeoLookup(str(tmp_path / "missing.mmdb"))
    assert not g.available
    assert g.lookup("49.36.10.10")["geo_country_code"] is None
    assert region_bucket(None, None) == "Unknown"


def test_geolookup_reads_mmdb_records(monkeypatch, tmp_path):
    class Reader:
        def get(self, ip):
            return {"country": {"iso_code": "IN", "names": {"en": "India"}}, "subdivisions": [{"names": {"en": "Kerala"}}], "city": {"names": {"en": "Kochi"}}}
    g = GeoLookup(str(tmp_path / "x.mmdb"))
    monkeypatch.setattr(g, "_current_reader", lambda: Reader())
    assert g.lookup("49.36.10.10") == {"geo_country_code": "IN", "geo_country": "India", "geo_region": "Kerala", "geo_city": "Kochi"}


def test_click_and_booking_succeed_when_geo_reader_errors(client, app, monkeypatch, tmp_path):
    class Broken:
        def get(self, ip):
            raise RuntimeError("corrupt database")
    g = GeoLookup(str(tmp_path / "x.mmdb"))
    monkeypatch.setattr(g, "_current_reader", lambda: Broken())
    app.state.geo = g
    make_influencer(client)
    r = click(client)
    assert r.status_code == 200
    assert pay(client, "MGM-GEOERR", r.json()["session_token"]).json()["attributed"]


# ---------- payment, commission ----------
def test_paid_booking_creates_commission_on_ticket_net(client, db):
    make_influencer(client, rate=8)
    tok = click(client).json()["session_token"]
    assert pay(client, "MGM-PAID01", tok).json() == {"recorded": True, "attributed": True, "influencer_code": "RAHUL01", "source": "influencer"}
    c = db.scalar(select(InfluencerCommission))
    # ticket net = 2547 - 0 - 349 = 2198 (GST and add-ons excluded); 8% = 175.84
    assert (c.basis_amount, c.amount, c.rate, c.status) == (Decimal("2198.00"), Decimal("175.84"), Decimal("8.00"), "pending")
    a = db.scalar(select(BookingAttribution))
    assert (a.geo_region, a.geo_city, a.campaign) == ("Tamil Nadu", "Chennai", None)


def test_discounts_reduce_commission_basis(client, db):
    make_influencer(client, rate=10)
    tok = click(client).json()["session_token"]
    pay(client, "MGM-DISC01", tok, cart={"tickets": {"ga": 2}, "addons": {"food": 1}, "coupon": "MGM30"})
    assert db.scalar(select(InfluencerCommission.basis_amount)) == Decimal("1539.00")  # 2198 - 659 (MGM30); add-on excluded


def test_failed_or_pending_payment_creates_nothing(client, db):
    make_influencer(client)
    tok = click(client).json()["session_token"]
    for st in ("failed", "pending"):
        assert pay(client, "MGM-FAIL01", tok, status=st).json()["attributed"] is False
    assert db.scalar(select(func.count()).select_from(BookingAttribution)) == 0
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 0


def test_booking_without_referral_is_not_attributed(client, db):
    assert pay(client, "MGM-DIRECT", None).json()["attributed"] is False
    assert pay(client, "MGM-FORGED", "made-up-token").json()["attributed"] is False


def test_duplicate_payment_callback_is_idempotent(client, db):
    make_influencer(client)
    tok = click(client).json()["session_token"]
    for _ in range(3):
        assert pay(client, "MGM-DUP001", tok).json()["attributed"]
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 1


def test_attribution_cannot_be_switched_after_booking(client, db):
    make_influencer(client, code="AAA111")
    make_influencer(client, code="BBB222", name="Second")
    tok_a = click(client, code="AAA111").json()["session_token"]
    tok_b = click(client, code="BBB222", ip="49.36.20.20").json()["session_token"]
    pay(client, "MGM-LOCK01", tok_a)
    assert pay(client, "MGM-LOCK01", tok_b).json()["influencer_code"] == "AAA111"


def test_rate_change_does_not_alter_recorded_commission(client, db):
    inf = make_influencer(client, rate=8)
    pay(client, "MGM-RATE01", click(client).json()["session_token"])
    client.patch(f"/api/admin/influencers/{inf['id']}", json={"commission_rate": 15}, headers=ADMIN)
    pay(client, "MGM-RATE02", click(client, ip="49.36.20.20").json()["session_token"])
    rates = sorted(r for (r,) in db.execute(select(InfluencerCommission.rate)))
    assert rates == [Decimal("8.00"), Decimal("15.00")]


def test_cancellation_reverses_commission_and_keeps_history(client, db):
    make_influencer(client)
    pay(client, "MGM-CANC01", click(client).json()["session_token"])
    cid = db.scalar(select(InfluencerCommission.id))
    client.post(f"/api/admin/commissions/{cid}/approve", headers=ADMIN)
    assert cancel(client, "MGM-CANC01").json()["status"] == "cancelled"
    assert cancel(client, "MGM-CANC01").status_code == 409  # repeat changes nothing
    detail = client.get(f"/api/admin/commissions/{cid}", headers=ADMIN).json()
    assert detail["status"] == "reversed" and detail["reversal_reason"].startswith("Cancelled by admin")
    assert [(e["from"], e["to"]) for e in detail["events"]] == [(None, "pending"), ("pending", "approved"), ("approved", "reversed")]
    a = client.get("/api/admin/analytics", headers=ADMIN).json()
    assert a["summary"]["paid_bookings"] == 0 and a["summary"]["revenue"] == 0 and a["influencers"][0]["attributed_bookings"] == 1


def test_cancelling_unattributed_booking_creates_no_commission_activity(client, db):
    pay(client, "MGM-NONE01", None)
    assert cancel(client, "MGM-NONE01").status_code == 200
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 0


def test_modification_updates_pending_commission_without_duplicating(client, db):
    make_influencer(client, rate=10)
    pay(client, "MGM-MOD001", click(client).json()["session_token"])
    assert modify(client, "MGM-MOD001", {"ga": 3}).status_code == 200
    rows = db.execute(select(InfluencerCommission.amount, InfluencerCommission.rate)).all()
    assert rows == [(Decimal("329.70"), Decimal("10.00"))]  # (3646-349) * 10%


def test_modification_after_approval_keeps_amount(client, db):
    make_influencer(client, rate=10)
    pay(client, "MGM-MOD002", click(client).json()["session_token"])
    cid = db.scalar(select(InfluencerCommission.id))
    client.post(f"/api/admin/commissions/{cid}/approve", headers=ADMIN)
    assert modify(client, "MGM-MOD002", {"ga": 4}).status_code == 200
    d = client.get(f"/api/admin/commissions/{cid}", headers=ADMIN).json()
    assert d["amount"] == 219.8 and "review manually" in d["events"][-1]["note"]


def test_commission_workflow_transitions(client, db):
    make_influencer(client)
    pay(client, "MGM-FLOW01", click(client).json()["session_token"])
    cid = db.scalar(select(InfluencerCommission.id))
    assert client.post(f"/api/admin/commissions/{cid}/mark-paid", json={"payout_reference": "NEFT123"}, headers=ADMIN).status_code == 409
    assert client.post(f"/api/admin/commissions/{cid}/approve", headers=ADMIN).json()["status"] == "approved"
    assert client.post(f"/api/admin/commissions/{cid}/approve", headers=ADMIN).status_code == 409
    paid = client.post(f"/api/admin/commissions/{cid}/mark-paid", json={"payout_reference": "NEFT123"}, headers=ADMIN).json()
    assert paid["status"] == "paid" and paid["payout_reference"] == "NEFT123"
    assert len(client.get("/api/admin/commissions?status=paid", headers=ADMIN).json()) == 1
    assert client.get("/api/admin/commissions?status=pending", headers=ADMIN).json() == []


# ---------- analytics ----------
def test_analytics_aggregation(client):
    make_influencer(client, code="AAA111", rate=10)
    make_influencer(client, code="BBB222", name="Second", platform="YouTube", rate=5)
    t1 = click(client, code="AAA111", campaign="summer2026").json()["session_token"]
    click(client, code="AAA111", token=t1)  # repeat visit: 2nd click, same session
    t2 = click(client, code="AAA111", ip="49.36.20.20").json()["session_token"]
    click(client, code="BBB222", ip="8.8.8.8")  # clicked, never booked
    pay(client, "MGM-AN0001", t1)
    pay(client, "MGM-AN0002", t2)
    cancel(client, "MGM-AN0002")

    a = client.get("/api/admin/analytics", headers=ADMIN).json()
    s = a["summary"]
    assert (s["clicks"], s["sessions"], s["attributed_bookings"], s["paid_bookings"], s["tickets"]) == (4, 3, 2, 1, 2)
    assert s["revenue"] == 3005 and s["conversion_rate"] == 33.3 and s["commission_pending"] == 219.8 and s["commission_paid"] == 0
    by = {i["referral_code"]: i for i in a["influencers"]}
    assert (by["AAA111"]["clicks"], by["AAA111"]["sessions"], by["AAA111"]["paid_bookings"], by["AAA111"]["conversion_rate"]) == (3, 2, 1, 50.0)
    assert (by["BBB222"]["clicks"], by["BBB222"]["paid_bookings"]) == (1, 0)
    assert a["regions"]["states"] == [{"state": "Tamil Nadu", "paid_bookings": 1, "tickets": 2, "revenue": 3005.0}]
    assert a["regions"]["cities"][0]["city"] == "Chennai"
    camp = {(c["influencer"], c["campaign"]): c for c in a["campaigns"]}
    summer, untagged = camp[("Rahul Sharma", "summer2026")], camp[("Rahul Sharma", "(none)")]
    assert (summer["clicks"], summer["sessions"], summer["paid_bookings"], summer["revenue"]) == (1, 1, 1, 3005)
    # the untagged repeat visit counts as an untagged click; the booking stays with the session's campaign
    assert (untagged["clicks"], untagged["attributed_bookings"], untagged["paid_bookings"]) == (2, 1, 0)

    one = client.get(f"/api/admin/analytics?influencer_id={by['BBB222']['id']}", headers=ADMIN).json()
    assert len(one["influencers"]) == 1 and one["summary"]["clicks"] == 1
    future = client.get("/api/admin/analytics?from=2099-01-01", headers=ADMIN).json()["summary"]
    assert future["clicks"] == 0 and future["paid_bookings"] == 0


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


# ---------- hardening (security review) ----------
def test_weak_or_placeholder_admin_token_keeps_admin_api_closed(app, client):
    from dataclasses import replace
    for weak in ("", "short-token", "change-me-to-a-long-random-string"):
        app.state.settings = replace(app.state.settings, admin_api_token=weak)
        assert client.get("/api/admin/influencers", headers={"X-Admin-Token": weak}).status_code == 401  # token path disabled


def test_browser_reported_booking_events_are_retired_and_bad_carts_rejected(client, db):
    make_influencer(client)
    tok = click(client).json()["session_token"]
    for kind in ("paid", "cancelled", "modified"):  # the old browser outbox path cannot record or change anything
        r = client.post(f"/api/booking-events/{kind}", json={"booking_ref": "MGM-BAD001", "session_token": tok, "payment_status": "paid", "total": 1})
        assert r.status_code == 410
    assert pay(client, "MGM-BAD002", tok, cart={"tickets": {"ga": -1}}).status_code == 422
    assert pay(client, "MGM-BAD003", tok, cart={"tickets": {"zz": 2}}).status_code == 422  # unknown category: no tickets
    assert db.scalar(select(func.count()).select_from(BookingAttribution)) == 0


def test_one_session_cannot_be_replayed_for_unlimited_bookings(client, db):
    make_influencer(client)
    tok = click(client).json()["session_token"]
    results = [pay(client, f"MGM-CAP{i:03d}", tok).json()["attributed"] for i in range(7)]
    assert results == [True] * 5 + [False] * 2
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 5
