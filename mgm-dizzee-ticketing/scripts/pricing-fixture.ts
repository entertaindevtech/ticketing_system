// Pricing parity fixture: runs the TypeScript engine (src/store.ts priceCart) over a deterministic set of carts and
// writes inputs + results to backend/tests/fixtures/pricing_parity.json. backend/tests/test_pricing_parity.py
// replays them through the Python engine (backend/app/pricing.py); tests/pricing-fixture.test.ts fails if this
// file's output and the committed fixture differ. Regenerate after changing either engine:
//   node scripts/pricing-fixture.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addDays, datesBetween, defaultSettings, priceCart, seedAddons, seedDB, seedOffers, seedTickets, type Cart, type Ctx } from "../src/store.ts";

export const FIXTURE = fileURLToPath(new URL("../backend/tests/fixtures/pricing_parity.json", import.meta.url));

function mulberry(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function buildFixture() {
  const rnd = mulberry(4242);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const offers = seedOffers().map((o) => (o.id === "o-xmas" ? { ...o, redemptions: o.maxRedemptions } : o)); // one exhausted offer
  offers.push({ ...offers[0], id: "o-scheduled", status: "scheduled", bookingStart: "2026-11-22" });
  const ctx: Ctx & { addons: ReturnType<typeof seedAddons> } = {
    tickets: seedTickets().map((t) => (t.id === "fc" ? { ...t, basePrice: 1499.5 } : t)), // a half-rupee base exercises rounding
    offers, dateCfg: { ...seedDB().dateCfg, "2026-12-10": { priceAdj: 7 }, "2026-12-11": { priceAdj: 0 } }, settings: defaultSettings(), addons: seedAddons(),
  };
  const dates = datesBetween("2026-11-15", "2026-12-31");
  const coupons = ["", "", "", "MGM30", "mgm30 ", "FASTFRI", "DIZZEE10", "NOPE"];
  const cases = [];
  for (let i = 0; i < 400; i++) {
    const date = pick(dates);
    const bookedOn = addDays(date, -Math.floor(rnd() * 20));
    const cart: Cart = { tickets: {}, offers: {}, addons: {}, coupon: pick(coupons) };
    for (const t of ctx.tickets) if (rnd() < 0.45) cart.tickets[t.id] = 1 + Math.floor(rnd() * 4);
    for (const o of ctx.offers) if (rnd() < 0.12) cart.offers[o.id] = 1 + Math.floor(rnd() * 3);
    for (const a of ctx.addons) if (rnd() < 0.25) cart.addons[a.id] = 1 + Math.floor(rnd() * 3);
    const p = priceCart(cart, date, ctx, bookedOn, ctx.addons);
    cases.push({
      date, bookedOn, cart,
      expected: {
        lines: p.lines, offerSavings: p.offerSavings, couponDiscount: p.couponDiscount, couponOfferId: p.couponOffer?.id ?? null,
        couponError: !!p.couponError, addonsTotal: p.addonsTotal, subtotal: p.subtotal, taxable: p.taxable, tax: p.tax, total: p.total,
        complimentary: p.complimentary, ticketCount: p.ticketCount, issues: p.issues.length,
      },
    });
  }
  return { ctx, cases };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(FIXTURE, JSON.stringify(buildFixture(), null, 1) + "\n");
  console.log("wrote", FIXTURE);
}
