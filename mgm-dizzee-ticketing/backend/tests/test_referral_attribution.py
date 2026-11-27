"""Referral attribution across repeated and switched influencer links in one browser (reported issue).

Each test drives the same HTTP calls the browser makes: POST /api/visits on every landing (src/referral.ts), then a
website booking carrying the visitor-session token, then the simulated payment."""
from dataclasses import replace

from sqlalchemy import select

from app.models import Booking, BookingAttribution, Influencer, InfluencerCommission
from .conftest import ADMIN, book, make_influencer, pay, pay_sim, ref_of, visit


def two_influencers(client):
    make_influencer(client, code="RAHUL01", name="Rahul")
    make_influencer(client, code="PRIYA01", name="Priya", platform="YouTube")


def land(client, token=None, ref=None, campaign=None):
    r = visit(client, token=token, **({"ref": ref} if ref else {}), **({"campaign": campaign} if campaign else {})).json()
    return r["session_token"]


def record(client, db, label):
    """What the report asks for per booking: session, booking ref, stored attribution, payment, commission."""
    db.expire_all()
    ref = ref_of(client, label)
    b = db.scalar(select(Booking).where(Booking.ref == ref))
    a = db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == ref))
    c = db.scalar(select(InfluencerCommission).where(InfluencerCommission.booking_attribution_id == a.id)) if a else None
    return {"session": b.visitor_session_id, "influencer": db.get(Influencer, a.influencer_id).referral_code if a and a.influencer_id else None,
            "paid": a is not None and a.status == "paid", "commission": c is not None, "campaign": a.campaign if a else None}


def dashboard(client):
    rows = client.get("/api/admin/analytics", headers=ADMIN).json()["influencers"]
    return {r["referral_code"]: (r["clicks"], r["sessions"], r["paid_bookings"]) for r in rows}


def test_scenario_a_same_influencer_twice_in_one_browser(client, db):
    two_influencers(client)
    tok = land(client, ref="RAHUL01")
    pay(client, "A1", tok)
    assert dashboard(client)["RAHUL01"] == (1, 1, 1)
    assert land(client, token=tok, ref="RAHUL01") == tok  # same browser: same visitor session
    pay(client, "A2", tok)
    r1, r2 = record(client, db, "A1"), record(client, db, "A2")
    assert r1["session"] == r2["session"]
    assert (r1["influencer"], r1["paid"], r1["commission"]) == (r2["influencer"], r2["paid"], r2["commission"]) == ("RAHUL01", True, True)
    assert dashboard(client)["RAHUL01"] == (2, 1, 2)


def test_scenario_b_switching_to_another_influencer(client, db):
    two_influencers(client)
    tok = land(client, ref="RAHUL01")
    pay(client, "B1", tok)
    assert land(client, token=tok, ref="PRIYA01") == tok
    pay(client, "B2", tok)
    assert record(client, db, "B1")["influencer"] == "RAHUL01"  # unchanged by the later Priya visit
    assert (record(client, db, "B2")["influencer"], record(client, db, "B2")["commission"]) == ("PRIYA01", True)
    assert dashboard(client) == {"RAHUL01": (1, 1, 1), "PRIYA01": (1, 1, 1)}


def test_scenario_c_latest_link_before_booking_wins(client, db):
    two_influencers(client)
    tok = land(client, ref="RAHUL01")
    land(client, token=tok, ref="PRIYA01")
    land(client, token=tok, ref="RAHUL01")
    pay(client, "C1", tok)
    assert record(client, db, "C1")["influencer"] == "RAHUL01"
    assert dashboard(client) == {"RAHUL01": (2, 1, 1), "PRIYA01": (1, 1, 0)}  # Priya keeps her click and session


def test_direct_visit_after_a_referral_keeps_it(client, db):
    two_influencers(client)
    tok = land(client, ref="PRIYA01")
    assert land(client, token=tok) == tok  # a direct landing (the browser normally sends nothing at all)
    pay(client, "D1", tok)
    assert record(client, db, "D1")["influencer"] == "PRIYA01"


