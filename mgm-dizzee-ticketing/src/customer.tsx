import React, { useEffect, useMemo, useState } from "react";
import {
  Booking, Cart, Ctx, MAX_DATE, MIN_DATE, MONTHS, Offer, Priced, TODAY, WD, addDays, dateStatus, dow, eligibleOffers,
  emptyCart, fmtDate, fmtShort, inr, offerUnit, parseISO, priceAdj, priceCart, ticketPrice, tierOf, datesBetween,
  cancellationEligibility, cancellationFee,
} from "./store";
import { type Access, ApiError, api, bookingHeaders, idemKey, legacyBookings, myBookings, parseAccessLink, rememberBooking } from "./api";
import { visitorToken } from "./referral";
import mascotUrl from "./assets/mascot.png";
import { Reveal } from "./ui";
import { Badge, Button, Field, Icon, Logo, Modal, OfferArt, QR, Qty, TicketArt, copyText, inputCls, useStore } from "./ui";

type Step = "home" | "date" | "tickets" | "addons" | "details" | "payment" | "done" | "mybookings";
const STEPS: { key: Step; label: string }[] = [
  { key: "date", label: "Visit Date" }, { key: "tickets", label: "Select Tickets" }, { key: "addons", label: "Add-ons" },
  { key: "details", label: "Customer Details" }, { key: "payment", label: "Payment" },
];

/** Live preview from the local engine, replaced by the server's quote (authoritative, validates coupons) as soon
 * as it arrives for the current cart. */
