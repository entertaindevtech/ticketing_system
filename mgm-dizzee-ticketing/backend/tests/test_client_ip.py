"""Visitor IP behind Railway's edge: X-Real-IP is the only source; X-Forwarded-For is never trusted."""
import pytest
from sqlalchemy import select

from app.geo import client_ip
from app.models import VisitorSession

INDIA_V4 = "49.36.10.10"            # FakeGeo: Tamil Nadu / Chennai
INDIA_V6 = "2401:4900:1c00::1"      # added below: Maharashtra / Mumbai


@pytest.mark.parametrize("real_ip,peer,hops,expected", [
    (INDIA_V4, "100.64.0.7", 1, INDIA_V4),                 # Railway: X-Real-IP wins over the edge peer
    (INDIA_V6, "100.64.0.7", 1, INDIA_V6),                 # IPv6 visitor
    ("::ffff:49.36.10.10", None, 1, INDIA_V4),             # IPv4-mapped IPv6 is unwrapped
    (f" {INDIA_V4} ", None, 1, INDIA_V4),                  # surrounding whitespace
    (None, INDIA_V4, 1, None),                             # header missing: never fall back to the peer
    ("", None, 1, None),
    ("not-an-ip", None, 1, None),                          # malformed
    (f"{INDIA_V4}:51514", None, 1, None),                  # with a port: malformed
    (f"{INDIA_V4}, 66.33.22.11", None, 1, None),           # a list is not an address
    ("100.64.0.2", None, 1, None),                         # CGNAT / Railway internal
    ("10.0.0.5", None, 1, None),                           # private
    ("127.0.0.1", None, 1, None),                          # loopback
    ("192.0.2.1", None, 1, None),                          # reserved documentation range
    ("fd00::1", None, 1, None),                            # IPv6 unique-local
    (INDIA_V4, INDIA_V4, 0, INDIA_V4),                     # local development: socket peer
    (INDIA_V4, "127.0.0.1", 0, None),                      # local development ignores X-Real-IP
])
def test_client_ip(real_ip, peer, hops, expected):
    assert client_ip(real_ip, peer, hops) == expected


def _session(db, token):
    db.expire_all()
    return db.scalar(select(VisitorSession).where(VisitorSession.token == token))


def post_visit(client, headers):
    r = client.post("/api/visits", json={}, headers=headers)
    assert r.status_code == 200
    return r.json()["session_token"]


def test_indian_ipv4_and_ipv6_regions_are_persisted_on_new_sessions(client, app, db):
    app.state.geo.table[INDIA_V6] = {"geo_country_code": "IN", "geo_country": "India", "geo_region": "Maharashtra", "geo_city": "Mumbai"}
    s4 = _session(db, post_visit(client, {"X-Real-IP": INDIA_V4}))
    s6 = _session(db, post_visit(client, {"X-Real-IP": INDIA_V6}))
    assert (s4.geo_country_code, s4.geo_region, s4.geo_city) == ("IN", "Tamil Nadu", "Chennai")
    assert (s6.geo_country_code, s6.geo_region, s6.geo_city) == ("IN", "Maharashtra", "Mumbai")
    assert app.state.geo.calls == [INDIA_V4, INDIA_V6]


def test_misleading_forwarded_for_chain_is_ignored(client, app, db):
    # a Railway-style chain whose last entry is a public edge node abroad, plus a client-forged first entry
    xff = f"8.8.8.8, {INDIA_V4}, 66.33.22.11"
    s = _session(db, post_visit(client, {"X-Real-IP": INDIA_V4, "X-Forwarded-For": xff}))
    assert (s.geo_country_code, s.geo_region) == ("IN", "Tamil Nadu")
    # without X-Real-IP the chain is still not trusted: Unknown, and no lookup of any chain entry
    s = _session(db, post_visit(client, {"X-Forwarded-For": xff}))
    assert s.geo_country_code is None and app.state.geo.calls == [INDIA_V4, None]


@pytest.mark.parametrize("bad", ["100.64.0.9", "10.1.2.3", "not-an-ip", "::1"])
def test_internal_or_invalid_real_ip_gives_unknown_without_lookup(client, app, db, bad):
    s = _session(db, post_visit(client, {"X-Real-IP": bad}))
    assert s.geo_country_code is None and s.geo_region is None and app.state.geo.calls == [None]


def test_region_is_fixed_at_session_creation(client, app, db):
    tok = post_visit(client, {"X-Real-IP": INDIA_V4})
    client.post("/api/visits", json={"session_token": tok}, headers={"X-Real-IP": "8.8.8.8"})  # same browser, new network
    s = _session(db, tok)
    assert s.geo_region == "Tamil Nadu" and app.state.geo.calls == [INDIA_V4]  # one lookup per session