def test_later_referral_never_rewrites_an_existing_booking(client, db):
    """A booking created under Rahul and paid after the visitor opens Priya's link stays Rahul's, and a paid
    booking's attribution never changes afterwards."""
    two_influencers(client)
    tok = land(client, ref="RAHUL01")
    pay(client, "E1", tok)
    pending = book(client, session_token=tok, key="E2").json()  # created under Rahul, not yet paid
    land(client, token=tok, ref="PRIYA01")
    assert pay_sim(client, pending).status_code == 200
    db.expire_all()
    e2 = db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == pending["booking"]["id"]))
    assert db.get(Influencer, e2.influencer_id).referral_code == "RAHUL01"
    before = record(client, db, "E1")
    land(client, token=tok, ref="RAHUL01")
    land(client, token=tok, ref="PRIYA01")
    assert record(client, db, "E1") == before


def test_booking_made_before_any_referral_is_not_attributed_by_a_later_one(client, db):
    two_influencers(client)
    tok = land(client)
    pending = book(client, session_token=tok, key="F1").json()
    land(client, token=tok, ref="RAHUL01")
    pay_sim(client, pending)
    db.expire_all()
    assert db.scalar(select(BookingAttribution).where(BookingAttribution.booking_ref == pending["booking"]["id"])).influencer_id is None


def test_commission_cap_stops_commission_not_attribution(client, db):
    two_influencers(client)
    tok = land(client, ref="RAHUL01")
    rows = []
    for i in range(7):
        pay(client, f"G{i}", tok)
        rows.append(record(client, db, f"G{i}"))
    assert [r["influencer"] for r in rows] == ["RAHUL01"] * 7
    assert [r["commission"] for r in rows] == [True] * 5 + [False] * 2
    assert dashboard(client)["RAHUL01"][2] == 7
    # switching influencer within the same session: still attributed, still no commission (cap is per session)
    land(client, token=tok, ref="PRIYA01")
    pay(client, "G7", tok)
    assert (record(client, db, "G7")["influencer"], record(client, db, "G7")["commission"]) == ("PRIYA01", False)


def test_paid_and_unpaid_bookings(client, db):
    two_influencers(client)
    tok = land(client, ref="RAHUL01")
    assert pay(client, "H1", tok, status="failed").json()["recorded"] is False
    assert pay(client, "H2", tok, status="pending").json()["recorded"] is False
    assert pay(client, "H3", tok).json()["influencer_code"] == "RAHUL01"
    assert dashboard(client)["RAHUL01"] == (1, 1, 1)


def test_storage_unavailable_or_cleared(client, db):
    """No token reaches the server when the browser keeps no session (storage blocked across reloads): the booking
    is recorded, unattributed. After storage is cleared, a new referral landing starts a new session; the old
    session's bookings keep their attribution."""
    two_influencers(client)
    old = land(client, ref="RAHUL01")
    pay(client, "S1", old)
    pay(client, "S2", None)  # booked with no session token
    assert record(client, db, "S2")["influencer"] is None and record(client, db, "S2")["paid"]
    new = land(client, ref="PRIYA01")  # storage cleared: no token sent, so a new visitor session
    assert new != old
    pay(client, "S3", new)
    assert (record(client, db, "S1")["influencer"], record(client, db, "S3")["influencer"]) == ("RAHUL01", "PRIYA01")
    assert record(client, db, "S1")["session"] != record(client, db, "S3")["session"]


def test_campaign_follows_the_active_referral(client, db):
    two_influencers(client)
    tok = land(client, ref="RAHUL01", campaign="diwali")
    pay(client, "K1", tok)
    land(client, token=tok, ref="RAHUL01", campaign="newyear")
    pay(client, "K2", tok)
    assert (record(client, db, "K1")["campaign"], record(client, db, "K2")["campaign"]) == ("diwali", "newyear")


def test_first_click_remains_available_as_an_explicit_setting(app, client, db):
    app.state.settings = replace(app.state.settings, attribution_model="first_click")
    two_influencers(client)
    tok = land(client, ref="RAHUL01")
    land(client, token=tok, ref="PRIYA01")
    pay(client, "L1", tok)
    assert record(client, db, "L1")["influencer"] == "RAHUL01"
    assert dashboard(client)["PRIYA01"] == (1, 0, 0)  # click counted, session kept by Rahul
