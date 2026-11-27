import os

import pytest

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from app import models  # noqa: F401
from app.db import Base

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def db_url(tmp_path):
    """SQLite file, or TEST_DATABASE_URL (a disposable database) wiped to an empty schema before and after."""
    from app.db import normalize_url
    url = os.environ.get("TEST_DATABASE_URL")
    if not (url or "").startswith("postgres"):
        yield f"sqlite:///{tmp_path / 'mig.db'}"
        return
    url = normalize_url(url)

    def wipe():
        eng = create_engine(url)
        with eng.begin() as c:
            c.execute(text("DROP SCHEMA public CASCADE"))
            c.execute(text("CREATE SCHEMA public"))
        eng.dispose()

    wipe()
    yield url
    wipe()


def _cfg(url):
    cfg = Config(os.path.join(HERE, "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))  # configparser interpolation
    return cfg


def test_migration_matches_models_and_downgrades(db_url):
    url = db_url
    cfg = _cfg(url)
    command.upgrade(cfg, "head")
    insp = inspect(create_engine(url))
    tables = set(insp.get_table_names()) - {"alembic_version"}
    assert tables == set(Base.metadata.tables)
    for name, table in Base.metadata.tables.items():
        assert {c["name"] for c in insp.get_columns(name)} == {c.name for c in table.columns}, name
    command.downgrade(cfg, "base")
    assert set(inspect(create_engine(url)).get_table_names()) <= {"alembic_version"}


def test_0002_keeps_and_backfills_existing_influencer_data(db_url):
    url = db_url
    cfg = _cfg(url)
    command.upgrade(cfg, "0001")
    eng = create_engine(url)
    with eng.begin() as c:
        c.execute(text("INSERT INTO influencers (id, name, platform, referral_code, commission_rate, active) VALUES (1,'A','Instagram','AAA111',8,TRUE)"))
        c.execute(text("INSERT INTO referral_sessions (id, token, influencer_id, created_at, expires_at, geo_region) VALUES (1,'tok',1,'2026-11-01','2026-12-01','Kerala')"))
        c.execute(text("INSERT INTO booking_attributions (id, booking_ref, influencer_id, session_id, paid_at, tickets, ticket_net_amount, addons_amount, tax_amount, total_amount, status, geo_region) "
                       "VALUES (1,'MGM-OLD001',1,1,'2026-11-02',2,100,0,18,118,'paid','Kerala')"))
    command.upgrade(cfg, "head")
    with eng.connect() as c:
        s = c.execute(text("SELECT token, influencer_id, source, attributed_at, attribution_expires_at, expires_at, geo_region FROM visitor_sessions")).one()
        b = c.execute(text("SELECT booking_ref, session_id, source, geo_region FROM booking_attributions")).one()
    assert s.token == "tok" and s.influencer_id == 1 and s.source == "influencer" and s.geo_region == "Kerala"
    assert s.attributed_at is not None and s.attribution_expires_at == s.expires_at
    assert tuple(b) == ("MGM-OLD001", 1, "influencer", "Kerala")


def test_0009_leaves_existing_tickets_bookings_payments_and_scans_untouched(db_url):
    """Group admissions (0009) is additive: every ticket state, booking, payment and scan row survives upgrade and
    downgrade unchanged, old used tickets get no invented admission, and the ticket CHECK constraints still hold."""
    url = db_url
    cfg = _cfg(url)
    command.upgrade(cfg, "0008")
    eng = create_engine(url)
    with eng.begin() as c:
        c.execute(text("INSERT INTO customers (id, phone, name) VALUES (1, '9876543210', 'Old Customer')"))
        for bid, ref, status in ((1, "MGM-OLD001", "confirmed"), (2, "MGM-OLD002", "cancelled"), (3, "MGM-OLD003", "pending_payment")):
            c.execute(text("INSERT INTO bookings (id, ref, customer_id, channel, visit_date, status, name, phone, subtotal, discount, addons_total, tax, total, "
                           "offer_ids, units) VALUES (:i, :r, 1, 'web', '2026-11-20', :s, 'Old Customer', '9876543210', 100, 0, 0, 18, 118, '[]', '[]')"),
                      {"i": bid, "r": ref, "s": status})
        for tid, code, bid, cat, st in ((1, "TKT-ISSUED01", 1, "ga", "issued"), (2, "TKT-USED0001", 1, "gc", "used"), (3, "TKT-VOID0001", 2, "ga", "void")):
            c.execute(text("INSERT INTO tickets (id, code, booking_id, category_id, label, visit_date, status, used_at, used_gate, used_by) "
                           "VALUES (:i, :c, :b, :cat, 'Old ticket', '2026-11-20', :s, :u, :g, :by)"),
                      {"i": tid, "c": code, "b": bid, "cat": cat, "s": st, "u": "2026-11-20 10:00:00" if st == "used" else None,
                       "g": "Main Gate A" if st == "used" else None, "by": "STF1024" if st == "used" else None})
        c.execute(text("INSERT INTO payments (id, booking_id, provider, amount, status) VALUES (1, 1, 'simulated', 118, 'captured')"))
        c.execute(text("INSERT INTO gate_scans (id, ticket_id, ticket_code, booking_ref, gate, staff_code, result, reason) "
                       "VALUES (1, 2, 'TKT-USED0001', 'MGM-OLD001', 'Main Gate A', 'STF1024', 'valid', 'Entry approved')"))

    def snapshot():
        with eng.connect() as c:
            return {t: [tuple(r) for r in c.execute(text(f"SELECT {cols} FROM {t} ORDER BY id"))] for t, cols in (
                ("bookings", "id, ref, status, visit_date, total"), ("payments", "id, booking_id, amount, status"),
                ("tickets", "id, code, booking_id, category_id, status, used_at, used_gate, used_by"),
                ("gate_scans", "id, ticket_id, booking_ref, result, reason"))}
    before = snapshot()
    command.upgrade(cfg, "head")
    assert snapshot() == before
    with eng.connect() as c:
        assert c.execute(text("SELECT COUNT(*) FROM tickets WHERE admission_id IS NOT NULL")).scalar() == 0
        assert c.execute(text("SELECT COUNT(*) FROM gate_admissions")).scalar() == 0
    with pytest.raises(Exception):  # the used-needs-used_at CHECK survived the table change
        with eng.begin() as c:
            c.execute(text("UPDATE tickets SET status = 'used', used_at = NULL WHERE id = 1"))
    command.downgrade(cfg, "0008")
    assert snapshot() == before
    eng.dispose()
