// Regression tests for booking business rules. Run: npm test  (Node >= 22.18 strips TypeScript natively)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Booking, type DB, TODAY, addDays, adminCancel, approveRefund, buildBooking, cancellationEligibility, evaluateScan,
  isRefunded, logEvent, modifyBooking, priceCart, qrPayload, rejectRefund, requestCancellation, seedDB,
} from "../src/store.ts";

function setup(visitDate = addDays(TODAY, 5), cart = { tickets: { ga: 2 } as Record<string, number>, offers: {} as Record<string, number>, addons: { food: 1 } as Record<string, number>, coupon: "" }) {
  const d: DB = seedDB();
  const ctx = { tickets: d.tickets, offers: d.offers, dateCfg: d.dateCfg, settings: d.settings };
  const pr = priceCart(cart, visitDate, ctx, TODAY, d.addons);
  const b = buildBooking(cart, pr, visitDate, { name: "Test", phone: "9000000001", email: "t@example.com", visitors: pr.ticketCount, notes: "" }, "UPI", Math.random, undefined, ctx);
  d.bookings.unshift(b);
  return { d, b: () => d.bookings.find((x) => x.id === b.id) as Booking };
}

test("customer booking: pricing includes add-ons and GST, tickets issued per quantity", () => {
  const { b, d } = setup();
  const bk = b();
  const ga = d.tickets.find((t) => t.id === "ga")!;
  assert.equal(bk.tickets.length, 2);
  assert.equal(bk.totals.addons, 349);
  assert.equal(bk.totals.tax, Math.round(((bk.totals.subtotal - bk.totals.discount) * 18) / 100));
  assert.ok(bk.totals.subtotal >= ga.basePrice * 2 + 349);
  assert.equal(bk.payment.status, "paid");
});

test("cancellation request keeps the booking valid until approved and is logged", () => {
  const { d, b } = setup();
  assert.ok(requestCancellation(d, b().id));
  assert.equal(b().status, "confirmed");
  assert.equal(b().refund?.status, "pending");
  assert.equal(b().refund?.deduction, Math.round(b().totals.total * 0.1));
  assert.equal(b().refund!.amount + b().refund!.deduction!, b().totals.total);
  assert.ok(b().tickets.every((t) => t.status === "valid"));
  assert.ok(!isRefunded(b()));
  assert.equal(d.notifications![0].ref, b().id);
  assert.equal(d.auditLog![0].actor, "Customer");
  assert.equal(requestCancellation(d, b().id), false, "no duplicate request");
});

test("cancellation eligibility rules", () => {
  const unpaid = setup(); unpaid.b().payment.status = "pending";
  assert.match(cancellationEligibility(unpaid.b()).reason, /Only paid/);
  const soon = setup(addDays(TODAY, 1));
  assert.match(cancellationEligibility(soon.b()).reason, /48 hours/);
  const offer = setup(); offer.b().offerIds = ["o-student"];
  assert.match(cancellationEligibility(offer.b()).reason, /offer/);
  const used = setup(); used.b().tickets[0].status = "used";
  assert.equal(cancellationEligibility(used.b()).ok, false);
  assert.equal(cancellationEligibility(setup().b()).ok, true);
});

test("approving a refund cancels the booking and its tickets fail at the gate", () => {
  const { d, b } = setup();
  requestCancellation(d, b().id);
  assert.ok(approveRefund(d, b().id));
  assert.equal(b().status, "cancelled");
  assert.equal(b().payment.status, "refunded");
  assert.equal(b().refund?.status, "approved");
  assert.ok(isRefunded(b()));
  assert.ok(b().tickets.every((t) => t.status === "cancelled"));
  const r = evaluateScan(qrPayload(b().tickets[0], b()), d);
  assert.equal(r.kind, "invalid");
  assert.equal(approveRefund(d, b().id), false, "cannot approve twice");
});

test("rejecting a refund leaves the booking confirmed with the reason recorded", () => {
  const { d, b } = setup();
  requestCancellation(d, b().id);
  assert.ok(rejectRefund(d, b().id, "Visit already scheduled for group"));
  assert.equal(b().status, "confirmed");
  assert.equal(b().refund?.status, "rejected");
  assert.equal(b().refund?.rejectionReason, "Visit already scheduled for group");
  assert.ok(!isRefunded(b()));
  assert.equal(approveRefund(d, b().id), false);
});

