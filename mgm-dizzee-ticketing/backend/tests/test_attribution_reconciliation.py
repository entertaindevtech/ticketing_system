"""Influencer Performance and Regions & channels must agree on influencer-attributed bookings.

Influencer Performance counts bookings by their recorded attribution (booking_attributions.influencer_id, the
same record commissions hang off). The acquisition channel report must count exactly those bookings under
"influencer", whatever channel first brought the visitor (e.g. a direct visit that later followed an influencer
link keeps first-touch source "direct" but earns commission).
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.models import BookingAttribution, InfluencerCommission
from .conftest import ADMIN, TODAY, book, cancel, click, make_influencer, pay, pay_sim, visit


def reports(client, **period):
    perf = client.get("/api/admin/analytics", params=period, headers=ADMIN).json()
    reg = client.get("/api/admin/regional", params=period, headers=ADMIN).json()
    return perf, reg, {s["source"]: s for s in reg["sources"]}


def assert_reconciled(perf, ch):
    s, inf = perf["summary"], ch["influencer"]
    assert (inf["paid_bookings"], inf["tickets"], inf["revenue"]) == (s["paid_bookings"], s["tickets"], s["revenue"])
    assert inf["bookings"] == s["attributed_bookings"]
    rows = perf["influencers"]
    assert sum(i["paid_bookings"] for i in rows) == s["paid_bookings"] and sum(i["revenue"] for i in rows) == s["revenue"]
    assert sum(i["tickets"] for i in rows) == s["tickets"]


def test_direct_first_visitor_who_follows_an_influencer_link_counts_as_influencer_channel(client, db):
    make_influencer(client, code="LATE01")
    tok = visit(client).json()["session_token"]                  # first touch: direct
    click(client, code="LATE01", token=tok)                      # same browser follows the influencer link later
    assert pay(client, "MGM-LATE01", tok).json() == {"recorded": True, "attributed": True, "influencer_code": "LATE01", "source": "direct"}
    perf, reg, ch = reports(client)
    assert perf["summary"]["paid_bookings"] == 1 and ch["influencer"]["paid_bookings"] == 1
    assert ch["direct"]["paid_bookings"] == 0 and ch["direct"]["bookings"] == 0
    assert ch["influencer"]["sessions"] == 1 and ch["direct"]["sessions"] == 0  # the session is attributed to the influencer
    assert_reconciled(perf, ch)
    a = db.scalar(select(BookingAttribution))
    assert a.source == "direct" and a.influencer_id is not None  # the stored first-touch snapshot is not rewritten


def test_multiple_influencers_tickets_declines_cancellations_and_counter_reconcile(client, db):
    make_influencer(client, code="AAA111", rate=10)
    make_influencer(client, code="BBB222", name="Second", rate=5)
    t_a = click(client, code="AAA111").json()["session_token"]
    t_b = visit(client, ip="49.36.20.20", referrer="https://www.google.com/").json()["session_token"]  # organic first
    click(client, code="BBB222", token=t_b, ip="49.36.20.20")
    t_dir = visit(client, ip="8.8.8.8").json()["session_token"]

    pay(client, "A-4", t_a, cart={"tickets": {"ga": 3, "gc": 1}})          # 4 tickets
    pay(client, "A-2", t_a)                                                 # 2 tickets + meal, later cancelled
    pay(client, "B-5", t_b, cart={"tickets": {"ga": 5}})                    # 5 tickets, organic-first visitor
    pay(client, "B-declined", t_b, status="failed")                         # declined: no booking recorded
    pay(client, "DIR", t_dir)                                               # direct, no influencer
    cancel(client, "A-2")
    r = client.post("/api/counter/sales", headers=ADMIN, json={"visit_date": TODAY, "cart": {"tickets": {"ga": 2}},
                    "method": "Cash", "customer": {"name": "Walk In", "phone": "9123456789"}})
    assert r.status_code == 201

    perf, reg, ch = reports(client)
    assert_reconciled(perf, ch)
    s = perf["summary"]
    assert (s["attributed_bookings"], s["paid_bookings"], s["tickets"]) == (3, 2, 9)
    by = {i["referral_code"]: i for i in perf["influencers"]}
    assert (by["AAA111"]["attributed_bookings"], by["AAA111"]["paid_bookings"], by["AAA111"]["tickets"]) == (2, 1, 4)
    assert (by["BBB222"]["paid_bookings"], by["BBB222"]["tickets"]) == (1, 5)
    assert ch["organic"]["paid_bookings"] == 0                              # B's booking moved to the influencer channel
    assert (ch["direct"]["paid_bookings"], ch["counter"]["paid_bookings"], ch["counter"]["tickets"]) == (1, 1, 2)
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 3  # one per attributed booking; counter and direct earn nothing
    assert db.scalar(select(InfluencerCommission.status).join(BookingAttribution).where(BookingAttribution.tickets == 2)) == "reversed"
    # every channel together equals the whole ledger
    tot = reg["summary"]
    assert sum(x["paid_bookings"] for x in reg["sources"]) == tot["paid_bookings"]
    assert sum(x["revenue"] for x in reg["sources"]) == tot["revenue"]


def test_same_period_filters_apply_identically_to_both_reports(client):
    make_influencer(client, code="DATE01")
    pay(client, "D-1", click(client, code="DATE01").json()["session_token"])
    today = datetime.now(timezone.utc).date()
    for period, n in (({"from": today.isoformat(), "to": today.isoformat()}, 1),
                      ({"from": (today + timedelta(days=1)).isoformat()}, 0),
                      ({"to": (today - timedelta(days=1)).isoformat()}, 0)):
        perf, _, ch = reports(client, **period)
        assert perf["summary"]["paid_bookings"] == ch["influencer"]["paid_bookings"] == n
        assert_reconciled(perf, ch)


def test_bookings_over_the_commission_cap_stay_attributed_in_both_reports(client, db):
    """The per-session commission cap limits commission only: the sixth paid booking from one referral session is
    still the influencer's booking in Influencer Performance and in the influencer channel."""
    make_influencer(client, code="CAP001")
    tok = click(client, code="CAP001").json()["session_token"]
    for i in range(6):
        pay(client, f"CAP-{i}", tok)
    perf, _, ch = reports(client)
    assert perf["summary"]["paid_bookings"] == ch["influencer"]["paid_bookings"] == 6
    assert "influencer_uncredited" not in ch
    assert db.scalar(select(func.count()).select_from(InfluencerCommission)) == 5
    assert_reconciled(perf, ch)


