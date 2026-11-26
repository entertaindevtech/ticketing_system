"""Date validity and group admission (Model A: one booking QR, several admission transactions)."""
from dataclasses import replace

from sqlalchemy import func, select

from app import security
from app.models import AuditLog, GateAdmission, GateScan, Ticket
from .conftest import ADMIN, CSRF, TODAY, login, make_staff, paid_booking

FAMILY = {"tickets": {"ga": 3, "gc": 2}}


def lookup(client, code, h=ADMIN):
    return client.post("/api/gate/booking", json={"code": code}, headers=h)


def admit(client, code, q, h=ADMIN, **kw):
    return client.post("/api/gate/booking/admit", json={"code": code, "quantities": q, **kw}, headers=h)


def cats(view):
    return {c["catId"]: (c["purchased"], c["admitted"], c["remaining"]) for c in view["categories"]}


def test_staggered_family_arrival_with_category_accounting(client, db):
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    qr = b["entryQr"]
    v = lookup(client, qr).json()
    assert v["status"] == "VALID" and v["booking"]["ref"] == b["id"] and cats(v) == {"ga": (3, 0, 3), "gc": (2, 0, 2)}
    assert db.scalar(select(func.count()).select_from(Ticket).where(Ticket.status == "used")) == 0  # lookup admits no one

    first = admit(client, qr, {"ga": 2, "gc": 1}, gate="Main Gate B").json()
    assert first["admission"]["quantity"] == 3 and first["admission"]["ref"].startswith("ADM-")
    assert {x["catId"]: x["quantity"] for x in first["admission"]["lines"]} == {"ga": 2, "gc": 1}
    assert cats(first) == {"ga": (3, 2, 1), "gc": (2, 1, 1)} and first["totals"]["remaining"] == 2 and not first["fullyRedeemed"]

    # more than remains, per category and in total, is refused and changes nothing
    assert admit(client, qr, {"ga": 2}).status_code == 409
    assert admit(client, qr, {"gc": 2}).status_code == 409
    assert admit(client, qr, {"ga": 1, "gc": 2}).status_code == 409
    assert cats(lookup(client, qr).json()) == {"ga": (3, 2, 1), "gc": (2, 1, 1)}

    second = admit(client, qr, {"ga": 1, "gc": 1}).json()
    assert second["fullyRedeemed"] and second["totals"] == {"purchased": 5, "admitted": 5, "remaining": 0}
    assert [h["quantity"] for h in second["history"]] == [2, 3]  # newest first; earlier transaction kept
    assert admit(client, qr, {"ga": 1}).status_code == 409
    assert lookup(client, qr).json()["fullyRedeemed"]

    used = db.scalars(select(Ticket).where(Ticket.status == "used")).all()
    assert len(used) == 5 and all(t.admission_id and t.used_at for t in used)
    assert {t.used_gate for t in used if t.admission_id == db.scalar(select(GateAdmission.id).where(GateAdmission.ref == first["admission"]["ref"]))} == {"Main Gate B"}
    rows = db.scalars(select(GateScan).where(GateScan.result == "valid")).all()
    assert len(rows) == 2 and all(r.booking_ref == b["id"] and "Group admission" in r.reason for r in rows)


def test_single_person_booking(client):
    _, b = paid_booking(client, cart={"tickets": {"ga": 1}}, visit_date=TODAY)
    r = admit(client, b["entryQr"], {"ga": 1}).json()
    assert r["fullyRedeemed"] and r["admission"]["quantity"] == 1


def test_quantities_are_validated(client):
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    assert admit(client, b["entryQr"], {}).status_code == 422
    assert admit(client, b["entryQr"], {"ga": 0}).status_code == 422
    assert admit(client, b["entryQr"], {"ga": -1}).status_code == 422
    assert admit(client, b["entryQr"], {"fa": 1}).status_code == 422  # a category this booking doesn't have
    assert cats(lookup(client, b["entryQr"]).json())["ga"] == (3, 0, 3)


