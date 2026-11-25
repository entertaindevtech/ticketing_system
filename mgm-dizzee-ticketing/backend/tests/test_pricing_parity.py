"""The Python pricing engine must reproduce the TypeScript engine exactly (fixture: scripts/pricing-fixture.ts)."""
import json
import os

import pytest

from app import pricing

FIXTURE = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "pricing_parity.json"), encoding="utf-8"))
CTX = {**FIXTURE["ctx"], "settings": {**FIXTURE["ctx"]["settings"], "saleStart": "2026-11-01", "saleEnd": "2026-12-31"}}


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: f"{c['date']}-{c['bookedOn']}")
def test_python_engine_matches_typescript(case):
    p = pricing.price_cart(case["cart"], case["date"], CTX, case["bookedOn"])
    got = {k: p[k] for k in case["expected"] if k not in ("couponError", "issues")}
    exp = {k: v for k, v in case["expected"].items() if k not in ("couponError", "issues")}
    assert got == exp
    assert bool(p["couponError"]) == case["expected"]["couponError"]
    assert len(p["issues"]) == case["expected"]["issues"]


def test_fixture_covers_offers_coupons_and_rounding():
    cases = FIXTURE["cases"]
    assert len(cases) >= 400
    assert sum(1 for c in cases if c["expected"]["couponOfferId"]) >= 20
    assert {l["refId"] for c in cases for l in c["expected"]["lines"] if l["kind"] == "offer"} >= {"o-b4g2", "o-family", "o-weekend", "o-student"}
    assert any(c["cart"]["tickets"].get("fc") for c in cases)  # half-rupee base price


def test_js_round_is_half_up():
    assert [pricing.js_round(x) for x in (0.5, 1.5, 2.5, -0.5, 458.46)] == [1, 2, 3, 0, 458]
