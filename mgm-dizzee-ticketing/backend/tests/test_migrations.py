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
