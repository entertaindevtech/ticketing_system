// Front-end rules that remain in the browser: the price preview and the display-only eligibility hints.
// Authoritative booking behaviour (payment, tickets, cancellation, refunds, modification, gate) is tested on the
// server: backend/tests. Run: npm test  (Node >= 22.18 strips TypeScript natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Booking, SEED_DATE_CFG, addDays, cancellationEligibility, cancellationFee, defaultSettings, modificationEligibility, priceCart,
  seedAddons, seedOffers, seedTickets, setToday,
} from "../src/store.ts";

setToday("2026-11-20", { saleStart: "2026-11-01", saleEnd: "2026-12-31" });
const ctx = { tickets: seedTickets(), offers: seedOffers(), dateCfg: SEED_DATE_CFG(), settings: defaultSettings() };

function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: "MGM-TEST01", createdAt: "2026-11-20T10:00:00", visitDate: "2026-12-02",
    customer: { name: "T", phone: "9000000001", email: "", visitors: 2, notes: "" },
    items: [], offerIds: [], coupon: "", totals: { subtotal: 2547, discount: 0, addons: 349, tax: 458, total: 3005, complimentary: 0 },
    payment: { txnId: "x", method: "UPI", status: "paid", gateway: "", at: "" }, status: "confirmed",
    tickets: [{ id: "TKT-1", catId: "ga", label: "General Adult", status: "valid" }, { id: "TKT-2", catId: "ga", label: "General Adult", status: "valid" }],
    ...over,
  };
}

test("price preview: tickets, add-ons and GST", () => {
  const p = priceCart({ tickets: { ga: 2 }, offers: {}, addons: { food: 1 }, coupon: "" }, "2026-12-02", ctx, "2026-11-20", seedAddons());
  assert.equal(p.subtotal, 2547);
  assert.equal(p.tax, 458);
  assert.equal(p.total, 3005);
  assert.equal(p.ticketCount, 2);
});

test("price preview: weekend and holiday adjustments, blackout handled by date status", () => {
  const sat = priceCart({ tickets: { ga: 1 }, offers: {}, addons: {}, coupon: "" }, "2026-11-28", ctx, "2026-11-20", seedAddons());
  assert.equal(sat.lines[0].unit, Math.round(1099 * 1.1));
  const xmas = priceCart({ tickets: { ga: 1 }, offers: {}, addons: {}, coupon: "" }, "2026-12-25", ctx, "2026-11-20", seedAddons());
  assert.equal(xmas.lines[0].unit, Math.round(1099 * 1.25));
});

test("cancellation hints follow the server's rules and the configured fee", () => {
  const s = { cancelNoticeDays: 2, cancellationFeePct: 25 };
  assert.deepEqual(cancellationEligibility(booking(), s), { ok: true, reason: "" });
  assert.equal(cancellationFee(booking(), s), 751);
  assert.match(cancellationEligibility(booking({ visitDate: addDays("2026-11-20", 1) }), s).reason, /48 hours/);
  assert.match(cancellationEligibility(booking({ offerIds: ["o-family"] }), s).reason, /offer/);
  assert.match(cancellationEligibility(booking({ payment: { txnId: "", method: "", status: "pending", gateway: "", at: "" } }), s).reason, /paid/);
  assert.match(cancellationEligibility(booking({ refund: { amount: 1, at: "", reason: "", status: "pending" } }), s).reason, /pending/);
});

test("modification hints", () => {
  assert.equal(modificationEligibility(booking(), { dateCfg: {} }).ok, true);
  assert.match(modificationEligibility(booking({ coupon: "MGM30" }), { dateCfg: {} }).reason, /offers or coupons/);
  assert.match(modificationEligibility(booking({ tickets: [{ id: "T", catId: "ga", label: "", status: "used" }] }), { dateCfg: {} }).reason, /used/);
});
