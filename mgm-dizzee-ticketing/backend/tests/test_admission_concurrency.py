"""Group admission under real concurrency (PostgreSQL only; SQLite serializes writers and so proves nothing).

Every worker uses its own session and connection, starts on a barrier and commits or rolls back as the API does."""
import pytest
from sqlalchemy import func, select

from app import bookings, gate
from app.models import GateAdmission, GateScan, Ticket
from .conftest import TODAY, paid_booking
from .test_concurrency import race

pytestmark = pytest.mark.usefixtures("app")


@pytest.fixture(autouse=True)
def _postgres_only(app):
    if app.state.engine.dialect.name != "postgresql":
        pytest.skip("concurrency tests need PostgreSQL (set TEST_DATABASE_URL)")


def _admit(settings, qr, q, g):
    return lambda s, i: gate.admit(s, settings, raw=qr, quantities=q, gate=f"Gate {g(i)}", staff_code=f"STF{i}",
                                   device_id=f"dev-{i}", client_txn_id=f"txn-{i}")


def test_many_gates_never_admit_more_than_purchased(client, db, settings):
    _, b = paid_booking(client, cart={"tickets": {"ga": 3, "gc": 2}}, visit_date=TODAY)
    res = race(client.app, 12, _admit(settings, b["entryQr"], {"ga": 1}, lambda i: i % 4))
    ok = [r for r in res if isinstance(r, dict)]
    assert len(ok) == 3 and all(isinstance(r, bookings.Conflict) for r in res if not isinstance(r, dict))
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Ticket).where(Ticket.category_id == "ga", Ticket.status == "used")) == 3
    assert db.scalar(select(func.count()).select_from(Ticket).where(Ticket.category_id == "gc", Ticket.status == "used")) == 0
    assert db.scalar(select(func.count()).select_from(GateAdmission)) == 3
    assert db.scalar(select(func.count()).select_from(GateScan).where(GateScan.result == "valid")) == 3


def test_overlapping_group_requests_only_one_fits(client, db, settings):
    _, b = paid_booking(client, cart={"tickets": {"ga": 3, "gc": 2}}, visit_date=TODAY)
    res = race(client.app, 2, _admit(settings, b["entryQr"], {"ga": 2, "gc": 2}, lambda i: i))
    assert sum(isinstance(r, dict) for r in res) == 1 and sum(isinstance(r, bookings.Conflict) for r in res) == 1
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Ticket).where(Ticket.status == "used")) == 4  # the loser rolled back fully
    assert db.scalar(select(func.count()).select_from(GateAdmission)) == 1


def test_group_admission_racing_single_ticket_scans(client, db, settings):
    _, b = paid_booking(client, cart={"tickets": {"ga": 4}}, visit_date=TODAY)
    qrs = [t["qr"] for t in b["tickets"]]

    def work(s, i):
        if i < 4:
            return gate.scan(s, settings, raw=qrs[i], gate="Gate S", staff_code=f"STF{i}", device_id=f"d{i}", client_scan_id=f"s{i}")
        return gate.admit(s, settings, raw=b["entryQr"], quantities={"ga": 2}, gate="Gate G", staff_code="STF9",
                          device_id="dg", client_txn_id=f"g{i}")
    res = race(client.app, 6, work)
    db.expire_all()
    used = db.scalar(select(func.count()).select_from(Ticket).where(Ticket.status == "used"))
    group = sum(r["admission"]["quantity"] for r in res[4:] if isinstance(r, dict))
    singles = sum(1 for r in res[:4] if isinstance(r, dict) and r["kind"] == "valid")
    summary = [(r.get("kind") or r["admission"]["quantity"]) if isinstance(r, dict) else f"{type(r).__name__}: {r}" for r in res]
    assert not [r for r in res if isinstance(r, Exception) and not isinstance(r, bookings.Conflict)], summary  # e.g. no deadlocks
    assert used == 4 and group + singles == 4, (used, group, singles, summary)  # every admitted person maps to exactly one ticket


def test_same_transaction_retried_concurrently_admits_once(client, db, settings):
    _, b = paid_booking(client, cart={"tickets": {"ga": 3}}, visit_date=TODAY)
    res = race(client.app, 4, lambda s, i: gate.admit(s, settings, raw=b["entryQr"], quantities={"ga": 2}, gate="Gate 1",
                                                      staff_code="STF1", device_id="dev-1", client_txn_id="txn-same"))
    refs = {r["admission"]["ref"] for r in res if isinstance(r, dict)}
    assert len(refs) == 1
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Ticket).where(Ticket.status == "used")) == 2