export function useServerQuote(cart: Cart, date: string, local: Priced | null): Priced | null {
  const [server, setServer] = useState<{ key: string; priced: Priced } | null>(null);
  const key = JSON.stringify([date, cart]);
  useEffect(() => {
    if (!date) return;
    let live = true;
    const t = setTimeout(() => {
      api<Priced>("/api/quote", { method: "POST", body: { visit_date: date, cart } }).then((p) => { if (live) setServer({ key, priced: p }); }).catch(() => undefined);
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return server?.key === key ? server.priced : local;
}

export function useCtx(): Ctx { const { db } = useStore(); return { tickets: db.tickets, offers: db.offers, dateCfg: db.dateCfg, settings: db.settings }; }

export default function CustomerApp() {
  const { db } = useStore();
  const ctx = useCtx();
  const [step, setStep] = useState<Step>(() => (parseAccessLink(decodeURIComponent(location.hash)) ? "mybookings" : "home"));
  const [date, setDate] = useState<string>("");
  const [cart, setCart] = useState<Cart>(emptyCart());
  const [customer, setCustomer] = useState({ name: "", phone: "", email: "", visitors: 0, notes: "" });
  const [booking, setBooking] = useState<{ booking: Booking; access: Access } | null>(null);
  const local = useMemo(() => (date ? priceCart(cart, date, ctx, TODAY, db.addons) : null), [cart, date, ctx, db.addons]);
  const priced = useServerQuote(cart, date, local);
  // #booking/<ref>/<token>: a customer's booking link
  const [link] = useState(() => parseAccessLink(decodeURIComponent(location.hash)));

  // when date changes, drop offers not valid on the new date
  const changeDate = (d: string) => {
    setDate(d);
    setCart((c) => {
      const offers: Record<string, number> = {};
      const ok = new Set(eligibleOffers(ctx.offers, d).map((o) => o.id));
      Object.entries(c.offers).forEach(([id, q]) => { if (ok.has(id)) offers[id] = q; });
      return { ...c, offers };
    });
  };
  const ORDER: Step[] = ["home", "mybookings", "date", "tickets", "addons", "details", "payment", "done"];
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const go = (s: Step) => { setDir(ORDER.indexOf(s) >= ORDER.indexOf(step) ? "fwd" : "back"); setStep(s); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const restart = () => { setCart(emptyCart()); setDate(""); setBooking(null); setCustomer({ name: "", phone: "", email: "", visitors: 0, notes: "" }); go("home"); };

  return (
    <div className="min-h-screen bg-slate-50">
      <p className="bg-navy-950 px-4 py-1.5 text-center text-[11px] text-white/60"><Icon name="shield" size={12} className="inline -mt-0.5 mr-1 text-mgm-yellow" />Payments are simulated · no real money is taken</p>
      <SiteHeader onBook={() => go(date ? "tickets" : "date")} onHome={() => go("home")} inFlow={step !== "home"} />
      {step === "home" && <Landing onBook={() => go("date")} />}
      {step === "home" && <div className="fixed bottom-5 right-5 z-50"><Button variant="dark" icon="search" onClick={() => go("mybookings")}>My Bookings</Button></div>}
      {step !== "home" && step !== "done" && step !== "mybookings" && <Stepper step={step} onJump={(s) => go(s)} canJump={(s) => (s === "date" ? true : !!date && (s === "tickets" || (priced?.ticketCount || 0) > 0))} />}
      <main key={step} className={step === "home" ? "" : `mx-auto max-w-7xl px-4 sm:px-6 pb-32 pt-4 ${dir === "fwd" ? "step-fwd" : "step-back"}`}>
        {step === "date" && <DateStep date={date} onPick={changeDate} onNext={() => go("tickets")} />}
        {step === "tickets" && date && priced && <TicketsStep date={date} setDate={changeDate} cart={cart} setCart={setCart} priced={priced} onBack={() => go("date")} onNext={() => go("addons")} />}
        {step === "addons" && date && priced && <AddonsStep cart={cart} setCart={setCart} priced={priced} date={date} onBack={() => go("tickets")} onNext={() => go("details")} />}
        {step === "details" && date && priced && <DetailsStep date={date} priced={priced} customer={customer} setCustomer={setCustomer} onBack={() => go("addons")} onNext={() => go("payment")} />}
        {step === "payment" && date && priced && <PaymentStep date={date} priced={priced} cart={cart} customer={customer} onBack={() => go("details")} onPaid={(b, a) => { setBooking({ booking: b, access: a }); go("done"); }} />}
        {step === "done" && booking && <Confirmation booking={booking.booking} access={booking.access} onHome={restart} />}
        {step === "mybookings" && <MyBookings onHome={() => { if (link) history.replaceState(null, "", location.pathname); go("home"); }} open={link} />}
      </main>
      {(step === "home" || step === "done") && <SiteFooter />}
    </div>
  );
}

function SiteHeader({ onBook, onHome, inFlow }: { onBook: () => void; onHome: () => void; inFlow: boolean }) {
  return (
    <header className="sticky top-0 z-40 glass-dark border-b border-white/5">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 h-20 flex items-center justify-between gap-4">
        <button onClick={onHome} aria-label="MGM Dizzee World home" className="shrink-0"><Logo size={70} /></button>
        <nav className="hidden md:flex items-center gap-1 rounded-full bg-white/5 p-1 ring-1 ring-white/10 font-display text-[15px] font-semibold text-white/85">
          {["Tickets", "Offers", "Plan Your Visit", "Contact"].map((n) => (
            <button key={n} onClick={() => { onHome(); setTimeout(() => document.getElementById(n === "Offers" ? "offers" : n === "Tickets" ? "tickets" : n === "Contact" ? "contact" : "visit")?.scrollIntoView({ behavior: "smooth" }), 60); }} className="rounded-full px-4 py-2 hover:bg-white/10 hover:text-white transition">{n}</button>
          ))}
        </nav>
        {!inFlow ? <Button onClick={onBook} className="slant font-display !text-[15px]" iconRight="arrow">Book now</Button> : <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-white/80"><Icon name="lock" size={14} /> Secure booking</div>}
      </div>
    </header>
  );
}

function Stepper({ step, onJump, canJump }: { step: Step; onJump: (s: Step) => void; canJump: (s: Step) => boolean }) {
  const idx = STEPS.findIndex((s) => s.key === step);
  const pos = (i: number) => `${10 + i * 20}%`;
  return (
    <div className="bg-white border-b border-slate-200">
      <div className="mx-auto max-w-3xl px-2 sm:px-6 pt-3 pb-3">
        <div className="relative h-[70px]">
          {/* track */}
          <div className="absolute left-[10%] right-[10%] bottom-[11px] h-1.5 rounded-full bg-mgm-yellow" />
          <div className="absolute left-[10%] bottom-[11px] h-1.5 rounded-full bg-navy-950 transition-all duration-700 ease-out" style={{ width: `${idx * 20}%` }} />
          {/* numbered stops */}
          {STEPS.map((s, i) => {
            const done = i < idx, cur = i === idx;
            return (
              <button key={s.key} disabled={!done || !canJump(s.key)} onClick={() => onJump(s.key)} aria-label={`Step ${i + 1}: ${s.label}`}
                className={`absolute bottom-0 -translate-x-1/2 grid h-7 w-7 place-items-center rounded-full text-xs font-bold transition ${done ? "bg-navy-950 text-white hover:scale-110" : cur ? "bg-mgm-yellow text-navy-950 ring-4 ring-mgm-yellow/35" : "bg-white text-slate-500 border-2 border-mgm-yellow"}`}
                style={{ left: pos(i) }}>
                {done ? <Icon name="check" size={13} strokeWidth={3} /> : i + 1}
              </button>
            );
          })}
          {/* mascot rides to the current step */}
          <div className="absolute bottom-[26px] -translate-x-1/2 transition-[left] duration-700 ease-out pointer-events-none" style={{ left: pos(idx) }}>
            <img key={idx} src={mascotUrl} alt="" className="hop h-10 w-auto drop-shadow-md" draggable={false} />
          </div>
        </div>
        <div className="grid grid-cols-5 mt-1.5 text-center">
          {STEPS.map((s, i) => (
            <button key={s.key} disabled={!(i < idx) || !canJump(s.key)} onClick={() => onJump(s.key)}
              className={`px-0.5 leading-tight transition ${i === idx ? "font-display text-sm sm:text-lg font-bold text-navy-950 sm:whitespace-nowrap" : i < idx ? "text-[11px] sm:text-sm font-semibold text-navy-900 hover:text-mgm-red" : "text-[11px] sm:text-sm text-slate-500"}`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------- Landing ----------------
function HeroArt() {
  return (
    <svg viewBox="0 0 600 420" className="w-full h-full" aria-hidden="true">
      {Array.from({ length: 30 }).map((_, i) => <circle key={i} cx={(i * 97) % 600} cy={(i * 53) % 220} r={i % 3 ? 1.2 : 2} fill="#fff" opacity={0.3 + (i % 4) * 0.15} className={i % 5 === 0 ? "twinkle" : ""} />)}
      {/* ferris wheel */}
      <g transform="translate(410 190)">
        <line x1="-60" y1="190" x2="0" y2="0" stroke="#F6CD45" strokeWidth="6" /><line x1="60" y1="190" x2="0" y2="0" stroke="#F6CD45" strokeWidth="6" />
        <g className="spin-slow">
          <circle r="130" fill="none" stroke="#F6CD45" strokeWidth="5" /><circle r="118" fill="none" stroke="#F6CD45" strokeOpacity=".4" strokeWidth="2" />
          {Array.from({ length: 12 }).map((_, i) => { const a = (i * Math.PI) / 6; return <line key={i} x1="0" y1="0" x2={130 * Math.cos(a)} y2={130 * Math.sin(a)} stroke="#F6CD45" strokeOpacity=".7" strokeWidth="2" />; })}
          {Array.from({ length: 12 }).map((_, i) => { const a = (i * Math.PI) / 6; return <g key={i} transform={`translate(${130 * Math.cos(a)} ${130 * Math.sin(a)})`}><rect x="-11" y="-2" width="22" height="18" rx="6" fill={["#CE3B37", "#0EA5E9", "#10B981", "#F97316"][i % 4]} className="counter-spin" /></g>; })}
        </g>
        <circle r="12" fill="#CE3B37" stroke="#F6CD45" strokeWidth="4" />
      </g>
      {/* coaster */}
      <path d="M-10 330 C 60 330 70 170 140 170 C 210 170 190 300 250 300 C 300 300 300 220 340 230" fill="none" stroke="#CE3B37" strokeWidth="7" strokeLinecap="round" />
      <path d="M-10 342 C 60 342 70 182 140 182 C 210 182 190 312 250 312 C 300 312 300 232 340 242" fill="none" stroke="#CE3B37" strokeOpacity=".5" strokeWidth="3" />
      {[40, 80, 120, 160, 200, 240, 290].map((x, i) => <line key={i} x1={x} y1={[330, 260, 176, 190, 260, 304, 250][i]} x2={x} y2="420" stroke="#CE3B37" strokeOpacity=".45" strokeWidth="3" />)}
      <g className="coaster-car"><rect x="-16" y="-12" width="32" height="14" rx="5" fill="#F6CD45" /><circle cx="-9" cy="3" r="4" fill="#111111" /><circle cx="9" cy="3" r="4" fill="#111111" /></g>
    </svg>
  );
}

function Landing({ onBook }: { onBook: () => void }) {
  const { db } = useStore(); const ctx = useCtx();
  const promoOffers = db.offers.filter((o) => !o.coupon && (o.status === "active" || o.status === "scheduled") && o.visitEnd >= TODAY).sort((a, b) => a.priority - b.priority).slice(0, 4);
  const ga = db.tickets.find((t) => t.id === "ga"), fa = db.tickets.find((t) => t.id === "fa");
  return (
    <>
      <section className="relative overflow-hidden hero-mesh text-white">
        <div className="absolute inset-0 opacity-90"><div className="absolute right-0 top-0 h-full w-full lg:w-[62%]"><HeroArt /></div></div>
        <div className="absolute inset-0 bg-gradient-to-r from-[#1C1B19] via-[#1C1B19]/70 to-transparent" />
        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-24 lg:py-28 hero-in">
          <span className="mb-6 inline-flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-white/90 ring-1 ring-white/15 backdrop-blur"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />Official online ticket booking</span>
          <h1 className="font-display text-[40px] sm:text-7xl font-bold leading-[1.02] tracking-tight max-w-2xl">Thrills, splashes &amp; <span className="text-gradient">family fun</span> on the ECR.</h1>
          <p className="mt-5 max-w-xl text-base sm:text-lg text-white/75">Book General, Fast Track and exclusive offer tickets in one place. Pick your date, see the offers for that day, and get instant QR e-tickets.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="lg" onClick={onBook} className="slant btn-shine font-display !text-base" iconRight="arrow">Book tickets</Button>
            <Button size="lg" variant="outline" className="!bg-white/5 !text-white !border-white/20 hover:!bg-white/15 backdrop-blur" onClick={() => document.getElementById("offers")?.scrollIntoView({ behavior: "smooth" })} icon="tag">View Offers</Button>
          </div>
          <div className="mt-10 grid grid-cols-3 gap-3 max-w-lg">
            {[["50+", "Rides & attractions"], [`${db.settings.openTime}`, "Gates open daily"], ["Fast Track", "Skip-the-queue passes"]].map(([a, b]) => (
              <div key={b} className="rounded-2xl bg-white/[.06] ring-1 ring-white/10 backdrop-blur-md px-4 py-3.5"><div className="font-display text-lg sm:text-2xl font-bold text-mgm-yellow leading-tight">{a}</div><div className="text-[11px] sm:text-xs text-white/75">{b}</div></div>
            ))}
          </div>
        </div>
      </section>

      {/* quick booking bar */}
      <section className="relative z-10 -mt-8 mx-auto max-w-5xl px-4">
        <div className="card p-4 sm:p-5 flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
          <div className="flex items-center gap-3 flex-1"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-mgm-yellow/20 text-navy-950"><Icon name="calendar" /></span><div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Plan your visit</div><div className="font-display font-bold text-navy-950">Tickets open for Nov &amp; Dec 2026</div></div></div>
          <div className="flex items-center gap-3 flex-1"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-red-50 text-mgm-red"><Icon name="ticket" /></span><div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Starting from</div><div className="font-display font-bold text-navy-950">{inr(db.tickets.find((t) => t.id === "gc")?.basePrice || 0)} <span className="text-xs font-medium text-slate-500">+ GST</span></div></div></div>
          <Button size="lg" onClick={onBook} className="slant font-display !text-base" iconRight="arrow">Select date</Button>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pt-12">
        <Reveal className="grid sm:grid-cols-3 gap-4">
          {[["calendar", "Choose your date", "See live prices and the offers available on that day."], ["ticket", "Pick tickets & offers", "General, Fast Track or a money-saving offer pack."], ["qr", "Pay & get QR e-tickets", "Instant tickets on your phone – scan at the gate."]].map(([i, t, d], n) => (
            <div key={t} className="flex gap-4 items-start">
              <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-navy-950 text-mgm-yellow"><Icon name={i} size={20} /><span className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-mgm-red text-[10px] font-bold text-white">{n + 1}</span></span>
              <div><div className="font-display text-lg font-bold text-navy-950 leading-tight">{t}</div><div className="text-sm text-slate-600">{d}</div></div>
            </div>
          ))}
        </Reveal>
      </section>

      <section id="offers" className="relative pt-16 pb-14 mt-6 bg-[linear-gradient(#F8F7F3_0_45%,#F6CD45_45%_100%)]"><div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionTitle kicker="Current offers & promotions" title="Save more on your next visit" sub="Offers are date-specific — pick your visit date to see which ones apply." />
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {promoOffers.map((o, oi) => {
            const sample = datesBetween(TODAY > o.visitStart ? TODAY : o.visitStart, o.visitEnd).find((d) => eligibleOffers([o], d).length) || o.visitStart;
            const u = offerUnit(o, sample, ctx);
            return (
              <Reveal key={o.id} delay={oi * 90}><article className="group card overflow-hidden lift h-full">
                <div className="relative"><OfferArt theme={o.theme} type={o.type} image={o.image} className="h-32" />{o.featured && <Badge tone="yellow" className="absolute right-3 top-3"><Icon name="star" size={11} /> Popular</Badge>}
                  <div className="absolute right-3 bottom-3 rounded-xl bg-white px-2.5 py-1 font-display text-sm font-bold text-navy-950">{u?.benefit}</div></div>
                <div className="p-5">
                  <h3 className="font-display text-lg font-bold text-navy-950">{o.name}</h3>
                  <p className="mt-1 text-sm text-slate-600 line-clamp-2">{o.description}</p>
                  <div className="mt-3 text-xs font-medium text-slate-500 flex items-center gap-1.5"><Icon name="calendar" size={13} />{validityText(o)}</div>
                  <button onClick={onBook} className="mt-4 link-ul text-navy-950 hover:text-mgm-red transition">Check dates</button>
                </div>
              </article></Reveal>
            );
          })}
        </div>
      </div></section>

      <section id="tickets" className="mx-auto max-w-7xl px-4 sm:px-6 pt-16">
        <SectionTitle kicker="Ticket types" title="Choose how you want to play" />
        <Reveal className="grid md:grid-cols-2 gap-5">
          <div className="card p-6 sm:p-8 lift">
            <div className="flex items-start justify-between gap-4"><div><Badge tone="navy">General</Badge><h3 className="mt-3 font-display text-2xl font-bold text-navy-950">General Entry</h3></div><div className="text-right"><div className="text-xs text-slate-500">Adult from</div><div className="font-display text-2xl font-bold text-navy-950">{inr(ga?.basePrice || 0)}</div></div></div>
            <ul className="mt-5 space-y-2.5 text-sm text-slate-700">{["Unlimited access to 50+ dry and water rides", "Wave pool, lazy river and rain dance", "Live shows and kids' zone", "Child ticket for 90–140 cm height; below 90 cm free"].map((t) => <li key={t} className="flex gap-2"><Icon name="checkCircle" size={18} className="text-emerald-600" />{t}</li>)}</ul>
          </div>
          <div className="rounded-2xl hero-mesh text-white p-6 sm:p-8 relative overflow-hidden">
            <div className="relative flex items-start justify-between gap-4"><div><Badge tone="yellow"><Icon name="zap" size={11} /> Fast Track</Badge><h3 className="mt-3 font-display text-2xl font-bold">Skip the Queue</h3></div><div className="text-right"><div className="text-xs text-white/80">Adult from</div><div className="font-display text-2xl font-bold text-mgm-yellow">{inr(fa?.basePrice || 0)}</div></div></div>
            <ul className="relative mt-5 space-y-2.5 text-sm text-white/85">{["Everything in General Entry", "One priority entry on every major ride", "Dedicated Fast Track lane at the main gate", "Limited daily quota – book early"].map((t) => <li key={t} className="flex gap-2"><Icon name="zap" size={18} className="text-mgm-yellow" />{t}</li>)}</ul>
          </div>
        </Reveal>
      </section>

      <section id="visit" className="mx-auto max-w-7xl px-4 sm:px-6 pt-16 pb-20">
        <SectionTitle kicker="Plan your visit" title="Good to know before you go" />
        <Reveal className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 stagger">
          <InfoCard icon="clock" title="Park timings" lines={[`Mon – Fri: ${db.settings.openTime} AM – 6:30 PM`, `Sat, Sun & holidays: 10:00 AM – 7:00 PM`, "Ticket counters close 1 hr before"]} />
          <InfoCard icon="swim" title="Water rides" lines={["Nylon swimwear is mandatory", "Swimwear available at counter", "Lockers & changing rooms on site"]} />
          <InfoCard icon="shield" title="Safety" lines={["Height rules apply on every ride", "Outside food not permitted", "Follow ride operator instructions"]} />
          <InfoCard icon="pin" title="Getting here" lines={["ECR, Muttukadu, Chennai 603112", "Free parking for cars & two-wheelers", "Shuttle from Thiruvanmiyur on weekends"]} />
        </Reveal>
      </section>
    </>
  );
}
const SectionTitle = ({ kicker, title, sub }: { kicker: string; title: string; sub?: string }) => (
  <div className="mb-10 text-center"><span className="inline-flex items-center gap-2 rounded-full bg-mgm-red/10 px-3 py-1 text-xs font-semibold text-mgm-red"><span className="h-1.5 w-1.5 rounded-full bg-mgm-red" />{kicker}</span><h2 className="mt-3 font-display text-3xl sm:text-5xl font-bold tracking-tight text-navy-950">{title}</h2>{sub && <p className="mt-3 text-slate-500">{sub}</p>}</div>
);
const InfoCard = ({ icon, title, lines }: { icon: string; title: string; lines: string[] }) => (
  <div className="card p-6 lift"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-mgm-yellow/25 text-navy-950"><Icon name={icon} /></span><h3 className="mt-4 font-display text-lg font-bold text-navy-950">{title}</h3><ul className="mt-2 space-y-1.5 text-sm text-slate-600">{lines.map((l) => <li key={l}>{l}</li>)}</ul></div>
);
export function validityText(o: Offer) {
  if (o.dates.length) return o.dates.map((d) => fmtShort(d)).join(", ");
  const wd = o.weekdays.length ? (o.weekdays.length === 2 && o.weekdays.includes(0) && o.weekdays.includes(6) ? "Weekends" : o.weekdays.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((w) => WD[w]).join(", ")) : "All days";
  return `${wd} · ${fmtShort(o.visitStart)} – ${fmtShort(o.visitEnd)}`;
}

function SiteFooter() {
  const { db } = useStore();
  return (
    <footer id="contact" className="hero-mesh text-white/80 border-t-[6px] border-mgm-yellow">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-12 grid sm:grid-cols-2 lg:grid-cols-4 gap-8 text-sm">
        <div><Logo size={96} /><p className="mt-4 text-white/80">Chennai's favourite amusement and water park on the East Coast Road.</p></div>
        <div><h4 className="font-semibold text-white mb-3">Contact</h4><p className="flex gap-2"><Icon name="phone" size={16} />{db.settings.phone}</p><p className="flex gap-2 mt-2"><Icon name="mail" size={16} />{db.settings.email}</p><p className="flex gap-2 mt-2"><Icon name="pin" size={16} />ECR, Muttukadu, Chennai</p></div>
        <div><h4 className="font-semibold text-white mb-3">Policies</h4>{["Terms & Conditions", "Cancellation & Refund Policy", "Privacy Policy", "Park Rules"].map((p) => <p key={p} className="mt-2 hover:text-white cursor-pointer">{p}</p>)}</div>
        <div><h4 className="font-semibold text-white mb-3">Payments</h4><p>UPI · Cards · Net Banking</p><p className="mt-3 rounded-xl bg-white/5 p-3 text-xs">Prototype for review. All prices, offers and bookings shown are illustrative demo data. No real payments are processed.</p></div>
      </div>
      <div className="border-t border-white/10 py-4 text-center text-xs text-white/40">© 2026 MGM Dizzee World · Demonstration prototype</div>
    </footer>
  );
}

// ---------------- Date step ----------------
export function DateStep({ date, onPick, onNext }: { date: string; onPick: (d: string) => void; onNext: () => void }) {
  const { db } = useStore(); const ctx = useCtx();
  const [month, setMonth] = useState(date ? parseISO(date).getMonth() : parseISO(TODAY).getMonth());
  const year = 2026;
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const sel = date ? eligibleOffers(db.offers, date).filter((o) => !o.coupon) : [];
  return (
    <div className="mx-auto max-w-4xl grid lg:grid-cols-[minmax(0,1fr)_320px] gap-5 fade-in">
      <div className="card p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div><h2 className="font-display text-xl font-bold text-navy-950 whitespace-nowrap">Select your visit date</h2><p className="text-xs text-slate-500">Pick a date – the offers for that day will appear next.</p></div>
          <div className="flex items-center gap-1 self-start sm:self-auto">
            <button aria-label="Previous month" disabled={month <= 10} onClick={() => setMonth(month - 1)} className="h-8 w-8 grid place-items-center rounded-lg border border-slate-200 disabled:opacity-30 hover:bg-slate-50"><Icon name="left" size={16} /></button>
            <div className="min-w-32 px-2 text-center whitespace-nowrap font-display text-sm sm:text-base font-bold text-navy-950">{MONTHS[month]} {year}</div>
            <button aria-label="Next month" disabled={month >= 11} onClick={() => setMonth(month + 1)} className="h-8 w-8 grid place-items-center rounded-lg border border-slate-200 disabled:opacity-30 hover:bg-slate-50"><Icon name="right" size={16} /></button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: lead }).map((_, i) => <div key={"l" + i} />)}
          {Array.from({ length: days }).map((_, i) => {
            const d = `${year}-${String(month + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
            const st = dateStatus(d, db);
            const isSel = d === date;
            return (
              <button key={d} disabled={!st.open} onClick={() => onPick(d)} title={st.open ? fmtDate(d) : `${fmtShort(d)}: ${st.reason}`}
                className={`relative h-10 sm:h-11 rounded-lg text-sm font-semibold transition ${!st.open ? (st.reason === "Past date" ? "text-slate-300 cursor-not-allowed" : "hatch bg-slate-100 text-slate-400 cursor-not-allowed") : isSel ? "bg-navy-950 text-mgm-yellow shadow-md pop-in" : `border border-slate-200 bg-white hover:border-navy-950 hover:bg-mgm-yellow/15 ${d === TODAY ? "text-mgm-red" : "text-navy-950"}`}`}>
                {i + 1}
                {d === TODAY && <span className={`absolute bottom-1 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full ${isSel ? "bg-mgm-yellow" : "bg-mgm-red"}`} />}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-slate-600">
          <span className="flex items-center gap-1.5"><span className="h-3.5 w-3.5 rounded border border-slate-300 bg-white" />Available</span>
          <span className="flex items-center gap-1.5"><span className="h-3.5 w-3.5 rounded bg-navy-950" />Selected</span>
          <span className="flex items-center gap-1.5"><span className="h-3.5 w-3.5 rounded hatch bg-slate-100 border border-slate-200" />Closed</span>
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-mgm-red" />Today</span>
        </div>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-25 self-start">
        <div className="rounded-2xl hero-mesh text-white p-5">
          <div className="text-xs font-bold uppercase tracking-widest text-white/75">Your visit</div>
          {date ? (
            <>
              <div key={date} className="mt-1.5 font-display text-xl font-bold fade-in">{fmtDate(date, { weekday: "long", day: "numeric", month: "long" })}</div>
              <div className="mt-1 text-sm text-white/80">Park open {db.settings.openTime} AM – 6:30 PM</div>
              <div className="mt-5 rounded-xl bg-white/10 p-3">
                <div className="text-xs font-bold uppercase tracking-wide text-mgm-yellow mb-2 flex items-center gap-1.5"><Icon name="tag" size={13} />{sel.length ? `${sel.length} offer${sel.length > 1 ? "s" : ""} for this date` : "Offers for this date"}</div>
                {sel.length ? sel.map((o) => <div key={o.id} className="flex items-center justify-between gap-2 py-1 text-sm"><span className="flex items-center gap-2 text-white/90"><span className="h-1.5 w-1.5 rounded-full bg-mgm-yellow" />{o.name}</span><span className="text-xs font-semibold text-mgm-yellow">{offerUnit(o, date, ctx)?.benefit}</span></div>)
                  : <p className="text-sm text-white/75">No special offers on this date. Regular tickets are available.</p>}
              </div>
              <Button size="lg" className="mt-6 w-full" onClick={onNext} iconRight="arrow">Continue to Tickets</Button>
            </>
          ) : <p className="mt-3 text-white/70 text-sm">Tap a date on the calendar to see the offers available for that day.</p>}
        </div>
        <div className="card p-5 text-sm text-slate-600 flex gap-3"><Icon name="info" className="text-sky-600 mt-0.5" /><p>Tickets are valid only for the selected date. Dates can be changed up to 24 hours before your visit (₹100 fee).</p></div>
      </aside>
    </div>
  );
}
const Legend = ({ c, t }: { c: string; t: string }) => <span className="flex items-center gap-1.5"><span className={`h-2 w-4 rounded-full ${c}`} />{t}</span>;

// ---------------- Ticket selection ----------------
function WeekStrip({ date, setDate }: { date: string; setDate: (d: string) => void }) {
  const { db } = useStore();
  // 7-day window around the selected date, never before today or after the sale window
  let start = addDays(date, -3);
  if (start < TODAY) start = TODAY;
  if (addDays(start, 6) > MAX_DATE) start = addDays(MAX_DATE, -6);
  const list = datesBetween(start, addDays(start, 6));
  return (
    <div className="flex items-stretch gap-1.5 overflow-x-auto no-scrollbar py-0.5">
      {list.map((d) => {
        const st = dateStatus(d, db); const n = st.open ? eligibleOffers(db.offers, d).filter((o) => !o.coupon).length : 0;
        const sel = d === date;
        return (
          <button key={d} disabled={!st.open} onClick={() => setDate(d)} title={st.open ? `${n} offer${n === 1 ? "" : "s"} on ${fmtShort(d)}` : `${fmtShort(d)}: ${st.reason}`}
            className={`shrink-0 w-[62px] rounded-xl border px-1 pt-1.5 pb-1 text-center transition ${sel ? "bg-navy-950 border-navy-950 text-white shadow-md" : st.open ? "bg-white border-slate-200 text-navy-950 hover:border-navy-900" : "hatch bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed"}`}>
            <div className={`text-[10px] font-semibold uppercase ${sel ? "text-white/70" : "text-slate-500"}`}>{WD[dow(d)]}</div>
            <div className="font-bold text-lg leading-tight">{parseISO(d).getDate()}</div>
            <div className={`mt-0.5 text-[9px] font-bold uppercase tracking-wide truncate ${!st.open ? "text-slate-500" : sel ? "text-mgm-yellow" : n ? "text-mgm-red" : "text-slate-400"}`}>{!st.open ? "Closed" : n ? `${n} offer${n > 1 ? "s" : ""}` : "No offers"}</div>
          </button>
        );
      })}
    </div>
  );
}

function Collapse({ title, icon, count, open, onToggle, children, accent }: { title: string; icon: string; count: string; open: boolean; onToggle: () => void; children: React.ReactNode; accent?: boolean }) {
  return (
    <section className="card overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-3.5 px-5 sm:px-6 py-4 text-left hover:bg-slate-50/70 transition" aria-expanded={open}>
        <span className={`grid h-11 w-11 place-items-center rounded-2xl ${accent ? "bg-gradient-to-br from-[#E2574C] to-mgm-red text-white shadow-[0_8px_18px_-8px_rgba(206,59,55,.8)]" : "bg-gradient-to-br from-[#FBD970] to-mgm-yellow text-navy-950 shadow-[0_8px_18px_-8px_rgba(246,205,69,.9)]"}`}><Icon name={icon} size={20} /></span>
        <span className="flex-1 min-w-0"><span className="block font-display text-xl font-bold text-navy-950">{title}</span><span className="block text-xs text-slate-500">{count}</span></span>
        <span className={`grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-slate-600 transition-transform duration-300 ${open ? "" : "rotate-180"}`}><Icon name="up" size={16} /></span>
      </button>
      {open && <div className="border-t border-slate-100 divide-y divide-slate-100 stagger">{children}</div>}
    </section>
  );
}

export function TicketsStep({ date, setDate, cart, setCart, priced, onBack, onNext }: { date: string; setDate: (d: string) => void; cart: Cart; setCart: React.Dispatch<React.SetStateAction<Cart>>; priced: Priced; onBack: () => void; onNext: () => void }) {
  const { db, toast } = useStore(); const ctx = useCtx();
  const [openReg, setOpenReg] = useState(true);
  const [openOff, setOpenOff] = useState(true);
  const [terms, setTerms] = useState<Offer | null>(null);
  const [code, setCode] = useState(cart.coupon);
  const offers = eligibleOffers(db.offers, date);
  const productOffers = offers.filter((o) => !o.coupon);
  const coupons = offers.filter((o) => o.coupon);
  const setT = (id: string, q: number) => setCart((c) => ({ ...c, tickets: { ...c.tickets, [id]: q } }));
  const setO = (id: string, q: number) => setCart((c) => ({ ...c, offers: { ...c.offers, [id]: q } }));
  const applyCoupon = (c: string) => {
    const v = c.trim().toUpperCase(); setCode(v);
    setCart((x) => ({ ...x, coupon: v }));
  };
  useEffect(() => { setCode(cart.coupon); }, [cart.coupon]);
  const canProceed = priced.ticketCount > 0 && priced.issues.length === 0;

  return (
    <div className="fade-in">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="h-10 w-10 grid place-items-center rounded-xl border border-slate-200 bg-white hover:bg-slate-50" aria-label="Back"><Icon name="back" /></button>
          <div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Visiting on</div><div className="font-display text-xl font-bold text-navy-950">{fmtDate(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div></div>
        </div>
        <WeekStrip date={date} setDate={(d) => { setDate(d); toast(`Date changed to ${fmtShort(d)} · offers updated`); }} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
        <div className="space-y-5">
          <Collapse title="Regular tickets" icon="ticket" count={`${db.tickets.filter((t) => t.active).length} ticket types · prices for ${fmtShort(date)}`} open={openReg} onToggle={() => setOpenReg(!openReg)}>
            {db.tickets.filter((t) => t.active).map((t) => {
              const p = ticketPrice(t, date, ctx); const q = cart.tickets[t.id] || 0;
              return (
                <div key={t.id} className={`grid grid-cols-[auto_1fr] sm:grid-cols-[auto_1fr_auto] gap-x-4 gap-y-3 p-4 sm:p-5 transition ${q ? "bg-mgm-yellow/10" : ""}`}>
                  <TicketArt kind={t.kind} audience={t.audience} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap"><h3 className="font-display text-lg font-bold text-navy-950">{t.name}</h3>{t.kind === "fasttrack" && <Badge tone="red"><Icon name="zap" size={10} />Skip queue</Badge>}</div>
                    <p className="text-sm text-slate-600 mt-0.5 line-clamp-2 sm:line-clamp-none">{t.description}</p>
                    <p className="text-xs text-slate-500 mt-1.5 flex items-center gap-1"><Icon name="info" size={13} />{t.eligibility}</p>
                    {(t.validityNote || t.restrictions || t.reEntry !== undefined) && <p className="text-xs text-slate-500 mt-1">{[t.validityNote, t.reEntry ? "Same-day re-entry allowed" : t.reEntry === false ? "No re-entry" : "", t.restrictions].filter(Boolean).join(" · ")}</p>}
                  </div>
                  <div className="col-span-2 sm:col-span-1 flex sm:flex-col items-center sm:items-end justify-between gap-2">
                    <div className="sm:text-right"><div className="font-display text-xl font-bold text-navy-950">{inr(p)}</div>{p !== t.basePrice && <div className="text-[11px] text-slate-400">Base {inr(t.basePrice)}</div>}<div className="text-[10px] text-slate-400">+ GST per ticket</div></div>
                    <Qty value={q} onChange={(n) => setT(t.id, n)} addLabel="Add" label={t.name} />
                  </div>
                </div>
              );
            })}
          </Collapse>

          <Collapse accent title="Offer tickets" icon="gift" count={productOffers.length ? `${productOffers.length} offer${productOffers.length > 1 ? "s" : ""} valid on ${fmtShort(date)}` : `No offers on ${fmtShort(date)}`} open={openOff} onToggle={() => setOpenOff(!openOff)}>
            {productOffers.length === 0 && (
              <div className="p-8 text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-400"><Icon name="tag" size={26} /></div><p className="mt-3 font-semibold text-navy-950">No offer tickets for this date</p><p className="text-sm text-slate-500">Try a weekday or weekend nearby — offers are configured per date.</p></div>
            )}
            {productOffers.map((o) => {
              const u = offerUnit(o, date, ctx); if (!u) return null;
              const q = cart.offers[o.id] || 0; const left = o.maxRedemptions - o.redemptions;
              return (
                <div key={o.id} className={`p-4 sm:p-5 transition ${q ? "bg-red-50/60" : ""}`}>
                  <div className="flex flex-col sm:flex-row gap-4">
                    <div className="relative w-full sm:w-40 shrink-0"><OfferArt theme={o.theme} type={o.type} image={o.image} className="h-28 sm:h-full min-h-28 rounded-2xl" />{o.featured && <Badge tone="yellow" className="absolute left-2 top-2"><Icon name="star" size={10} />Featured</Badge>}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <div><h3 className="font-display text-lg font-bold text-navy-950">{o.name}</h3><p className="text-sm text-slate-600">{o.description}</p></div>
                        <Badge tone="green" className="shrink-0 !text-xs">{u.benefit}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span className="flex items-center gap-1"><Icon name="ticket" size={13} />{u.label}</span>
                        <span className="flex items-center gap-1"><Icon name="calendar" size={13} />{validityText(o)}</span>
                        {o.requiresId && <span className="flex items-center gap-1 text-amber-700"><Icon name="alert" size={13} />{o.requiresId} required</span>}
                        {left < 100 && <span className="text-mgm-red font-semibold">Only {left} left</span>}
                      </div>
                      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                        <div className="flex items-baseline gap-2"><span className="font-display text-2xl font-bold text-navy-950">{inr(u.price)}</span>{u.original > u.price && <span className="text-sm text-slate-400 line-through">{inr(u.original)}</span>}<span className="text-[11px] text-slate-400">{o.type === "package" || o.type === "bxgy" ? "per pack" : "per ticket"}</span></div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => setTerms(o)} className="text-xs font-semibold text-slate-500 underline underline-offset-2 hover:text-navy-950">Offer terms</button>
                          <Qty size="sm" value={q} max={Math.min(10, left)} addLabel="Add" label={o.name} onChange={(n) => { const m = o.type === "percent" || o.type === "flat" ? Math.max(1, o.minQty) : 1; setO(o.id, n > q && q === 0 ? m : n < m ? 0 : n); }} />
                        </div>
                      </div>
                      {(o.type === "percent" || o.type === "flat") && o.minQty > 1 && q > 0 && q < o.minQty && <p className="mt-2 text-xs font-semibold text-red-600">Minimum {o.minQty} tickets for this offer.</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </Collapse>

          <div className="rounded-2xl overflow-hidden bg-white border border-slate-200 shadow-sm">
            <div className="bg-gradient-to-r from-mgm-yellow/50 to-mgm-yellow/10 px-5 py-4"><h3 className="font-display text-xl font-bold text-navy-950">Grab Your Tickets</h3><p className="text-xs font-medium text-navy-900/70">Deals & info for {fmtShort(date)}</p></div>
            <div className="p-5 grid sm:grid-cols-3 gap-5">
              {productOffers.filter((o) => o.featured).length > 0 && (
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5"><Icon name="sparkles" size={14} />Featured today</div>
                  {productOffers.filter((o) => o.featured).map((o) => <div key={o.id} className="flex items-center gap-3 py-1.5"><OfferArt theme={o.theme} type={o.type} image={o.image} className="h-10 w-10 rounded-xl shrink-0 [&>div]:hidden" /><div className="min-w-0"><div className="text-sm font-semibold text-navy-950 truncate">{o.name}</div><div className="text-xs text-slate-500">{offerUnit(o, date, ctx)?.benefit}</div></div></div>)}
                </div>
              )}
              <div>
                <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5"><Icon name="info" size={14} />Visitor information</div>
                <ul className="space-y-1.5 text-sm text-slate-600">
                  <li className="flex gap-2"><Icon name="clock" size={15} className="mt-0.5 text-slate-400" />Park open {db.settings.openTime} AM – 6:30 PM</li>
                  <li className="flex gap-2"><Icon name="users" size={15} className="mt-0.5 text-slate-400" />Children below 90 cm enter free</li>
                  <li className="flex gap-2"><Icon name="swim" size={15} className="mt-0.5 text-slate-400" />Nylon swimwear mandatory for water rides</li>
                </ul>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3 text-xs text-slate-600">
                <div className="font-bold text-navy-950 mb-1">Offer restrictions</div>
                Offers are valid only on the dates shown and can't be combined with each other. Offer tickets are non-refundable and non-transferable.
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: booking summary + info */}
        <aside className="lg:sticky lg:top-25 self-start">
          <div className="card overflow-hidden">
            <div className="bg-gradient-to-br from-[#2A2926] to-navy-950 px-5 py-4 flex items-center justify-between gap-3">
              <h3 className="font-display text-lg font-bold text-white">Booking summary</h3>
              <span className="rounded-full bg-mgm-yellow px-2.5 py-0.5 text-[11px] font-bold text-navy-950">{priced.ticketCount} ticket{priced.ticketCount === 1 ? "" : "s"}</span>
            </div>
            <div className="px-5 pb-5 pt-1">
              <div className="flex items-center justify-between pt-3 text-sm"><span className="flex items-center gap-1.5 text-slate-600"><Icon name="calendar" size={15} />{fmtDate(date)}</span><button onClick={onBack} className="text-xs font-bold text-mgm-red hover:underline">Change</button></div>
              <SummaryLines priced={priced} />
              {priced.issues.map((i) => <p key={i} className="mt-2 text-sm font-medium text-red-600">{i}</p>)}
              <Button size="lg" className="mt-4 w-full" disabled={!canProceed} onClick={onNext} iconRight="arrow">Proceed to Add-ons</Button>
            </div>
          </div>
        </aside>
      </div>

      {/* sticky mobile bar */}
      <MobileBar priced={priced} label="Add-ons" disabled={!canProceed} onNext={onNext} />
      <Modal open={!!terms} onClose={() => setTerms(null)} title={terms?.name || ""}>
        {terms && <div className="space-y-3 text-sm text-slate-700"><OfferArt theme={terms.theme} type={terms.type} image={terms.image} className="h-28 rounded-2xl" /><p>{terms.description}</p><div className="rounded-xl bg-slate-50 p-3"><div className="font-semibold text-navy-950 mb-1">Valid</div>{validityText(terms)}</div><ul className="list-disc pl-5 space-y-1">{terms.terms.split("\n").filter(Boolean).map((t) => <li key={t}>{t}</li>)}</ul></div>}
      </Modal>
    </div>
  );
}

function MobileBar({ priced, label, disabled, onNext }: { priced: Priced; label: string; disabled: boolean; onNext: () => void }) {
  return (
    <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-slate-200 px-4 py-3 flex items-center justify-between gap-3 shadow-[0_-8px_30px_rgba(0,0,0,.08)]">
      <div><div className="text-[11px] text-slate-500">{priced.ticketCount} ticket{priced.ticketCount === 1 ? "" : "s"} · incl. GST</div><div key={priced.total} className="bump font-display text-xl font-bold text-navy-950">{inr(priced.total)}</div></div>
      <Button disabled={disabled} onClick={onNext} iconRight="arrow">{label}</Button>
    </div>
  );
}

export function SummaryLines({ priced, compact }: { priced: Priced; compact?: boolean }) {
  const { db } = useStore();
  if (!priced.lines.length) return <div className="mt-4 rounded-2xl bg-slate-50 p-5 text-center text-sm text-slate-500">Add tickets or an offer to see your total.</div>;
  return (
    <div className="mt-4">
      {!compact && (
        <div className="space-y-2 mb-3">
          {priced.lines.map((l) => (
            <div key={l.kind + l.refId} className="flex justify-between gap-3 text-sm fade-in">
              <span className="text-slate-700"><span className="font-semibold text-navy-950">{l.qty}×</span> {l.label}{l.kind === "offer" && <span className="block text-xs text-slate-500">{l.detail}</span>}</span>
              <span className="font-semibold tabular-nums text-navy-950">{inr(l.amount)}{l.original > l.amount && <span className="block text-right text-[11px] font-normal text-slate-400 line-through">{inr(l.original)}</span>}</span>
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-dashed border-slate-200 pt-3 space-y-1.5 text-sm">
        <Row k="Subtotal" v={inr(priced.subtotal)} />
        {priced.offerSavings > 0 && <Row k="Offer discount" v={"– " + inr(priced.offerSavings)} tone="text-emerald-700" />}
        {priced.couponDiscount > 0 && <Row k={`Coupon (${priced.couponOffer?.coupon})`} v={"– " + inr(priced.couponDiscount)} tone="text-emerald-700" />}
        {priced.complimentary > 0 && <Row k="Complimentary tickets" v={`${priced.complimentary} free`} tone="text-emerald-700" />}
        {priced.addonsTotal > 0 && <Row k="Add-ons (incl. above)" v={inr(priced.addonsTotal)} tone="text-slate-500" />}
        <Row k={`GST (${db.settings.gst}%)`} v={inr(priced.tax)} />
        <div className="flex justify-between items-baseline pt-2 border-t border-slate-200"><span className="font-bold text-navy-950">Grand total</span><span key={priced.total} className="bump font-display text-2xl font-bold text-navy-950">{inr(priced.total)}</span></div>
        {priced.offerSavings + priced.couponDiscount > 0 && <div className="rounded-xl bg-emerald-50 text-emerald-700 text-xs font-semibold px-3 py-2 text-center">You're saving {inr(priced.offerSavings + priced.couponDiscount)} on this booking</div>}
      </div>
    </div>
  );
}
const Row = ({ k, v, tone = "" }: { k: string; v: string; tone?: string }) => <div className={`flex justify-between ${tone}`}><span className={tone ? "" : "text-slate-600"}>{k}</span><span className="font-semibold tabular-nums">{v}</span></div>;

function SideSummary({ date, priced, children }: { date: string; priced: Priced; children?: React.ReactNode }) {
  return (
    <aside className="lg:sticky lg:top-25 self-start card p-5">
      <div className="flex items-center gap-3 pb-4 border-b border-slate-100"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-navy-950 text-mgm-yellow"><Icon name="calendar" /></span><div><div className="text-xs text-slate-500">Visit date</div><div className="font-bold text-navy-950">{fmtDate(date)}</div></div></div>
      <SummaryLines priced={priced} />
      {children}
    </aside>
  );
}

// ---------------- Add-ons ----------------
export function AddonsStep({ cart, setCart, priced, date, onBack, onNext }: { cart: Cart; setCart: React.Dispatch<React.SetStateAction<Cart>>; priced: Priced; date: string; onBack: () => void; onNext: () => void }) {
  const { db } = useStore();
  const setA = (id: string, q: number) => setCart((c) => ({ ...c, addons: { ...c.addons, [id]: q } }));
  // Skipping means no extras: clear any add-ons picked here; tickets, offers and coupon stay as they are.
  const skip = () => { setCart((c) => ({ ...c, addons: {} })); onNext(); };
  const art: Record<string, string> = { food: "from-orange-400 to-mgm-red", locker: "from-slate-500 to-navy-950", swim: "from-sky-400 to-blue-700", vr: "from-violet-500 to-fuchsia-700", camera: "from-amber-300 to-orange-500", cabana: "from-emerald-400 to-teal-700" };
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 fade-in">
      <div>
        <div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-2xl font-bold text-navy-950">Make it a perfect day</h2><Badge tone="slate">Optional</Badge></div>
        <p className="text-sm text-slate-500 mb-5">Add-ons are extras. You can continue without them — your tickets are already in your booking.</p>
        <div className="grid sm:grid-cols-2 gap-4 stagger">
          {db.addons.map((a) => {
            const q = cart.addons[a.id] || 0;
            return (
              <div key={a.id} className={`rounded-2xl bg-white border overflow-hidden transition lift ${q ? "border-navy-950 shadow-lg" : "border-slate-200/70"}`}>
                <div className={`relative h-28 bg-gradient-to-br ${art[a.icon] || art.food}`}>
                  <svg viewBox="0 0 200 100" className="absolute inset-0 h-full w-full opacity-20" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><circle cx="160" cy="20" r="50" fill="#fff" /><circle cx="30" cy="90" r="30" fill="#fff" /></svg>
                  <div className="absolute inset-0 grid place-items-center text-white"><Icon name={a.icon} size={44} strokeWidth={1.6} /></div>
                  {a.tag && <Badge tone="yellow" className="absolute left-3 top-3">{a.tag}</Badge>}
                </div>
                <div className="p-4">
                  <div className="flex justify-between gap-3"><h3 className="font-bold text-navy-950">{a.name}</h3><span className="font-display font-bold text-navy-950">{inr(a.price)}</span></div>
                  <p className="text-sm text-slate-600 mt-1 min-h-10">{a.description}</p>
                  <div className="mt-3 flex items-center justify-between">
                    <span className={`text-xs font-semibold ${q ? "text-emerald-700" : "text-slate-400"}`}>{q ? `${q} added · ${inr(a.price * q)}` : "Optional"}</span>
                    <Qty size="sm" value={q} onChange={(n) => setA(a.id, n)} addLabel="Add" label={a.name} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-6 flex flex-wrap justify-between items-center gap-2"><Button variant="ghost" icon="back" onClick={onBack}>Back to tickets</Button><Button variant="outline" onClick={skip}>Skip add-ons</Button><Button size="lg" onClick={onNext} iconRight="arrow" className="max-lg:hidden">Continue</Button></div>
      </div>
      <SideSummary date={date} priced={priced}><Button size="lg" className="w-full mt-4 max-lg:hidden" onClick={onNext} iconRight="arrow">Continue to Details</Button></SideSummary>
      <MobileBar priced={priced} label="Continue" disabled={false} onNext={onNext} />
    </div>
  );
}

// ---------------- Details ----------------
function DetailsStep({ date, priced, customer, setCustomer, onBack, onNext }: { date: string; priced: Priced; customer: { name: string; phone: string; email: string; visitors: number; notes: string }; setCustomer: (c: typeof customer) => void; onBack: () => void; onNext: () => void }) {
  const { db } = useStore();
  const [touched, setTouched] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const c = { ...customer, visitors: customer.visitors || priced.ticketCount };
  const errs = {
    name: c.name.trim().length < 3 ? "Enter your full name" : "",
    phone: !/^[6-9]\d{9}$/.test(c.phone) ? "Enter a valid 10-digit mobile number" : "",
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email) ? "Enter a valid email address" : "",
    visitors: c.visitors < 1 ? "At least 1 visitor" : "",
  };
  const ok = !Object.values(errs).some(Boolean);
  const set = (k: string, v: string | number) => setCustomer({ ...c, [k]: v });
  const needsId = priced.lines.some((l) => l.kind === "offer" && db.offers.find((o) => o.id === l.refId)?.requiresId);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-6 fade-in">
      <div className="space-y-5">
        <div className="card p-5 sm:p-6">
          <h2 className="font-display text-2xl font-bold text-navy-950">Your details</h2>
          <p className="text-sm text-slate-500 mb-5">E-tickets will be sent to this mobile number and email.</p>
          <form key={shakeKey} className={`grid sm:grid-cols-2 gap-4 ${shakeKey ? "shake" : ""}`} onSubmit={(e) => { e.preventDefault(); setTouched(true); if (ok) { setCustomer(c); onNext(); } else setShakeKey((k) => k + 1); }}>
            <div className="sm:col-span-2"><Field label="Full name *" error={touched ? errs.name : ""}><input className={inputCls} value={c.name} onChange={(e) => set("name", e.target.value)} placeholder="As per ID proof" autoComplete="name" /></Field></div>
            <Field label="Mobile number *" error={touched ? errs.phone : ""}><div className="flex"><span className="h-10 px-3 grid place-items-center rounded-l-xl border border-r-0 border-slate-200 bg-slate-50 text-sm text-slate-500">+91</span><input className={inputCls + " rounded-l-none"} value={c.phone} onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="98400 12345" inputMode="numeric" /></div></Field>
            <Field label="Email address *" error={touched ? errs.email : ""}><input className={inputCls} value={c.email} onChange={(e) => set("email", e.target.value.trim())} placeholder="you@example.com" type="email" /></Field>
            <Field label="Number of visitors *" hint={`Your tickets cover ${priced.ticketCount} visitor${priced.ticketCount === 1 ? "" : "s"}`} error={touched ? errs.visitors : ""}><input className={inputCls} type="number" min={1} value={c.visitors} onChange={(e) => set("visitors", Number(e.target.value))} /></Field>
            <Field label="Special requirements (optional)"><input className={inputCls} value={c.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Wheelchair, birthday, etc." /></Field>
            <div className="sm:col-span-2 flex flex-col-reverse sm:flex-row justify-between gap-3 pt-2">
              <Button type="button" variant="ghost" icon="back" onClick={onBack}>Back</Button>
              <Button type="submit" size="lg" iconRight="arrow">Continue to Payment</Button>
            </div>
          </form>
        </div>
        <div className="card p-5 sm:p-6">
          <h3 className="font-bold text-navy-950 mb-3 flex items-center gap-2"><Icon name="file" size={18} />Ticket conditions</h3>
          <ul className="space-y-2 text-sm text-slate-600 list-disc pl-5">
            <li>Valid only on {fmtDate(date)} for a single entry.</li>
            <li>Carry a valid photo ID; child tickets are subject to height check (90–140 cm).</li>
            {needsId && <li className="text-amber-700 font-medium">Student offer: show a valid college ID at the gate or pay the difference.</li>}
            {priced.lines.some((l) => l.kind === "ticket" && l.detail === "Fast Track") && <li>Fast Track allows one priority entry per major ride.</li>}
            <li>Offer tickets are non-refundable. Regular tickets can be cancelled up to 48 hours before the visit (10% fee).</li>
          </ul>
        </div>
      </div>
      <SideSummary date={date} priced={priced} />
    </div>
  );
}

// ---------------- Payment ----------------
function PaymentStep({ date, priced, cart, customer, onBack, onPaid }: { date: string; priced: Priced; cart: Cart; customer: Booking["customer"]; onBack: () => void; onPaid: (b: Booking, a: Access) => void }) {
  const { db } = useStore();
  const [method, setMethod] = useState<"upi" | "card" | "nb">("upi");
  const [upi, setUpi] = useState("");
  const [card, setCard] = useState({ num: "", exp: "", cvv: "", name: customer.name });
  const [bank, setBank] = useState("");
  const [stage, setStage] = useState<"form" | "processing" | "success" | "failed">("form");
  const [key] = useState(idemKey);
  const [held, setHeld] = useState<{ booking: Booking; access: Access } | null>(null);
  const [error, setError] = useState("");
  // The server prices the booking and holds the tickets while the customer pays (Idempotency-Key: a retry or a
  // double click never creates a second booking).
  useEffect(() => {
    api<{ booking: Booking; accessToken: string }>("/api/bookings", {
      method: "POST", headers: { "Idempotency-Key": key },
      body: { visit_date: date, cart: { ...cart, coupon: cart.coupon && !priced.couponError ? cart.coupon : "" }, session_token: visitorToken(),
              customer: { name: customer.name, phone: customer.phone, email: customer.email || null, notes: customer.notes || null } },
    }).then((r) => { const a = { ref: r.booking.id, token: r.accessToken }; rememberBooking(a); setHeld({ booking: r.booking, access: a }); })
      .catch((e: Error) => setError(e.message));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = held?.booking.id || "…";
  const total = held?.booking.totals.total ?? priced.total;
  const valid = !!held && (method === "upi" ? /^[\w.-]{2,}@[a-z]{2,}$/i.test(upi) : method === "card" ? card.num.replace(/\s/g, "").length === 16 && /^\d\d\/\d\d$/.test(card.exp) && card.cvv.length === 3 : !!bank);
  const pay = async (decline = false) => {
    if (!held) return;
    setStage("processing");
    try {
      const h = bookingHeaders(held.access);
      const p = await api<{ payment_id: number }>(`/api/bookings/${held.booking.id}/payments`, { method: "POST", headers: h, body: { method: method === "upi" ? "UPI" : method === "card" ? "Card" : "Net Banking" } });
      const b = await api<Booking>(`/api/bookings/${held.booking.id}/payments/${p.payment_id}/simulate`, { method: "POST", headers: h, body: { outcome: decline ? "decline" : "success" } });
      if (b.state !== "confirmed") { setStage("failed"); return; }
      setStage("success");
      setTimeout(() => onPaid(b, held.access), 900);
    } catch (e) { setError((e as Error).message); setStage("form"); }
  };
  if (error && !held) return (
    <div className="max-w-lg mx-auto card p-6 text-center fade-in">
      <Icon name="alert" size={30} className="mx-auto text-mgm-red mb-2" /><div className="font-bold text-navy-950">We couldn't hold these tickets</div>
      <p className="text-sm text-slate-600 mt-1">{error}</p><Button className="mt-4" variant="outline" icon="back" onClick={onBack}>Back</Button>
    </div>
  );
  const tickets = priced.lines.filter((l) => l.kind !== "addon");
  const addons = priced.lines.filter((l) => l.kind === "addon");
  return (
    <div className="max-w-5xl mx-auto fade-in">
      <div className="rounded-2xl overflow-hidden shadow-2xl shadow-navy-950/15 grid md:grid-cols-[300px_1fr] bg-white">
        {/* left brand panel (Razorpay-style) */}
        <div className="hero-mesh text-white p-6 flex flex-col">
          <Logo light />
          <div className="mt-6 text-xs uppercase tracking-widest text-white/75">Booking reference</div>
          <div className="font-mono font-bold text-mgm-yellow text-lg">{ref}</div>
          <div className="mt-5 space-y-3 text-sm">
            <div><div className="text-white/75 text-xs">Customer</div><div className="font-semibold">{customer.name}</div><div className="text-white/70 text-xs">+91 {customer.phone} · {customer.email}</div></div>
            <div><div className="text-white/75 text-xs">Visit date</div><div className="font-semibold">{fmtDate(date)}</div></div>
            <div><div className="text-white/75 text-xs mb-1">Tickets</div>{tickets.map((l) => <div key={l.refId} className="flex justify-between gap-2 text-white/85"><span>{l.qty}× {l.label}</span><span>{inr(l.amount)}</span></div>)}</div>
            {addons.length > 0 && <div><div className="text-white/75 text-xs mb-1">Add-ons</div>{addons.map((l) => <div key={l.refId} className="flex justify-between gap-2 text-white/85"><span>{l.qty}× {l.label}</span><span>{inr(l.amount)}</span></div>)}</div>}
            {(priced.offerSavings > 0 || priced.couponOffer) && <div><div className="text-white/75 text-xs mb-1">Applied offers</div>{priced.lines.filter((l) => l.kind === "offer").map((l) => <Badge key={l.refId} tone="yellow" className="mr-1 mb-1">{l.label}</Badge>)}{priced.couponOffer && <Badge tone="yellow">{priced.couponOffer.coupon}</Badge>}<div className="text-emerald-300 text-xs mt-1">Saved {inr(priced.offerSavings + priced.couponDiscount)}</div></div>}
            <div className="flex justify-between text-white/70"><span>GST ({db.settings.gst}%)</span><span>{inr(priced.tax)}</span></div>
          </div>
          <div className="mt-auto pt-6"><div className="text-white/75 text-xs">Amount payable</div><div className="font-display text-4xl font-bold">{inr(total)}</div>{held?.booking.holdExpiresAt && <div className="text-[11px] text-white/70 mt-1">Tickets held for you until {held.booking.holdExpiresAt.slice(11, 16)}</div>}</div>
        </div>
        {/* right methods */}
        <div className="p-5 sm:p-7 relative min-h-[460px]">
          <div className="flex items-center justify-between"><h2 className="font-display text-xl font-bold text-navy-950">Payment options</h2><Badge tone="amber"><Icon name="alert" size={11} />Demo – no real payment</Badge></div>
          <div className="mt-5 grid grid-cols-3 gap-2">
            {([["upi", "UPI", "phoneDev"], ["card", "Card", "card"], ["nb", "Net Banking", "bank"]] as const).map(([k, l, i]) => (
              <button key={k} onClick={() => setMethod(k)} className={`rounded-2xl border-2 p-3 text-left transition ${method === k ? "border-navy-950 bg-navy-950/5" : "border-slate-200 hover:border-slate-300"}`}><Icon name={i} className="text-navy-900" /><div className="mt-2 text-sm font-bold text-navy-950">{l}</div></button>
            ))}
          </div>
          <div className="mt-6">
            {method === "upi" && (
              <div className="grid sm:grid-cols-[1fr_auto] gap-5 items-start">
                <div className="space-y-3">
                  <Field label="UPI ID" hint="e.g. name@okicici, 9840012345@ybl"><input className={inputCls} value={upi} onChange={(e) => setUpi(e.target.value.trim())} placeholder="yourname@bank" /></Field>
                  <div className="flex flex-wrap gap-2">{["@okhdfcbank", "@ybl", "@paytm", "@okicici"].map((s) => <button key={s} onClick={() => setUpi((upi.split("@")[0] || customer.phone) + s)} className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold hover:border-navy-900">{s}</button>)}</div>
                </div>
                <div className="hidden sm:block text-center"><div className="rounded-2xl border border-slate-200 p-2"><QR text={`upi://pay?pa=mgmdizzee@demo&am=${total}&tn=${ref}`} size={120} /></div><div className="text-[11px] text-slate-500 mt-1">Scan with any UPI app<br />(demo QR)</div></div>
              </div>
            )}
            {method === "card" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><Field label="Card number" hint="Demo: use 4111 1111 1111 1111"><input className={inputCls + " font-mono"} inputMode="numeric" value={card.num} onChange={(e) => setCard({ ...card, num: e.target.value.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim() })} placeholder="0000 0000 0000 0000" /></Field></div>
                <Field label="Expiry (MM/YY)"><input className={inputCls} value={card.exp} onChange={(e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 4); setCard({ ...card, exp: v.length > 2 ? v.slice(0, 2) + "/" + v.slice(2) : v }); }} placeholder="12/28" /></Field>
                <Field label="CVV"><input className={inputCls} type="password" value={card.cvv} onChange={(e) => setCard({ ...card, cvv: e.target.value.replace(/\D/g, "").slice(0, 3) })} placeholder="•••" /></Field>
                <div className="col-span-2"><Field label="Name on card"><input className={inputCls} value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} /></Field></div>
              </div>
            )}
            {method === "nb" && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {["State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Indian Bank", "Kotak Mahindra"].map((b) => (
                  <button key={b} onClick={() => setBank(b)} className={`rounded-xl border-2 p-3 text-left text-sm font-semibold transition ${bank === b ? "border-navy-950 bg-navy-950/5" : "border-slate-200 hover:border-slate-300"}`}><Icon name="bank" size={16} className="mb-1 text-slate-500" />{b}</button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-7 flex flex-col-reverse sm:flex-row gap-3 sm:items-center sm:justify-between">
            <Button variant="ghost" icon="back" onClick={onBack}>Back</Button>
            <Button size="lg" variant="dark" disabled={!valid} onClick={() => pay()} className="sm:min-w-56" icon="lock">Pay {inr(total)}</Button>
          </div>
          {error && <div className="mt-3 rounded-xl bg-red-50 text-red-700 text-sm px-3 py-2">{error}</div>}
          <p className="mt-4 text-[11px] text-slate-400 flex items-center gap-1.5"><Icon name="shield" size={13} />Simulated payment: no money is taken. Real payments will use a verified Razorpay integration.
            <button type="button" disabled={!valid} onClick={() => pay(true)} className="ml-auto underline hover:text-slate-600 disabled:no-underline disabled:opacity-50">Simulate a declined payment</button></p>

          {stage !== "form" && (
            <div className="absolute inset-0 bg-white/95 backdrop-blur grid place-items-center rounded-r-3xl fade-in">
              {stage === "processing" ? (
                <div className="text-center"><div className="mx-auto h-14 w-14 rounded-full border-4 border-slate-200 border-t-navy-950 animate-spin" /><div className="mt-4 font-bold text-navy-950">Processing payment…</div><div className="text-sm text-slate-500">Please don't close this window</div></div>
              ) : stage === "failed" ? (
                <div className="text-center pop-in max-w-xs"><div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-mgm-red text-white"><Icon name="x" size={34} strokeWidth={3} /></div><div className="mt-4 font-display text-xl font-bold text-navy-950">Payment declined</div><div className="text-sm text-slate-500">No money was taken (simulated). Your tickets stay held for a few minutes, so you can try again.</div><Button className="mt-4" onClick={() => setStage("form")}>Try again</Button></div>
              ) : (
                <div className="text-center pop-in"><div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-500 text-white"><Icon name="check" size={34} strokeWidth={3} /></div><div className="mt-4 font-display text-xl font-bold text-navy-950">Payment successful</div><div className="text-sm text-slate-500">Generating your e-tickets…</div></div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------- Confirmation ----------------
function CancelPanel({ b, access, onChange }: { b: Booking; access: Access; onChange: (b: Booking) => void }) {
  const { db, toast } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = db.settings;
  const elig = cancellationEligibility(b, s);
  const fee = cancellationFee(b, s);
  const r = b.refund;
  const request = async () => {
    setBusy(true);
    try { onChange(await api<Booking>(`/api/bookings/${b.id}/cancellation-request`, { method: "POST", headers: bookingHeaders(access) })); toast("Cancellation requested — pending review"); }
    catch (e) { toast((e as Error).message, "err"); }
    setBusy(false); setConfirming(false);
  };
  return (
    <div className="card p-5 text-sm">
      <h3 className="font-bold text-navy-950 mb-1">Cancellation & refund</h3>
      <p className="text-slate-600 text-xs mb-3">Regular tickets can be cancelled up to {s.cancelNoticeDays * 24} hours before the visit ({s.cancellationFeePct}% fee). Offer tickets are non-refundable. Partial cancellations are not permitted.</p>
      {r ? (
        <div className="rounded-xl border border-slate-200 p-3">
          <Badge tone={r.status === "pending" ? "amber" : r.status === "rejected" ? "red" : "green"}>{r.status === "pending" ? "Cancellation requested · pending review" : r.status === "rejected" ? "Cancellation rejected" : "Refund approved"}</Badge>
          <div className="mt-2 text-slate-600">{r.status === "rejected" ? <>Reason: {r.rejectionReason}. Your tickets remain valid.</> : <>{r.status === "pending" ? "Indicative refund" : "Refund"}: <b>{inr(r.amount)}</b></>}</div>
        </div>
      ) : !elig.ok ? <div className="text-slate-500 text-xs">{elig.reason}</div> : confirming ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3">
          <div className="text-navy-950">A {s.cancellationFeePct}% fee ({inr(fee)}) applies. Indicative refund: <b>{inr(b.totals.total - fee)}</b>. Your tickets stay valid until the park approves the request.</div>
          <div className="flex gap-2 mt-3"><Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Back</Button><Button size="sm" variant="danger" disabled={busy} onClick={request}>Confirm cancellation request</Button></div>
        </div>
      ) : <Button variant="outline" className="w-full" icon="x" onClick={() => setConfirming(true)}>Request cancellation</Button>}
    </div>
  );
}

// Bookings are opened with their private booking link (shown after payment and kept on this device). Phone-number
// lookup was removed: it exposed anyone's bookings. Production adds an OTP-verified lookup (see handover).
function MyBookings({ onHome, open }: { onHome: () => void; open: Access | null }) {
  const [rows, setRows] = useState<{ access: Access; booking?: Booking; error?: string }[]>(() => {
    const mine = myBookings();
    return (open ? [open, ...mine.filter((m) => m.ref !== open.ref)] : mine).map((access) => ({ access }));
  });
  const [view, setView] = useState<{ booking: Booking; access: Access } | null>(null);
  const [linkText, setLinkText] = useState(""); const [linkErr, setLinkErr] = useState("");
  const legacy = useMemo(() => legacyBookings() as Booking[], []);
  useEffect(() => {
    rows.forEach((r, i) => {
      if (r.booking || r.error) return;
      api<Booking>(`/api/bookings/${r.access.ref}`, { headers: bookingHeaders(r.access) })
        .then((b) => { rememberBooking(r.access); setRows((x) => x.map((y, j) => (j === i ? { ...y, booking: b } : y))); if (open && r.access.ref === open.ref) setView({ booking: b, access: r.access }); })
        .catch((e: ApiError) => setRows((x) => x.map((y, j) => (j === i ? { ...y, error: e.status === 404 ? "Link not valid" : e.message } : y))));
    });
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (view) return <Confirmation booking={view.booking} access={view.access} onHome={() => setView(null)} homeLabel="Back to my bookings" />;
  const status = (b: Booking) => b.status === "cancelled" ? ["Cancelled", "red"] : b.refund?.status === "pending" ? ["Cancellation requested", "amber"] : b.refund?.status === "rejected" ? ["Cancellation rejected", "slate"] : b.payment.status === "paid" ? [b.visitDate < TODAY ? "Visited / expired" : "Confirmed", "green"] : [b.payment.status === "pending" ? "Awaiting payment" : "Not paid", "amber"];
  const addLink = () => {
    const a = parseAccessLink(linkText);
    if (!a) { setLinkErr("Paste the full booking link from your confirmation."); return; }
    setLinkErr(""); setLinkText(""); setRows((x) => [{ access: a }, ...x.filter((y) => y.access.ref !== a.ref)]);
  };
  return (
    <div className="max-w-3xl mx-auto fade-in">
      <div className="flex items-center justify-between gap-3 mb-1"><h2 className="font-display text-2xl font-bold text-navy-950">My Bookings</h2><Button variant="ghost" onClick={onHome}>Back</Button></div>
      <p className="text-sm text-slate-500 mb-4">Bookings made on this device are listed here. On another device, open the private booking link from your confirmation.</p>
      <form className="flex gap-2 mb-5" onSubmit={(e) => { e.preventDefault(); addLink(); }}>
        <input className={inputCls} placeholder="Paste your booking link" value={linkText} onChange={(e) => setLinkText(e.target.value)} aria-label="Booking link" />
        <Button type="submit" disabled={!linkText.trim()}>Open</Button>
      </form>
      {linkErr && <div className="text-sm text-red-600 -mt-3 mb-4">{linkErr}</div>}
      {rows.length === 0 && <div className="text-center text-slate-500 py-10">No bookings on this device yet.</div>}
      <div className="space-y-3">{rows.map(({ access, booking: b, error }) => { const [label, tone] = b ? status(b) : [error || "Loading…", error ? "red" : "slate"]; return (
        <div key={access.ref} className="card p-4 flex items-center justify-between gap-3">
          <div><div className="font-mono font-bold text-navy-950">{access.ref}</div>{b && <div className="text-xs text-slate-500">{fmtDate(b.visitDate)} · {b.tickets.length || b.customer.visitors} tickets · {inr(b.totals.total)}</div>}</div>
          <div className="flex items-center gap-2"><Badge tone={tone}>{label}</Badge>{b && <Button size="sm" variant="outline" onClick={() => setView({ booking: b, access })}>View</Button>}</div>
        </div>); })}</div>
      {legacy.length > 0 && (
        <div className="mt-8">
          <h3 className="font-bold text-navy-950">Saved on this device only (earlier version)</h3>
          <p className="text-xs text-slate-500 mb-3">These were made with the earlier version of this site and are stored only in this browser. They are not confirmed by MGM's ticketing system yet — please show this booking reference at the ticket counter or contact MGM so it can be verified.</p>
          <div className="space-y-2">{legacy.map((b) => <div key={b.id} className="rounded-xl border border-dashed border-slate-300 p-3 text-sm flex justify-between"><span className="font-mono font-semibold">{b.id}</span><span className="text-slate-500">{fmtDate(b.visitDate)} · {inr(b.totals.total)}</span></div>)}</div>
        </div>
      )}
    </div>
  );
}

function Confirmation({ booking, access, onHome, homeLabel = "Return to homepage" }: { booking: Booking; access: Access; onHome: () => void; homeLabel?: string }) {
  const { db, toast } = useStore();
  const [view, setView] = useState<number | null>(null);
  const [live, setLive] = useState(booking);
  const link = `${location.origin}${location.pathname}#booking/${access.ref}/${access.token}`;
  const counts: Record<string, number> = {};
  live.tickets.forEach((t) => (counts[t.label] = (counts[t.label] || 0) + 1));
  const offerNames = live.offerIds.map((id) => db.offers.find((o) => o.id === id)?.name).filter(Boolean);
  return (
    <div className="max-w-5xl mx-auto fade-in">
      <div className="relative overflow-hidden rounded-2xl hero-mesh text-white p-6 sm:p-10">
        <div className="relative flex flex-col sm:flex-row sm:items-center gap-5">
          {live.status === "cancelled" ? <>
            <div className="grid h-16 w-16 place-items-center rounded-full bg-mgm-red pop-in"><Icon name="x" size={34} strokeWidth={3} /></div>
            <div className="flex-1"><div className="text-red-300 text-sm font-bold uppercase tracking-widest">Booking cancelled</div><h1 className="font-display text-3xl sm:text-4xl font-bold">This booking was cancelled</h1><p className="text-white/70 mt-1">Its tickets are no longer valid at the gate.</p></div>
          </> : <>
            <div className="grid h-16 w-16 place-items-center rounded-full bg-emerald-500 pop-in"><Icon name="check" size={34} strokeWidth={3} /></div>
            <div className="flex-1"><div className="text-emerald-300 text-sm font-bold uppercase tracking-widest">Payment successful</div><h1 className="font-display text-3xl sm:text-4xl font-bold">You're all set, {live.customer.name.split(" ")[0]}!</h1><p className="text-white/70 mt-1">Show the QR codes below at the entry gate on {fmtDate(live.visitDate)}.</p></div>
          </>}
          <div className="rounded-2xl bg-white/10 px-5 py-3 text-center"><div className="text-xs text-white/80">Booking ID</div><div className="font-mono text-xl font-bold text-mgm-yellow">{live.id}</div></div>
        </div>
        <div className="relative mt-7 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          {[["Customer", live.customer.name], ["Visit date", fmtDate(live.visitDate, { day: "numeric", month: "short", year: "numeric" })], ["Tickets", `${live.tickets.length} entries`], ["Amount paid", inr(live.totals.total)]].map(([k, v]) => <div key={k} className="rounded-2xl bg-white/5 p-3"><div className="text-white/75 text-xs">{k}</div><div className="font-bold">{v}</div></div>)}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-6 mt-6">
        <div>
          {live.entryQr && live.status !== "cancelled" && (
            <div className="card p-4 sm:p-5 mb-6 flex flex-col sm:flex-row items-center gap-4 sm:gap-5">
              <div className="rounded-2xl border border-slate-200 p-2 bg-white shrink-0"><QR text={live.entryQr} size={168} /></div>
              <div className="min-w-0 text-center sm:text-left">
                <Badge tone="yellow">Group entry</Badge>
                <h2 className="mt-2 font-display text-xl font-bold text-navy-950">One QR for all {live.tickets.length} {live.tickets.length === 1 ? "entry" : "entries"}</h2>
                <p className="mt-1 text-sm text-slate-600">Show this at the gate. Staff can let your whole group in at once, or some now and the rest later. The individual ticket QRs below also work.</p>
                <div className="mt-2 font-mono text-xs font-bold text-navy-900">{live.id}</div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between mb-3"><h2 className="font-display text-xl font-bold text-navy-950">Your e-tickets</h2><span className="text-sm text-slate-500">{live.tickets.length} QR tickets</span></div>
          <div className="grid sm:grid-cols-2 gap-4 stagger">
            {live.tickets.map((t, i) => (
              <button key={t.id} onClick={() => setView(i)} className="text-left card overflow-hidden flex lift ticket-notch">
                <div className="p-4 flex-1 min-w-0">
                  <div className="flex items-center gap-1.5"><Badge tone={t.catId.startsWith("f") ? "red" : "navy"}>{t.catId.startsWith("f") ? "Fast Track" : "General"}</Badge>{t.complimentary && <Badge tone="green">Complimentary</Badge>}</div>
                  <div className="mt-2 font-bold text-navy-950">{t.label}</div>
                  <div className="text-xs text-slate-500">{fmtDate(live.visitDate)}</div>
                  <div className="mt-3 font-mono text-xs font-bold text-navy-900">{t.id}</div>
                  <div className={`mt-1 text-[11px] font-semibold ${t.status === "valid" ? "text-emerald-600" : t.status === "cancelled" ? "text-red-600" : "text-slate-400"}`}>{t.status === "used" ? "Used at " + t.gate : t.status === "cancelled" ? "Cancelled" : "Valid · not scanned"}</div>
                </div>
                <div className="border-l-2 border-dashed border-slate-200 p-3 grid place-items-center bg-slate-50"><QR text={t.qr || t.id} size={96} /></div>
              </button>
            ))}
          </div>
        </div>
        <aside className="space-y-4">
          <div className="card p-5 space-y-3">
            <Button className="w-full" icon="eye" onClick={() => setView(0)}>View tickets</Button>
            <Button className="w-full" variant="outline" icon="download" onClick={() => toast("PDF download is disabled in this preview – production generates a branded PDF", "warn")}>Download PDF</Button>
            <Button className="w-full" variant="outline" icon="copy" onClick={() => { copyText(link); toast("Booking link copied — keep it to open your tickets on any device"); }}>Copy my booking link</Button>
            <Button className="w-full" variant="ghost" icon="home" onClick={onHome}>{homeLabel}</Button>
          </div>
          <CancelPanel b={live} access={access} onChange={setLive} />
          <div className="card p-5 text-sm">
            <h3 className="font-bold text-navy-950 mb-2">Booking details</h3>
            {Object.entries(counts).map(([k, v]) => <div key={k} className="flex justify-between py-0.5"><span className="text-slate-600">{k}</span><span className="font-semibold">× {v}</span></div>)}
            {live.items.filter((i) => i.kind === "addon").map((i) => <div key={i.refId} className="flex justify-between py-0.5"><span className="text-slate-600">{i.label}</span><span className="font-semibold">× {i.qty}</span></div>)}
            {offerNames.length > 0 && <div className="mt-2 pt-2 border-t border-slate-100"><div className="text-xs text-slate-500 mb-1">Offers applied</div>{offerNames.map((n) => <Badge key={n} tone="green" className="mr-1">{n}</Badge>)}</div>}
            {live.totals.complimentary > 0 && <div className="mt-2 text-emerald-700 text-xs font-semibold">{live.totals.complimentary} complimentary tickets included</div>}
            <div className="mt-2 pt-2 border-t border-slate-100 flex justify-between"><span className="text-slate-600">Paid via {live.payment.method}</span><span className="font-bold">{inr(live.totals.total)}</span></div>
            <div className="text-[11px] text-slate-400 mt-1 font-mono">{live.payment.txnId}</div>
          </div>
          <div className="rounded-2xl bg-mgm-yellow/20 border border-mgm-yellow p-4 text-sm text-navy-900 flex gap-2"><Icon name="scan" className="mt-0.5" /><div><b>Keep your booking link.</b> It opens these tickets on any device; anyone with it can see this booking. {live.visitDate !== TODAY && <span>Tickets scan only on {fmtShort(live.visitDate)}.</span>}</div></div>
        </aside>
      </div>
      <Modal open={view !== null} onClose={() => setView(null)} title={`Ticket ${view !== null ? view + 1 : ""} of ${live.tickets.length}`}>
        {view !== null && live.tickets[view] && (() => { const t = live.tickets[view]; return (
          <div className="text-center">
            <div className="rounded-2xl hero-mesh text-white p-5 text-left"><Logo light /><div className="mt-4 flex justify-between text-sm"><div><div className="text-white/75 text-xs">Ticket</div><div className="font-bold">{t.label}</div></div><div className="text-right"><div className="text-white/75 text-xs">Visit</div><div className="font-bold">{fmtDate(live.visitDate, { day: "numeric", month: "short", year: "numeric" })}</div></div></div></div>
            <div className="mx-auto mt-5 inline-block rounded-2xl border border-slate-200 p-3"><QR text={t.qr || t.id} size={220} /></div>
            <div className="mt-3 font-mono font-bold text-navy-950">{t.id}</div>
            <div className="text-xs text-slate-500">Booking {live.id} · {live.customer.name}</div>
            <div className="text-[10px] text-slate-400 mt-1 break-all font-mono">QR ref: {t.qr || t.id}</div>
            <div className="mt-5 flex justify-between"><Button variant="outline" icon="left" disabled={view === 0} onClick={() => setView(view - 1)}>Prev</Button><Button variant="outline" iconRight="right" disabled={view === live.tickets.length - 1} onClick={() => setView(view + 1)}>Next</Button></div>
          </div>
        ); })()}
      </Modal>
    </div>
  );
}