def test_date_validity_uses_the_park_clock(app, client, db):
    _, future = paid_booking(client, cart=FAMILY, visit_date="2026-12-02")
    early = lookup(client, future["entryQr"]).json()
    assert early["status"] == "NOT_YET_VALID" and cats(early)["ga"] == (3, 0, 3)  # details still shown
    assert admit(client, future["entryQr"], {"ga": 1}).status_code == 409
    app.state.settings = replace(app.state.settings, demo_today="2026-12-02")
    assert lookup(client, future["entryQr"]).json()["status"] == "VALID"
    app.state.settings = replace(app.state.settings, demo_today="2026-12-03")
    assert lookup(client, future["entryQr"]).json()["status"] == "EXPIRED"
    assert admit(client, future["entryQr"], {"ga": 1}).status_code == 409
    assert db.scalar(select(func.count()).select_from(Ticket).where(Ticket.status == "used")) == 0
    # single-ticket scans report the same statuses
    app.state.settings = replace(app.state.settings, demo_today=TODAY)
    s = client.post("/api/gate/scan", json={"code": future["tickets"][0]["qr"]}, headers=ADMIN).json()
    assert s["kind"] == "invalid" and s["status"] == "NOT_YET_VALID"


def test_cancelled_and_invalid_codes_are_rejected(client, db):
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    forged = security.booking_qr_payload("someone-elses-secret-0000000000000000", b["id"], TODAY)
    for code in (forged, b["entryQr"].replace(TODAY, "2026-11-21"), "MGM-ZZZZZZ", "hello", b["tickets"][0]["qr"]):
        v = lookup(client, code).json()
        assert v["status"] == "INVALID" and v["booking"] is None, code
        assert admit(client, code, {"ga": 1}).status_code in (404, 422), code
    client.post(f"/api/admin/bookings/{b['id']}/cancel", headers=ADMIN)
    assert lookup(client, b["entryQr"]).json()["status"] == "CANCELLED"
    assert admit(client, b["entryQr"], {"ga": 1}).status_code == 409
    s = client.post("/api/gate/scan", json={"code": b["tickets"][0]["qr"]}, headers=ADMIN).json()
    assert s["status"] == "CANCELLED"
    assert db.scalar(select(func.count()).select_from(GateScan).where(GateScan.result == "valid")) == 0
    assert db.scalar(select(func.count()).select_from(GateScan).where(GateScan.result == "invalid")) >= 6  # rejections are recorded


def test_retry_with_same_transaction_id_is_not_a_second_admission(client, db):
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    kw = {"device_id": "dev-1", "client_txn_id": "txn-1"}
    a = admit(client, b["entryQr"], {"ga": 2}, **kw).json()
    again = admit(client, b["entryQr"], {"ga": 2}, **kw).json()
    assert a["admission"]["ref"] == again["admission"]["ref"] and again["totals"]["admitted"] == 2
    assert db.scalar(select(func.count()).select_from(GateAdmission)) == 1
    assert db.scalar(select(func.count()).select_from(Ticket).where(Ticket.status == "used")) == 2


def test_ticket_qrs_and_booking_qr_share_one_count(client, db):
    """Previously issued per-ticket QRs keep working, and they consume the same admissions as the booking QR."""
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    adult = next(t for t in b["tickets"] if t["catId"] == "ga")
    assert client.post("/api/gate/scan", json={"code": adult["qr"]}, headers=ADMIN).json()["kind"] == "valid"
    v = lookup(client, b["entryQr"]).json()
    assert cats(v)["ga"] == (3, 1, 2)  # the ticket scan consumed one of the booking's adult admissions
    assert [(h["kind"], h["quantity"], h["lines"][0]["catId"]) for h in v["history"]] == [("admit", 1, "ga")]
    admit(client, b["entryQr"], {"ga": 2, "gc": 2})
    assert client.post("/api/gate/scan", json={"code": adult["qr"]}, headers=ADMIN).json()["kind"] == "duplicate"
    other = next(t for t in b["tickets"] if t["catId"] == "gc")
    assert client.post("/api/gate/scan", json={"code": other["qr"]}, headers=ADMIN).json()["kind"] == "duplicate"