test("admin one-step cancel keeps used tickets as used and refunds total minus 10%", () => {
  const { d, b } = setup(TODAY);
  b().tickets[0].status = "used";
  assert.ok(adminCancel(d, b().id));
  assert.equal(b().tickets[0].status, "used");
  assert.equal(b().tickets[1].status, "cancelled");
  assert.equal(b().refund?.amount, b().totals.total - Math.round(b().totals.total * 0.1));
  assert.ok(isRefunded(b()));
  assert.equal(adminCancel(d, b().id), false);
});

test("modification keeps existing ticket IDs, reprices and records history", () => {
  const { d, b } = setup();
  const before = b().tickets.map((t) => t.id);
  const prevTotal = b().totals.total;
  const r = modifyBooking(d, b().id, addDays(TODAY, 6), { ga: 3 }, { food: 1 });
  assert.deepEqual(r, { ok: true, error: "" });
  assert.equal(b().tickets.length, 3);
  assert.deepEqual(b().tickets.slice(0, 2).map((t) => t.id), before, "existing QR codes stay valid");
  assert.equal(new Set(b().tickets.map((t) => t.id)).size, 3);
  assert.equal(b().visitDate, addDays(TODAY, 6));
  assert.equal(b().modifications?.[0].previousTotal, prevTotal);
  assert.equal(b().modifications?.[0].newTotal, b().totals.total);
  assert.equal(b().payment.status, "paid", "payment record untouched");
  assert.ok(modifyBooking(d, b().id, addDays(TODAY, 6), { ga: 1 }, {}).ok);
  assert.deepEqual(b().tickets.map((t) => t.id), [before[0]]);
  assert.equal(b().totals.addons, 0);
});

test("modification is refused when it could corrupt tickets or offer pricing", () => {
  const offer = setup(); offer.b().offerIds = ["o-student"];
  assert.match(modifyBooking(offer.d, offer.b().id, addDays(TODAY, 6), { ga: 1 }, {}).error, /offers or coupons/);
  const used = setup(TODAY); used.b().tickets[0].status = "used";
  assert.match(modifyBooking(used.d, used.b().id, TODAY, { ga: 2 }, {}).error, /used/);
  const pending = setup(); requestCancellation(pending.d, pending.b().id);
  assert.match(modifyBooking(pending.d, pending.b().id, addDays(TODAY, 6), { ga: 1 }, {}).error, /pending/);
  const ok = setup();
  assert.match(modifyBooking(ok.d, ok.b().id, "2026-12-03", { ga: 1 }, {}).error, /not available/, "blackout date");
  assert.match(modifyBooking(ok.d, ok.b().id, addDays(TODAY, 6), {}, {}).error, /at least one ticket/);
  const cancelled = setup(); adminCancel(cancelled.d, cancelled.b().id);
  assert.equal(modifyBooking(cancelled.d, cancelled.b().id, addDays(TODAY, 6), { ga: 1 }, {}).ok, false);
});

test("gate validation: valid, duplicate, wrong date, unpaid", () => {
  const { d, b } = setup(TODAY);
  const t = b().tickets[0];
  assert.equal(evaluateScan(qrPayload(t, b()), d).kind, "valid");
  t.status = "used";
  assert.equal(evaluateScan(qrPayload(t, b()), d).kind, "duplicate");
  const future = setup(addDays(TODAY, 3));
  assert.match(evaluateScan(qrPayload(future.b().tickets[0], future.b()), future.d).reason, /Wrong visit date/);
  const unpaid = setup(TODAY); unpaid.b().payment.status = "failed";
  assert.match(evaluateScan(qrPayload(unpaid.b().tickets[0], unpaid.b()), unpaid.d).reason, /Payment not completed/);
  const forged = qrPayload(t, b()).replace(/\|[^|]+$/, "|XXXX");
  assert.match(evaluateScan(forged, d).reason, /signature/);
});

test("activity log is bounded", () => {
  const d = seedDB();
  for (let i = 0; i < 2100; i++) logEvent(d, "test", "x", "", "System");
  assert.equal(d.auditLog!.length, 2000);
  assert.equal(d.notifications!.length, 500);
});
