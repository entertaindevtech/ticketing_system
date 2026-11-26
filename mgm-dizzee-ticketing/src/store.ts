// Shared types, the catalog seed (used by tests and the pricing-parity fixture), the price/offer engine used to
// preview prices while a cart is built, and display-only eligibility rules. The server (backend/) is the authority:
// it re-prices every booking, takes payment, issues tickets, validates scans and applies cancellations/changes.
export type TicketCat = {
  id: string; name: string; kind: "general" | "fasttrack"; audience: "adult" | "child";
  basePrice: number; description: string; eligibility: string; active: boolean; dailyLimit: number;
  // entitlements (optional so data saved before these existed still loads)
  validityNote?: string; reEntry?: boolean; restrictions?: string;
};
export type OfferType = "bxgy" | "percent" | "flat" | "package";
export type OfferStatus = "draft" | "scheduled" | "active" | "paused" | "expired";
export type Offer = {
  id: string; name: string; description: string; theme: string; type: OfferType;
  categories: string[]; bookingStart: string; bookingEnd: string; visitStart: string; visitEnd: string;
  weekdays: number[]; dates: string[]; minQty: number; value: number; buyX: number; getY: number;
  packagePrice: number; packageContents: Record<string, number>;
  maxRedemptions: number; redemptions: number; coupon: string; terms: string; priority: number;
  status: OfferStatus; featured: boolean; requiresId: string;
  image?: string; // server URL of the optional uploaded banner image (set only by the image upload API)
};
export type Addon = { id: string; name: string; description: string; price: number; icon: string; tag?: string };
export type DateCfg = { enabled?: boolean; blackout?: boolean; capacity?: number; priceAdj?: number; note?: string };
export type Ticket = { id: string; catId: string; label: string; status: "valid" | "used" | "cancelled"; scannedAt?: string | null; gate?: string | null; offerId?: string | null; complimentary?: boolean; qr?: string | null };
export type PayStatus = "paid" | "pending" | "failed" | "refunded";
export type Booking = {
  id: string; createdAt: string; visitDate: string;
  customer: { name: string; phone: string; email: string; visitors: number; notes: string };
  items: { label: string; qty: number; amount: number; kind: "ticket" | "offer" | "addon"; refId: string }[];
  offerIds: string[]; coupon: string;
  totals: { subtotal: number; discount: number; addons: number; tax: number; total: number; complimentary: number };
  payment: { txnId: string; method: string; status: PayStatus; gateway: string; at: string };
  status: "confirmed" | "cancelled"; tickets: Ticket[]; live?: boolean; refund?: Refund;
  counterSale?: boolean; modifiedAt?: string | null; modifications?: Modification[];
  // server state
  state?: "pending_payment" | "confirmed" | "cancelled" | "expired"; channel?: "web" | "counter"; origin?: string; holdExpiresAt?: string | null;
  refunds?: { id: number; amount: number; fee: number; status: string; reason: string | null; createdAt: string; processedAt: string | null; kind: string }[];
  differences?: { id: number; amount: number; status: string; method: string | null; at: string }[];
};
// status absent = legacy instant admin refund (always completed).
export type Refund = {
  amount: number; at: string; reason: string; status?: "pending" | "approved" | "rejected"; deduction?: number;
  requestedAt?: string; approvedAt?: string | null; rejectedAt?: string | null; rejectionReason?: string | null;
};
export type Modification = { at: string; by: string; previousVisitDate: string; visitDate: string; previousTotal: number; newTotal: number };
export type Notice = { id: string; type: string; message: string; ref: string; at: string; read: boolean };
export type AuditEntry = { id: string; type: string; message: string; ref: string; at: string; actor: string };
export type Scan = { id: string; at: string; ticketId: string; bookingId: string; gate: string; staffId: string; result: "valid" | "duplicate" | "invalid"; reason: string };
export type Staff = { id: string; name: string; gate: string; role: string; roles?: string[]; active: boolean; phone: string; lastLoginAt?: string | null };
export type Settings = { gst: number; openTime: string; closeTime: string; parkName: string; phone: string; email: string; defaultCapacity: number;
  saleStart?: string; saleEnd?: string; cancellationFeePct: number; cancelNoticeDays: number; holdMinutes?: number };