def test_modified_booking_outdates_old_booking_qr(client):
    _, b = paid_booking(client, cart=FAMILY, visit_date="2026-12-02")
    client.post(f"/api/admin/bookings/{b['id']}/modify", json={"visit_date": TODAY, "tickets": FAMILY["tickets"], "addons": {}}, headers=ADMIN)
    assert "Outdated QR" in lookup(client, b["entryQr"]).json()["reason"]
    fresh = client.get(f"/api/admin/bookings/{b['id']}", headers=ADMIN).json()
    assert lookup(client, fresh["entryQr"]).json()["status"] == "VALID"
    assert lookup(client, b["id"]).json()["status"] == "VALID"  # booking reference typed by staff


def test_permissions_and_supervisor_correction(client, db):
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    qr = b["entryQr"]
    assert client.post("/api/gate/booking", json={"code": qr}).status_code == 401
    make_staff(db, code="MKT2001", roles="marketing")
    assert login(client, code="MKT2001").status_code == 200
    assert client.post("/api/gate/booking", json={"code": qr}, headers=CSRF).status_code == 403
    make_staff(db, code="STF2001", roles="gate", gate="Main Gate A")
    assert login(client, code="STF2001").status_code == 200
    r = client.post("/api/gate/booking/admit", json={"code": qr, "quantities": {"ga": 2, "gc": 1}}, headers=CSRF).json()
    adm = r["admission"]
    assert adm["gate"] == "Main Gate A" and adm["staffId"] == "STF2001"  # gate and staff come from the session
    # ordinary gate staff cannot reverse an admission
    assert client.post(f"/api/gate/admissions/{adm['ref']}/correct", json={"quantities": {"ga": 1}, "reason": "Wrong count"},
                       headers=CSRF).status_code == 403
    client.cookies.clear()

    def correct(q, reason="Staff selected one adult too many"):
        return client.post(f"/api/gate/admissions/{adm['ref']}/correct", json={"quantities": q, "reason": reason}, headers=ADMIN)
    assert correct({"ga": 1}, reason="oops").status_code == 422  # a real reason is required
    assert correct({"ga": 3}).status_code == 409  # more than that transaction admitted
    c = correct({"ga": 1}).json()
    assert c["admission"]["kind"] == "correction" and cats(c)["ga"] == (3, 1, 2)
    assert [h["kind"] for h in c["history"]] == ["correction", "admit"] and c["history"][1]["quantity"] == 3  # original kept
    log = db.scalar(select(AuditLog).where(AuditLog.type == "gate_correction"))
    assert log.ref == b["id"] and "selected one adult" in log.message and log.details["admission"] == adm["ref"]
    assert correct({"ga": 2}).status_code == 409  # only one adult left on that transaction
    assert admit(client, qr, {"ga": 2, "gc": 1}).json()["fullyRedeemed"]


def test_single_ticket_scans_are_recorded_and_correctable_like_group_admissions(client, db):
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    child = next(t for t in b["tickets"] if t["catId"] == "gc")
    assert client.post("/api/gate/scan", json={"code": child["qr"]}, headers=ADMIN).json()["kind"] == "valid"
    adm = db.scalar(select(GateAdmission))
    assert adm.kind == "admit" and adm.quantity == 1 and db.scalar(select(Ticket).where(Ticket.code == child["id"])).admission_id == adm.id
    r = client.post(f"/api/gate/admissions/{adm.ref}/correct", json={"quantities": {"gc": 1}, "reason": "Child turned back at the gate"}, headers=ADMIN)
    assert r.status_code == 200, r.text
    assert cats(r.json())["gc"] == (2, 0, 2)
    # the ticket can be scanned again, and the first scan, the correction and the new scan are all kept
    assert client.post("/api/gate/scan", json={"code": child["qr"]}, headers=ADMIN).json()["kind"] == "valid"
    assert [h["kind"] for h in lookup(client, b["entryQr"]).json()["history"]] == ["admit", "correction", "admit"]
    assert db.scalar(select(func.count()).select_from(GateScan).where(GateScan.result == "valid")) == 2


