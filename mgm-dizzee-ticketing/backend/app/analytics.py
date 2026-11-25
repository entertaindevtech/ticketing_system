"""Influencer, regional and campaign aggregates computed from recorded clicks and paid bookings.

Definitions (also in the handover doc):
- clicks:            every recorded referral link visit in the period
- sessions:          unique referral sessions (visitors) established in the period
- attributed:        bookings attributed in the period, including ones later cancelled
- paid:              attributed bookings still in "paid" status (cancelled/refunded excluded)
- conversion rate:   paid / sessions
- revenue:           total amount (incl. GST) of paid attributed bookings
- commission earned: commissions that are not reversed
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from .acquisition import SOURCES
from .geo import UNKNOWN, city_bucket, region_bucket
from .models import BookingAttribution as BA, Influencer, InfluencerCommission as IC, ReferralClick, VisitorSession as VS

ZERO = Decimal(0)


def _range(start: date | None, end: date | None):
    lo = datetime.combine(start, time.min, tzinfo=timezone.utc) if start else None
    hi = datetime.combine(end + timedelta(days=1), time.min, tzinfo=timezone.utc) if end else None
    return lo, hi


def _within(col, lo, hi):
    conds = []
    if lo is not None:
        conds.append(col >= lo)
    if hi is not None:
        conds.append(col < hi)
    return conds


def _rate(n: int, d: int) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def compute(db: Session, start: date | None = None, end: date | None = None, influencer_id: int | None = None) -> dict:
    lo, hi = _range(start, end)
    inf_filter = lambda col: [col == influencer_id] if influencer_id else []  # noqa: E731

    clicks = dict(db.execute(select(ReferralClick.influencer_id, func.count()).where(
        *_within(ReferralClick.created_at, lo, hi), *inf_filter(ReferralClick.influencer_id)).group_by(ReferralClick.influencer_id)).all())
    # an influencer's sessions = visitor sessions that received its attribution, dated by attribution time
    sessions = dict(db.execute(select(VS.influencer_id, func.count()).where(VS.influencer_id.is_not(None),
        *_within(VS.attributed_at, lo, hi), *inf_filter(VS.influencer_id)).group_by(VS.influencer_id)).all())

    paid = BA.status == "paid"
    live_comm = IC.status != "reversed"
    ba_where = [*_within(BA.paid_at, lo, hi), *inf_filter(BA.influencer_id)]
    booking_rows = db.execute(select(
        BA.influencer_id,
        func.count(BA.id),
        func.sum(case((paid, 1), else_=0)),
        func.coalesce(func.sum(case((paid, BA.tickets), else_=0)), 0),
        func.coalesce(func.sum(case((paid, BA.total_amount), else_=0)), 0),
        func.coalesce(func.sum(case((live_comm, IC.amount), else_=0)), 0),
        func.coalesce(func.sum(case((IC.status == "pending", IC.amount), else_=0)), 0),
        func.coalesce(func.sum(case((IC.status == "approved", IC.amount), else_=0)), 0),
        func.coalesce(func.sum(case((IC.status == "paid", IC.amount), else_=0)), 0),
        func.coalesce(func.sum(case((IC.status == "reversed", IC.amount), else_=0)), 0),
    ).join(IC, IC.booking_attribution_id == BA.id).where(*ba_where).group_by(BA.influencer_id)).all()
    by_inf = {r[0]: r[1:] for r in booking_rows}

    infl_q = select(Influencer).order_by(Influencer.name)
    if influencer_id:
        infl_q = infl_q.where(Influencer.id == influencer_id)
    influencers = []
    for inf in db.scalars(infl_q):
        attributed, n_paid, tickets, revenue, earned, pend, appr, cpaid, rev = by_inf.get(inf.id, (0, 0, 0, 0, 0, 0, 0, 0, 0))
        s = sessions.get(inf.id, 0)
        influencers.append({
            "id": inf.id, "name": inf.name, "platform": inf.platform, "referral_code": inf.referral_code, "active": inf.active,
            "commission_rate": float(inf.commission_rate), "clicks": clicks.get(inf.id, 0), "sessions": s,
            "attributed_bookings": attributed, "paid_bookings": int(n_paid or 0), "conversion_rate": _rate(int(n_paid or 0), s),
            "tickets": int(tickets or 0), "revenue": float(revenue or 0), "commission_earned": float(earned or 0),
            "commission_pending": float(pend or 0), "commission_approved": float(appr or 0),
            "commission_paid": float(cpaid or 0), "commission_reversed": float(rev or 0),
        })

    tot = lambda k: sum(i[k] for i in influencers)  # noqa: E731
    summary = {
        "revenue": tot("revenue"), "paid_bookings": tot("paid_bookings"), "attributed_bookings": tot("attributed_bookings"),
        "tickets": tot("tickets"), "clicks": tot("clicks"), "sessions": tot("sessions"),
        "conversion_rate": _rate(tot("paid_bookings"), tot("sessions")),
        "commission_pending": tot("commission_pending") + tot("commission_approved"),  # owed but not yet settled
        "commission_paid": tot("commission_paid"),
    }

    # ---- regions (paid bookings only) ----
    geo_rows = db.execute(select(
        BA.influencer_id, BA.campaign, BA.geo_country_code, BA.geo_region, BA.geo_city,
        func.count(BA.id), func.sum(BA.tickets), func.sum(BA.total_amount),
    ).where(paid, BA.influencer_id.is_not(None), *ba_where).group_by(
        BA.influencer_id, BA.campaign, BA.geo_country_code, BA.geo_region, BA.geo_city)).all()
    names = {i["id"]: i["name"] for i in influencers}
    agg_ = lambda: defaultdict(lambda: [0, 0, ZERO])  # noqa: E731
    states, cities, state_inf, city_inf, camp_state = agg_(), agg_(), agg_(), agg_(), agg_()
    for inf_id, camp, cc, region, city, n, t, rev in geo_rows:
        st = region_bucket(cc, region)
        ct = city_bucket(cc, city)
        for bucket, key in ((states, st), (cities, (ct, st)), (state_inf, (st, inf_id)), (city_inf, (ct, st, inf_id)),
                            (camp_state, (inf_id, camp or "(none)", st))):
            agg = bucket[key]
            agg[0] += n
            agg[1] += int(t or 0)
            agg[2] += Decimal(rev or 0)
    region_out = {
        "states": sorted([{"state": k, "paid_bookings": v[0], "tickets": v[1], "revenue": float(v[2])} for k, v in states.items()], key=lambda x: -x["revenue"]),
        "cities": sorted([{"city": k[0], "state": k[1], "paid_bookings": v[0], "tickets": v[1], "revenue": float(v[2])} for k, v in cities.items()], key=lambda x: -x["revenue"]),
        "state_influencers": sorted([{"state": k[0], "influencer_id": k[1], "influencer": names.get(k[1], "?"), "paid_bookings": v[0], "tickets": v[1], "revenue": float(v[2])} for k, v in state_inf.items()], key=lambda x: (x["state"], -x["revenue"])),
        "city_influencers": sorted([{"city": k[0], "state": k[1], "influencer_id": k[2], "influencer": names.get(k[2], "?"), "paid_bookings": v[0], "tickets": v[1], "revenue": float(v[2])} for k, v in city_inf.items()], key=lambda x: -x["revenue"]),
        "campaign_states": sorted([{"influencer": names.get(k[0], "?"), "campaign": k[1], "state": k[2], "paid_bookings": v[0], "tickets": v[1], "revenue": float(v[2])} for k, v in camp_state.items()], key=lambda x: -x["revenue"]),
    }

    # ---- campaigns ----
    camp = defaultdict(lambda: {"clicks": 0, "sessions": 0, "attributed_bookings": 0, "paid_bookings": 0, "tickets": 0, "revenue": ZERO, "commission": ZERO})
    for inf_id, c, n in db.execute(select(ReferralClick.influencer_id, ReferralClick.campaign, func.count()).where(
            *_within(ReferralClick.created_at, lo, hi), *inf_filter(ReferralClick.influencer_id)).group_by(ReferralClick.influencer_id, ReferralClick.campaign)):
        camp[(inf_id, c)]["clicks"] = n
    for inf_id, c, n in db.execute(select(VS.influencer_id, VS.campaign, func.count()).where(VS.influencer_id.is_not(None),
            *_within(VS.attributed_at, lo, hi), *inf_filter(VS.influencer_id)).group_by(VS.influencer_id, VS.campaign)):
        camp[(inf_id, c)]["sessions"] = n
    for inf_id, c, n, n_paid, t, rev, com in db.execute(select(
            BA.influencer_id, BA.campaign, func.count(BA.id), func.sum(case((paid, 1), else_=0)),
            func.sum(case((paid, BA.tickets), else_=0)), func.sum(case((paid, BA.total_amount), else_=0)),
            func.sum(case((live_comm, IC.amount), else_=0)),
    ).join(IC, IC.booking_attribution_id == BA.id).where(*ba_where).group_by(BA.influencer_id, BA.campaign)):
        camp[(inf_id, c)].update(attributed_bookings=n, paid_bookings=int(n_paid or 0), tickets=int(t or 0), revenue=Decimal(rev or 0), commission=Decimal(com or 0))
    campaigns = sorted([{
        "influencer_id": k[0], "influencer": names.get(k[0], "?"), "campaign": k[1] or "(none)", **{x: v[x] for x in ("clicks", "sessions", "attributed_bookings", "paid_bookings", "tickets")},
        "revenue": float(v["revenue"]), "commission": float(v["commission"]), "conversion_rate": _rate(v["paid_bookings"], v["sessions"]),
    } for k, v in camp.items() if k[0] in names], key=lambda x: -x["revenue"])

    return {"summary": summary, "influencers": influencers, "regions": region_out, "campaigns": campaigns}


# ---------------- all website traffic (any acquisition source) ----------------
def compute_regional(db: Session, start: date | None = None, end: date | None = None) -> dict:
    """Visitor sessions vs bookings by acquisition source and region.

    sessions        = visitor sessions created in the period (a session is one browser, not one person)
    bookings        = website bookings paid in the period, including ones later cancelled/refunded
    paid_bookings   = those still paid; tickets and revenue (incl. GST) count paid bookings only
    conversion_rate = paid_bookings / sessions for the same period and slice. Bookings made by sessions created
                      before the period still count, so short periods can over- or under-state it (can exceed 100%).
    Counter (walk-in) sales are not website traffic and are not included.
    """
    lo, hi = _range(start, end)
    paid = BA.status == "paid"
    sess_rows = db.execute(select(VS.source, VS.geo_country_code, VS.geo_country, VS.geo_region, VS.geo_city, func.count())
                           .where(*_within(VS.created_at, lo, hi))
                           .group_by(VS.source, VS.geo_country_code, VS.geo_country, VS.geo_region, VS.geo_city)).all()
    book_rows = db.execute(select(
        BA.source, BA.geo_country_code, BA.geo_country, BA.geo_region, BA.geo_city, func.count(BA.id),
        func.sum(case((paid, 1), else_=0)), func.coalesce(func.sum(case((paid, BA.tickets), else_=0)), 0),
        func.coalesce(func.sum(case((paid, BA.total_amount), else_=0)), 0),
    ).where(*_within(BA.paid_at, lo, hi)).group_by(BA.source, BA.geo_country_code, BA.geo_country, BA.geo_region, BA.geo_city)).all()

    blank = lambda: {"sessions": 0, "bookings": 0, "paid_bookings": 0, "tickets": 0, "revenue": ZERO}  # noqa: E731
    dims = {"sources": defaultdict(blank), "countries": defaultdict(blank), "states": defaultdict(blank), "cities": defaultdict(blank)}

    def keys(src, cc, country, region, city):
        st = region_bucket(cc, region)
        return (("sources", src), ("countries", country or (cc or UNKNOWN)), ("states", st), ("cities", (city_bucket(cc, city), st)))

    total = blank()
    for src, cc, country, region, city, n in sess_rows:
        total["sessions"] += n
        for d, k in keys(src, cc, country, region, city):
            dims[d][k]["sessions"] += n
    unknown_loc = 0
    for src, cc, country, region, city, n, n_paid, t, rev in book_rows:
        vals = {"bookings": n, "paid_bookings": int(n_paid or 0), "tickets": int(t or 0), "revenue": Decimal(rev or 0)}
        if not cc:
            unknown_loc += vals["paid_bookings"]
        for k, v in vals.items():
            total[k] += v
        for d, k in keys(src, cc, country, region, city):
            for f, v in vals.items():
                dims[d][k][f] += v

    def out(v):
        return {**v, "revenue": float(v["revenue"]), "conversion_rate": _rate(v["paid_bookings"], v["sessions"])}

    for s in SOURCES:  # always list every source so empty channels are visible
        dims["sources"][s]
    return {
        "summary": {**out(total), "unknown_location_bookings": unknown_loc},
        "sources": [{"source": k, **out(v)} for k, v in sorted(dims["sources"].items(), key=lambda kv: SOURCES.index(kv[0]) if kv[0] in SOURCES else 99)],
        "countries": sorted(({"country": k, **out(v)} for k, v in dims["countries"].items()), key=lambda x: (-x["revenue"], -x["sessions"])),
        "states": sorted(({"state": k, **out(v)} for k, v in dims["states"].items()), key=lambda x: (-x["revenue"], -x["sessions"])),
        "cities": sorted(({"city": k[0], "state": k[1], **out(v)} for k, v in dims["cities"].items()), key=lambda x: (-x["revenue"], -x["sessions"])),
    }