def test_influencer_form_validation_and_code_protection(client):
    ok = {"name": "Priya", "platform": "YouTube", "referral_code": " priya-24 ", "commission_rate": 7.5}
    r = client.post("/api/admin/influencers", json=ok, headers=ADMIN)
    assert r.status_code == 201 and r.json()["referral_code"] == "PRIYA-24" and r.json()["email"] is None  # only required fields
    assert client.post("/api/admin/influencers", json={**ok, "referral_code": "PRIYA-24"}, headers=ADMIN).status_code == 409
    for bad in ({"referral_code": "a b"}, {"commission_rate": 101}, {"commission_rate": -1}, {"email": "not-an-email"}, {"phone": "abc"}):
        assert client.post("/api/admin/influencers", json={**ok, "referral_code": "OTHER1", **bad}, headers=ADMIN).status_code == 422, bad
    iid = r.json()["id"]
    p = client.patch(f"/api/admin/influencers/{iid}", json={"email": "priya@example.com", "phone": "+91 98400 12345", "referral_code": "HIJACK"}, headers=ADMIN)
    assert p.status_code == 200 and p.json()["referral_code"] == "PRIYA-24" and p.json()["commission_rate"] == 7.5  # code can't change; data kept
    assert client.patch(f"/api/admin/influencers/{iid}", json={"phone": "x"}, headers=ADMIN).status_code == 422