def test_corrections_are_refused_on_cancelled_bookings_and_after_the_visit_day(app, client, db):
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    ref = admit(client, b["entryQr"], {"ga": 2}).json()["admission"]["ref"]
    body = {"quantities": {"ga": 1}, "reason": "Counted one adult twice"}
    app.state.settings = replace(app.state.settings, demo_today="2026-11-21")
    assert client.post(f"/api/gate/admissions/{ref}/correct", json=body, headers=ADMIN).status_code == 409
    app.state.settings = replace(app.state.settings, demo_today=TODAY)
    client.post(f"/api/admin/bookings/{b['id']}/cancel", headers=ADMIN)
    r = client.post(f"/api/gate/admissions/{ref}/correct", json=body, headers=ADMIN)
    assert r.status_code == 409 and "cancelled" in r.json()["detail"]
    assert db.scalar(select(func.count()).select_from(Ticket).where(Ticket.status == "used")) == 2  # nothing reversed
    assert db.scalar(select(func.count()).select_from(GateAdmission).where(GateAdmission.kind == "correction")) == 0


def test_only_administrators_can_correct(client, db):
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    ref = admit(client, b["entryQr"], {"ga": 1}).json()["admission"]["ref"]
    body = {"quantities": {"ga": 1}, "reason": "Counted one adult twice"}
    assert client.post(f"/api/gate/admissions/{ref}/correct", json=body).status_code == 401  # not signed in
    for code, roles in (("STF3001", "gate"), ("FIN3001", "finance"), ("CNT3001", "counter"), ("MKT3001", "marketing")):
        make_staff(db, code=code, roles=roles)
        assert login(client, code=code).status_code == 200
        assert client.post(f"/api/gate/admissions/{ref}/correct", json=body, headers=CSRF).status_code == 403, roles
        client.cookies.clear()
    assert db.scalar(select(func.count()).select_from(GateAdmission).where(GateAdmission.kind == "correction")) == 0


def test_summary_separates_transactions_from_people(client, db):
    make_staff(db, code="STF4001", roles="gate")
    assert login(client, code="STF4001").status_code == 200
    _, b = paid_booking(client, cart=FAMILY, visit_date=TODAY)
    _, single = paid_booking(client, cart={"tickets": {"ga": 1}}, visit_date=TODAY, customer={"name": "Solo", "phone": "9876500001", "email": "s@example.com"})
    ref = admit(client, b["entryQr"], {"ga": 2, "gc": 1}, h=CSRF).json()["admission"]["ref"]
    client.post("/api/gate/scan", json={"code": single["tickets"][0]["qr"]}, headers=CSRF)
    client.post("/api/gate/scan", json={"code": single["tickets"][0]["qr"]}, headers=CSRF)  # duplicate
    lookup(client, "MGM-ZZZZZZ", h=CSRF)  # invalid
    assert client.get("/api/gate/summary", headers=CSRF).json() == {"admissions": 2, "people": 4, "rejected": 2}
    client.cookies.clear()
    client.post(f"/api/gate/admissions/{ref}/correct", json={"quantities": {"gc": 1}, "reason": "Child stayed outside"}, headers=ADMIN)
    login(client, code="STF4001")
    assert client.get("/api/gate/summary", headers=CSRF).json() == {"admissions": 2, "people": 3, "rejected": 2}