export type DB = {
  tickets: TicketCat[]; offers: Offer[]; addons: Addon[]; dateCfg: Record<string, DateCfg>;
  bookings: Booking[]; scans: Scan[]; staff: Staff[]; settings: Settings; version: number;
  notifications?: Notice[]; auditLog?: AuditEntry[];
};

// ---------- dates ----------
export let MIN_DATE = "2026-11-01";
export let MAX_DATE = "2026-12-31";
const pad = (n: number) => String(n).padStart(2, "0");
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseISO = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: string, n: number) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
export const dow = (s: string) => parseISO(s).getDay();
export const isWeekend = (s: string) => { const w = dow(s); return w === 0 || w === 6; };
// The park's "today" and sale window come from the server (GET /api/catalog), never from this device's clock.
export let TODAY = iso(new Date());
export function setToday(today: string, settings?: Partial<Settings>) {
  TODAY = today;
  if (settings?.saleStart) MIN_DATE = settings.saleStart;
  if (settings?.saleEnd) MAX_DATE = settings.saleEnd;
}
export const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const fmtDate = (s: string, o: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" }) =>
  s ? parseISO(s).toLocaleDateString("en-IN", o) : "";
export const fmtShort = (s: string) => fmtDate(s, { day: "numeric", month: "short" });
export const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
export const nowStamp = () => { const n = new Date(); return `${iso(n)}T${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`; };
export const fmtTime = (s: string) => new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export function datesBetween(a: string, b: string) { const out: string[] = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; }

// ---------- ids ----------
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const rid = (n: number, rnd: () => number = Math.random) => Array.from({ length: n }, () => ALPH[Math.floor(rnd() * ALPH.length)]).join("");
// ---------- seed ----------
const T = (id: string, name: string, kind: TicketCat["kind"], audience: TicketCat["audience"], basePrice: number, description: string, eligibility: string): TicketCat =>
  ({ id, name, kind, audience, basePrice, description, eligibility, active: true, dailyLimit: kind === "fasttrack" ? 400 : 3000,
    validityNote: "Valid on the selected visit date only", reEntry: false, restrictions: "" });

export const seedTickets = (): TicketCat[] => [
  T("ga", "General Adult", "general", "adult", 1099, "Full-day access to all dry & water rides, wave pool and live shows.", "Visitors above 140 cm height"),
  T("gc", "General Child", "general", "child", 899, "Full-day access to all age-appropriate rides, kids' zone and water play area.", "Height between 90 cm and 140 cm · below 90 cm enter free"),
  T("fa", "Fast Track Adult", "fasttrack", "adult", 1799, "Skip the regular queue once on every major ride, plus all General ticket benefits.", "Visitors above 140 cm height · limited daily quota"),
  T("fc", "Fast Track Child", "fasttrack", "child", 1499, "Priority queue access on kids' and family rides, plus all General ticket benefits.", "Height between 90 cm and 140 cm · limited daily quota"),
];

const O = (o: Partial<Offer> & Pick<Offer, "id" | "name" | "type">): Offer => ({
  description: "", theme: "sunset", categories: ["ga"], bookingStart: "2026-10-15", bookingEnd: "2026-12-31",
  visitStart: MIN_DATE, visitEnd: MAX_DATE, weekdays: [], dates: [], minQty: 1, value: 0, buyX: 0, getY: 0,
  packagePrice: 0, packageContents: {}, maxRedemptions: 1000, redemptions: 0, coupon: "", terms: "", priority: 5,
  status: "active", featured: false, requiresId: "", ...o,
});

export const seedOffers = (): Offer[] => [
  O({ id: "o-b4g2", name: "Buy 4 Get 2 Free", type: "bxgy", theme: "sunset", featured: true, priority: 1,
    description: "Bring the whole gang! Pay for 4 General Adult tickets and 2 more come free.",
    categories: ["ga"], buyX: 4, getY: 2, weekdays: [1, 2, 3, 4, 5], visitStart: "2026-11-20", visitEnd: "2026-12-19",
    maxRedemptions: 500, redemptions: 212, terms: "Valid Monday to Friday only.\nAll 6 visitors must enter together.\nNot combinable with coupon codes." }),
  O({ id: "o-student", name: "Student Offer", type: "percent", theme: "ocean", priority: 3, value: 25,
    description: "25% off General Adult tickets for college students with a valid ID.",
    categories: ["ga"], weekdays: [1, 2, 3, 4], visitEnd: "2026-12-18", requiresId: "Valid college student ID card",
    maxRedemptions: 1000, redemptions: 388, terms: "Student ID must be shown at the entry gate.\nValid Monday to Thursday.\nOne ticket per student ID." }),
  O({ id: "o-weekend", name: "Weekend Special", type: "flat", theme: "berry", priority: 2, value: 250, featured: true,
    description: "Flat ₹250 off every General Adult ticket on Saturdays and Sundays.",
    categories: ["ga"], weekdays: [0, 6], maxRedemptions: 800, redemptions: 431,
    terms: "Valid only on Saturdays and Sundays.\nMinimum 2 tickets per booking.", minQty: 2 }),
  O({ id: "o-family", name: "Family Package", type: "package", theme: "mint", priority: 2, featured: true,
    description: "2 Adults + 2 Children General tickets at one combined price.",
    categories: ["ga", "gc"], packageContents: { ga: 2, gc: 2 }, packagePrice: 3499, maxRedemptions: 600, redemptions: 274,
    terms: "Package includes exactly 2 adults and 2 children.\nChildren must be between 90 and 140 cm.\nNon-transferable." }),
  O({ id: "o-xmas", name: "Christmas Carnival Fast Track", type: "percent", theme: "festive", priority: 1, value: 20,
    description: "20% off Fast Track Adult tickets on carnival days.", categories: ["fa"],
    dates: ["2026-12-24", "2026-12-25", "2026-12-26", "2026-12-31"], visitStart: "2026-12-24", visitEnd: "2026-12-31",
    maxRedemptions: 300, redemptions: 41, terms: "Valid on 24, 25, 26 and 31 December only.\nSubject to daily Fast Track quota." }),
  O({ id: "c-mgm30", name: "MGM30 Coupon", type: "percent", theme: "night", coupon: "MGM30", value: 30, minQty: 2, priority: 4,
    description: "30% off eligible regular General tickets.", categories: ["ga", "gc"], maxRedemptions: 2000, redemptions: 963,
    terms: "Minimum 2 General tickets.\nNot valid on offer tickets or Fast Track.\nOne coupon per booking." }),
  O({ id: "c-fast150", name: "Fast Friday", type: "flat", theme: "ocean", coupon: "FASTFRI", value: 150, minQty: 1, priority: 5,
    description: "₹150 off every Fast Track ticket on Fridays.", categories: ["fa", "fc"], weekdays: [5], maxRedemptions: 400, redemptions: 88,
    terms: "Valid for Friday visits only." }),
  O({ id: "c-dizzee10", name: "DIZZEE10 Coupon", type: "percent", theme: "sunset", coupon: "DIZZEE10", value: 10, priority: 6,
    description: "10% off all regular tickets.", categories: ["ga", "gc", "fa", "fc"], status: "paused", maxRedemptions: 500, redemptions: 120,
    terms: "Paused by marketing team." }),
  O({ id: "o-nye", name: "New Year Countdown Night", type: "package", theme: "festive", status: "draft", priority: 1,
    description: "Fast Track Adult + dinner buffet for New Year's Eve.", categories: ["fa"], packageContents: { fa: 1 }, packagePrice: 2499,
    dates: ["2026-12-31"], visitStart: "2026-12-31", visitEnd: "2026-12-31", maxRedemptions: 200, terms: "Draft – pending approval." }),
];

export const seedAddons = (): Addon[] => [
  { id: "food", name: "Dizzee Meal Combo", description: "Veg/non-veg meal, dessert and a soft drink at any food court.", price: 349, icon: "food", tag: "Bestseller" },
  { id: "locker", name: "Locker Reservation", description: "Pre-booked medium locker near the water zone, valid all day.", price: 199, icon: "locker" },
  { id: "swim", name: "Swimwear Package", description: "Mandatory nylon swimwear for water rides – collect at counter.", price: 299, icon: "swim" },
  { id: "vr", name: "VR Coaster Experience", description: "Premium virtual-reality coaster session (1 ride).", price: 249, icon: "vr", tag: "Premium" },
  { id: "photo", name: "Digital Photo Pass", description: "Unlimited ride photos delivered to your phone.", price: 399, icon: "camera" },
  { id: "cabana", name: "Wave Pool Cabana", description: "Private shaded cabana for up to 6 guests with towels.", price: 1499, icon: "cabana", tag: "Premium" },
];

export const defaultSettings = (): Settings => ({ gst: 18, openTime: "10:30", closeTime: "18:30", parkName: "MGM Dizzee World", phone: "+91 44 2747 2434", email: "bookings@mgmdizzeeworld.com", defaultCapacity: 4000, cancellationFeePct: 25, cancelNoticeDays: 2 });

export const SEED_DATE_CFG = (): Record<string, DateCfg> => ({
  "2026-11-24": { enabled: false, note: "Annual ride maintenance" },
  "2026-12-03": { blackout: true, note: "Private corporate event" },
  "2026-12-25": { priceAdj: 25, note: "Christmas Day" },
  "2026-12-31": { priceAdj: 30, note: "New Year's Eve" },
});

// ---------- date & price engine ----------
export type Ctx = { tickets: TicketCat[]; offers: Offer[]; dateCfg: Record<string, DateCfg>; settings: Settings };

export function dateStatus(d: string, db: Pick<DB, "dateCfg">): { open: boolean; reason: string } {
  const c = db.dateCfg[d] || {};
  if (d < TODAY) return { open: false, reason: "Past date" };
  if (d < MIN_DATE || d > MAX_DATE) return { open: false, reason: "Not on sale" };
  if (c.enabled === false) return { open: false, reason: c.note || "Park closed" };
  if (c.blackout) return { open: false, reason: c.note || "Blackout date" };
  return { open: true, reason: "" };
}
export function priceAdj(d: string, ctx: Pick<Ctx, "dateCfg">) {
  const c = ctx.dateCfg[d];
  if (c && typeof c.priceAdj === "number") return c.priceAdj;
  if (d >= "2026-12-20") return 15; // holiday season
  if (isWeekend(d)) return 10;
  return 0;
}
export function tierOf(d: string, ctx: Pick<Ctx, "dateCfg">): "regular" | "weekend" | "peak" {
  const a = priceAdj(d, ctx);
  return a >= 15 ? "peak" : a > 0 ? "weekend" : "regular";
}
export const ticketPrice = (cat: TicketCat, d: string, ctx: Pick<Ctx, "dateCfg">) => Math.round((cat.basePrice * (100 + priceAdj(d, ctx))) / 100);

export function offerApplies(o: Offer, d: string, bookedOn = TODAY) {
  if (!(o.status === "active" || (o.status === "scheduled" && o.bookingStart <= bookedOn))) return false;
  if (bookedOn < o.bookingStart || bookedOn > o.bookingEnd) return false;
  if (d < o.visitStart || d > o.visitEnd) return false;
  if (o.weekdays.length && !o.weekdays.includes(dow(d))) return false;
  if (o.dates.length && !o.dates.includes(d)) return false;
  if (o.redemptions >= o.maxRedemptions) return false;
  return true;
}
export const eligibleOffers = (offers: Offer[], d: string, bookedOn = TODAY) =>
  offers.filter((o) => offerApplies(o, d, bookedOn)).sort((a, b) => a.priority - b.priority);

export function effectiveStatus(o: Offer): OfferStatus {
  if (o.status === "draft" || o.status === "paused") return o.status;
  if (o.visitEnd < TODAY || o.bookingEnd < TODAY) return "expired";
  if (o.bookingStart > TODAY) return "scheduled";
  return o.status === "scheduled" ? "active" : o.status;
}

export type OfferUnit = { original: number; price: number; tickets: { catId: string; qty: number; free?: number }[]; label: string; benefit: string };
export function offerUnit(o: Offer, d: string, ctx: Ctx): OfferUnit | null {
  const cat = (id: string) => ctx.tickets.find((t) => t.id === id);
  if (o.type === "package") {
    let orig = 0; const ts: OfferUnit["tickets"] = [];
    for (const [id, q] of Object.entries(o.packageContents)) { const c = cat(id); if (!c || !q) continue; orig += ticketPrice(c, d, ctx) * q; ts.push({ catId: id, qty: q }); }
    if (!ts.length) return null;
    return { original: orig, price: o.packagePrice, tickets: ts, label: ts.map((t) => `${t.qty}× ${cat(t.catId)?.name}`).join(" + "), benefit: `Save ${inr(orig - o.packagePrice)}` };
  }
  const c = cat(o.categories[0]); if (!c) return null;
  const p = ticketPrice(c, d, ctx);
  if (o.type === "bxgy") return { original: p * (o.buyX + o.getY), price: p * o.buyX, tickets: [{ catId: c.id, qty: o.buyX + o.getY, free: o.getY }], label: `${o.buyX + o.getY}× ${c.name} (${o.getY} free)`, benefit: `${o.getY} tickets free` };
  if (o.type === "percent") return { original: p, price: Math.round(p * (1 - o.value / 100)), tickets: [{ catId: c.id, qty: 1 }], label: `1× ${c.name}`, benefit: `${o.value}% off` };
  return { original: p, price: Math.max(0, p - o.value), tickets: [{ catId: c.id, qty: 1 }], label: `1× ${c.name}`, benefit: `${inr(o.value)} off` };
}

export type Cart = { tickets: Record<string, number>; offers: Record<string, number>; addons: Record<string, number>; coupon: string };
export const emptyCart = (): Cart => ({ tickets: {}, offers: {}, addons: {}, coupon: "" });

export type Line = { kind: "ticket" | "offer" | "addon"; refId: string; label: string; detail: string; qty: number; unit: number; original: number; amount: number };
export type Priced = {
  lines: Line[]; ticketGross: number; offerSavings: number; couponDiscount: number; couponOffer?: Offer; couponError: string;
  addonsTotal: number; subtotal: number; taxable: number; tax: number; total: number; complimentary: number; ticketCount: number; issues: string[];
};

export function validateCoupon(code: string, cart: Cart, d: string, ctx: Ctx, bookedOn = TODAY): { offer?: Offer; error: string } {
  if (!code) return { error: "" };
  const o = ctx.offers.find((x) => x.coupon && x.coupon.toUpperCase() === code.trim().toUpperCase());
  if (!o) return { error: "This coupon code is not valid." };
  if (o.status === "paused" || o.status === "draft") return { error: "This coupon is currently not active." };
  if (!offerApplies(o, d, bookedOn)) return { error: `${o.coupon} is not valid for ${fmtShort(d)}.` };
  const eligibleQty = o.categories.reduce((s, id) => s + (cart.tickets[id] || 0), 0);
  if (eligibleQty === 0) return { error: `Add ${o.categories.map((id) => ctx.tickets.find((t) => t.id === id)?.name).join(" / ")} tickets to use ${o.coupon}.` };
  if (eligibleQty < o.minQty) return { error: `${o.coupon} needs at least ${o.minQty} eligible tickets.` };
  if (Object.values(cart.offers).some((q) => q > 0) && o.categories.length) {
    const blocking = Object.entries(cart.offers).filter(([, q]) => q > 0).map(([id]) => ctx.offers.find((x) => x.id === id)).find((x) => x && x.type === "bxgy");
    if (blocking) return { error: `${o.coupon} can't be combined with ${blocking.name}.` };
  }
  return { offer: o, error: "" };
}

export function priceCart(cart: Cart, d: string, ctx: Ctx, bookedOn = TODAY, addons: Addon[] = seedAddons()): Priced {
  const lines: Line[] = []; const issues: string[] = [];
  let ticketCount = 0, complimentary = 0, offerSavings = 0;
  for (const c of ctx.tickets) {
    const q = cart.tickets[c.id] || 0; if (!q || !c.active) continue;
    const u = ticketPrice(c, d, ctx);
    lines.push({ kind: "ticket", refId: c.id, label: c.name, detail: c.kind === "fasttrack" ? "Fast Track" : "General", qty: q, unit: u, original: u * q, amount: u * q });
    ticketCount += q;
  }
  for (const [id, q] of Object.entries(cart.offers)) {
    if (!q) continue;
    const o = ctx.offers.find((x) => x.id === id); if (!o) continue;
    if (!offerApplies(o, d, bookedOn)) { issues.push(`${o.name} is not available on ${fmtShort(d)}`); continue; }
    const u = offerUnit(o, d, ctx); if (!u) continue;
    if ((o.type === "percent" || o.type === "flat") && q < o.minQty) issues.push(`${o.name} needs minimum ${o.minQty} tickets`);
    lines.push({ kind: "offer", refId: o.id, label: o.name, detail: u.label, qty: q, unit: u.price, original: u.original * q, amount: u.price * q });
    offerSavings += (u.original - u.price) * q;
    u.tickets.forEach((t) => { ticketCount += t.qty * q; complimentary += (t.free || 0) * q; });
  }
  let addonsTotal = 0;
  for (const a of addons) {
    const q = cart.addons[a.id] || 0; if (!q) continue;
    lines.push({ kind: "addon", refId: a.id, label: a.name, detail: "Add-on", qty: q, unit: a.price, original: a.price * q, amount: a.price * q });
    addonsTotal += a.price * q;
  }
  const { offer: couponOffer, error: couponError } = validateCoupon(cart.coupon, cart, d, ctx, bookedOn);
  let couponDiscount = 0;
  if (couponOffer) {
    for (const l of lines) if (l.kind === "ticket" && couponOffer.categories.includes(l.refId)) {
      couponDiscount += couponOffer.type === "percent" ? Math.round((l.amount * couponOffer.value) / 100) : Math.min(l.unit, couponOffer.value) * l.qty;
    }
  }
  const ticketGross = lines.filter((l) => l.kind !== "addon").reduce((s, l) => s + l.original, 0);
  const subtotal = ticketGross + addonsTotal;
  const taxable = subtotal - offerSavings - couponDiscount;
  const tax = Math.round((taxable * ctx.settings.gst) / 100);
  return { lines, ticketGross, offerSavings, couponDiscount, couponOffer, couponError, addonsTotal, subtotal, taxable, tax, total: taxable + tax, complimentary, ticketCount, issues };
}

// ---------- cancellation & modification eligibility (display only; the server enforces the same rules) ----------
export const isRefunded = (b: Booking) => !!b.refund && (!b.refund.status || b.refund.status === "approved");

export function cancellationEligibility(b: Booking, s: Pick<Settings, "cancelNoticeDays">, today = TODAY): { ok: boolean; reason: string } {
  if (b.status === "cancelled") return { ok: false, reason: "This booking is already cancelled." };
  if (b.refund?.status === "pending") return { ok: false, reason: "A cancellation request is already pending review." };
  if (b.refund) return { ok: false, reason: "This booking's cancellation has already been reviewed." };
  if (b.payment.status !== "paid") return { ok: false, reason: "Only paid bookings can be cancelled." };
  if (b.offerIds.length) return { ok: false, reason: "This booking used an offer and is not eligible for cancellation." };
  if (b.tickets.some((t) => t.status === "used")) return { ok: false, reason: "Tickets from this booking have already been used." };
  if (b.visitDate < addDays(today, s.cancelNoticeDays)) return { ok: false, reason: `Less than ${s.cancelNoticeDays * 24} hours remain before the visit — not eligible for cancellation.` };
  return { ok: true, reason: "" };
}
export const cancellationFee = (b: Booking, s: Pick<Settings, "cancellationFeePct">) => Math.round((b.totals.total * s.cancellationFeePct) / 100);

// ---------- booking modification ----------
export function modificationEligibility(b: Booking, d: Pick<DB, "dateCfg">): { ok: boolean; reason: string } {
  if (b.status === "cancelled") return { ok: false, reason: "Cancelled bookings can't be modified." };
  if (b.payment.status !== "paid") return { ok: false, reason: "Only paid bookings can be modified." };
  if (b.refund?.status === "pending") return { ok: false, reason: "Resolve the pending cancellation request first." };
  if (b.offerIds.length || b.coupon) return { ok: false, reason: "Bookings with offers or coupons can't be modified — offer pricing is tied to the original date." };
  if (b.tickets.some((t) => t.status === "used")) return { ok: false, reason: "Tickets have already been used at the gate." };
  if (b.visitDate < TODAY) return { ok: false, reason: "The visit date has passed." };
  return { ok: true, reason: "" };
}
