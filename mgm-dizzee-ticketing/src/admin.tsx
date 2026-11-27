import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Booking, DB, MONTHS, Offer, OfferStatus, OfferType, Staff, TODAY, TicketCat, WD, addDays, dateStatus, datesBetween, effectiveStatus, eligibleOffers,
  fmtDate, fmtShort, fmtTime, inr, offerUnit, parseISO, priceAdj, ticketPrice, tierOf, MIN_DATE, MAX_DATE, rid,
  isRefunded, modificationEligibility, priceCart,
} from "./store";
import { API, LEGACY_KEY, api, legacyBookings, uploadFile } from "./api";
import { StaffLogin } from "./staff";
import { CountUp, DateInput, Select, TimeInput } from "./ui";
import { Badge, Button, Field, Icon, Logo, Modal, OfferArt, QR, THEMES, Toggle, copyText, hasRole, inputCls, useStore } from "./ui";
import { BarChart, Donut, Funnel, HBars, LineChart, PALETTE } from "./charts";
import { useCtx, validityText } from "./customer";
import InfluencerModule, { RegionalAnalytics } from "./influencers";
import CounterSale from "./counter";

const MODULES = [
  ["dashboard", "Dashboard", "grid"], ["calendar", "Calendar Management", "calendar"], ["tickets", "Ticket Management", "ticket"],
  ["offers", "Offer Management", "tag"], ["bookings", "Booking Management", "file"], ["payments", "Payment Management", "card"],
  ["customers", "Customer Management", "users"], ["entry", "QR / Entry Management", "qr"], ["reports", "Reports & Analytics", "chart"],
  ["staff", "Staff Management", "user"], ["counter", "Counter Sale", "zap"], ["notifications", "Notifications", "mail"], ["audit", "Activity Log", "clock"],
  ["settings", "Settings", "settings"], ["regions", "Regional Sales Analytics", "chart"], ["influencers", "Influencer Management", "trend"],
] as const;
type Mod = (typeof MODULES)[number][0];
// Which staff roles can open which module (admin: everything). The server enforces the same on every API call.
const MODULE_ROLES: Record<Mod, string[]> = {
  dashboard: ["finance"], reports: ["finance"], calendar: [], tickets: [], offers: [], bookings: ["finance"], payments: ["finance"],
  customers: ["finance"], counter: ["counter"], regions: ["marketing"], influencers: ["marketing"], entry: ["finance"], staff: [], notifications: ["finance"],
  audit: ["finance"], settings: [],
};

export default function AdminApp() {
  const { me } = useStore();
  if (!me) return <div className="staff-h bg-slate-200/60 flex justify-center"><div className="w-full max-w-md"><StaffLogin title="Admin Console" subtitle="Sign in with your MGM staff account." /></div></div>;
  return <AdminConsole />;
}

function AdminConsole() {
  const { db, me, setMe } = useStore();
  const visible = MODULES.filter(([k]) => hasRole(me, ...MODULE_ROLES[k]));
  const [mod, setMod] = useState<Mod>(visible[0]?.[0] || "dashboard");
  const allowed = visible.some(([k]) => k === mod);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const title = MODULES.find((m) => m[0] === mod)![1];
  const desc: Record<string, string> = {
    dashboard: "Live overview of bookings, revenue and park entries", calendar: "Open or close dates, set capacity and date-wise pricing",
    tickets: "Ticket categories, base prices and availability", offers: "Create, schedule and control promotional offers",
    bookings: "Search, review and manage customer bookings", payments: "Gateway transactions, settlements and refunds",
    customers: "Customer profiles and booking history", entry: "Gate scans, entry status and rejected tickets",
    reports: "Revenue, sales mix and offer performance", staff: "Gate staff accounts and assignments", settings: "Park details and booking rules",
    regions: "Website and counter sales by state, city and acquisition channel",
    influencers: "Influencer performance, campaigns, referral links and commissions",
    counter: "Walk-in ticket sales at the park counter (simulated payment)", notifications: "Booking, cancellation, refund and change events",
    audit: "Who did what, and when — admin actions and gate scans",
  };
  const GROUPS: [string, string[]][] = [["Overview", ["dashboard", "reports"]], ["Sales setup", ["calendar", "tickets", "offers"]], ["Orders", ["bookings", "payments", "customers"]], ["Counter Sale", ["counter"]], ["Marketing", ["regions", "influencers"]], ["Operations", ["entry", "staff"]], ["Oversight", ["notifications", "audit"]], ["System", ["settings"]]];
  const unread = (db.notifications || []).filter((n) => !n.read).length;
  return (
    <div className="min-h-screen bg-[#F4F3EF] flex">
      {mobileNav && <div className="fixed inset-0 z-40 bg-navy-950/50 lg:hidden" onClick={() => setMobileNav(false)} />}
      <aside className={`fixed lg:sticky top-0 z-50 lg:z-10 h-dvh bg-mgm-green text-white flex flex-col transition-all ${collapsed ? "lg:w-[76px]" : "lg:w-64"} w-64 ${mobileNav ? "left-0" : "-left-64 max-lg:invisible lg:left-0"}`}>
        <div className="h-[68px] px-4 flex items-center justify-between border-b border-white/10 overflow-hidden"><div className="flex items-center gap-2.5"><Logo size={46} />{!collapsed && <div className="leading-tight"><div className="font-display text-base font-bold text-white">Ticketing</div><div className="text-[10px] uppercase tracking-widest text-white/60">Admin Console</div></div>}</div><button className="lg:hidden" onClick={() => setMobileNav(false)} aria-label="Close menu"><Icon name="x" /></button></div>
        <nav className="flex-1 overflow-y-auto py-3 px-2 no-scrollbar">
          {GROUPS.filter(([, keys]) => visible.some(([k]) => keys.includes(k))).map(([g, keys]) => (
            <div key={g} className="mb-3">
              {!collapsed ? <div className="px-3 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-[.18em] text-white/40">{g}</div> : <div className="mx-3 my-2 border-t border-white/10" />}
              {visible.filter(([k]) => keys.includes(k)).map(([k, l, i]) => (
                <button key={k} onClick={() => { setMod(k); setMobileNav(false); }} title={l} className={`relative w-full flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition ${mod === k ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"} ${collapsed ? "lg:justify-center" : ""}`}>
                  {mod === k && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-mgm-yellow pop-in" />}
                  <Icon name={i} size={18} className={mod === k ? "text-mgm-yellow" : ""} /><span className={collapsed ? "lg:hidden" : ""}>{l}</span>
                  {k === "notifications" && unread > 0 && <span className={`ml-auto rounded-full bg-mgm-red px-1.5 text-[10px] font-bold text-white ${collapsed ? "lg:hidden" : ""}`}>{unread}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <button onClick={() => setCollapsed(!collapsed)} className="hidden lg:flex items-center gap-2 m-3 rounded-xl px-3 py-2 text-xs text-white/60 hover:bg-white/10"><Icon name={collapsed ? "right" : "left"} size={16} />{!collapsed && "Collapse"}</button>
      </aside>
      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-30 h-[68px] glass border-b border-black/5 flex items-center gap-3 px-4 sm:px-6">
          <button className="lg:hidden h-10 w-10 grid place-items-center rounded-xl hover:bg-slate-100" onClick={() => setMobileNav(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <div className="flex-1 min-w-0"><h1 className="font-display text-lg sm:text-xl font-bold text-navy-950 line-clamp-2 sm:truncate leading-tight">{title}</h1><div className="hidden sm:block text-xs text-slate-500 truncate">{desc[mod]}</div></div>
          <Badge tone="amber" className="max-sm:hidden">Simulated payments</Badge>
          <div className="hidden md:flex items-center gap-2 text-xs text-slate-500"><Icon name="calendar" size={15} />Today: {fmtDate(TODAY)}</div>
          <div className="flex items-center gap-2 pl-3 border-l border-slate-200"><div className="h-9 w-9 rounded-full bg-mgm-yellow grid place-items-center font-bold text-navy-950">{me!.name.split(" ").map((x) => x[0]).join("").slice(0, 2)}</div><div className="hidden sm:block leading-tight"><div className="text-sm font-semibold text-navy-950">{me!.name}</div><div className="text-[11px] text-slate-500">{me!.roles.join(", ")}</div></div><button title="Sign out" aria-label="Sign out" className="h-9 w-9 grid place-items-center rounded-lg hover:bg-slate-100 text-slate-500" onClick={async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => undefined); setMe(null); }}><Icon name="logout" size={17} /></button></div>
        </header>
        <main className="p-4 sm:p-6 step-fwd" key={mod}>
          {visible.length === 0 && <Empty text="This account has no admin console access. Gate staff use the Staff Scanner." />}
          {allowed && mod === "dashboard" && <Dashboard go={setMod} />}
          {allowed && mod === "calendar" && <CalendarMgmt />}
          {allowed && mod === "tickets" && <TicketMgmt />}
          {allowed && mod === "offers" && <OfferMgmt />}
          {allowed && mod === "bookings" && <BookingMgmt />}
          {allowed && mod === "payments" && <PaymentMgmt />}
          {allowed && mod === "customers" && <CustomerMgmt />}
          {allowed && mod === "entry" && <EntryMgmt />}
          {allowed && mod === "reports" && <Reports />}
          {allowed && mod === "staff" && <StaffMgmt />}
          {allowed && mod === "settings" && <SettingsPage />}
          {allowed && mod === "regions" && <RegionalAnalytics />}
          {allowed && mod === "influencers" && <InfluencerModule />}
          {allowed && mod === "counter" && <CounterSale />}
          {allowed && mod === "notifications" && <NotificationsPage />}
          {allowed && mod === "audit" && <ActivityLog />}
        </main>
      </div>
    </div>
  );
}

// ---------- shared ----------
export const Card = ({ title, action, children, className = "" }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) => (
  <section className={`card-flat ${className}`}>
    {title && <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 pt-4 pb-2"><h3 className="font-bold text-navy-950">{title}</h3>{action}</div>}
    <div className={title ? "px-5 pb-5" : "p-5"}>{children}</div>
  </section>
);
export function Kpi({ label, value, icon, sub, tone = "navy" }: { label: string; value: string; icon: string; sub?: string; tone?: string; delta?: string }) {
  const t: Record<string, string> = { navy: "bg-slate-100 text-navy-950", yellow: "bg-mgm-yellow/30 text-navy-950", red: "bg-red-50 text-mgm-red", green: "bg-emerald-50 text-emerald-700", sky: "bg-slate-100 text-navy-950", amber: "bg-amber-50 text-amber-700" };
  return (
    <div className="card-flat p-4 lift">
      <div className="flex items-start justify-between gap-2"><span className="min-w-0 text-xs font-semibold text-slate-500 leading-snug break-words">{label}</span><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${t[tone]}`}><Icon name={icon} size={16} /></span></div>
      <div className="mt-2 font-display text-[26px] leading-none font-bold text-navy-950 tabular-nums"><CountUp value={value} /></div>
      {sub && <div className="mt-1.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}
export const payTone = (s: string) => ({ paid: "green", pending: "amber", failed: "red", refunded: "violet" }[s] || "slate");
const entryOf = (b: Booking) => { const used = b.tickets.filter((t) => t.status === "used").length; if (b.status === "cancelled") return { label: "Cancelled", tone: "red" }; if (used === 0) return { label: b.visitDate < TODAY ? "No-show" : "Pending", tone: b.visitDate < TODAY ? "slate" : "blue" }; if (used < b.tickets.length) return { label: `Partial ${used}/${b.tickets.length}`, tone: "amber" }; return { label: "Entered", tone: "green" }; };
const ticketTypeOf = (b: Booking) => { const f = b.tickets.some((t) => t.catId.startsWith("f")), g = b.tickets.some((t) => t.catId.startsWith("g")); return f && g ? "Mixed" : f ? "Fast Track" : "General"; };
export const Th = ({ children, className = "" }: { children?: React.ReactNode; className?: string }) => <th className={`px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500 whitespace-nowrap ${className}`}>{children}</th>;
export const Td = ({ children, className = "" }: { children?: React.ReactNode; className?: string }) => <td className={`px-4 py-3 text-sm whitespace-nowrap ${className}`}>{children}</td>;
export const Empty = ({ text }: { text: string }) => <div className="py-12 text-center text-sm text-slate-500"><Icon name="search" size={28} className="mx-auto text-slate-300 mb-2" />{text}</div>;

function useStats(db: DB) {
  return useMemo(() => {
    const paid = db.bookings.filter((b) => b.payment.status === "paid");
    const revenue = paid.reduce((s, b) => s + b.totals.total, 0);
    const ticketsSold = paid.reduce((s, b) => s + b.tickets.length, 0);
    const upcoming = paid.filter((b) => b.visitDate >= TODAY).reduce((s, b) => s + b.tickets.length, 0);
    const pending = db.bookings.filter((b) => b.payment.status === "pending").length;
    const activeOffers = db.offers.filter((o) => effectiveStatus(o) === "active").length;
    const days = datesBetween(addDays(TODAY, -29), TODAY);
    const byDay = days.map((d) => paid.filter((b) => b.createdAt.slice(0, 10) === d));
    const cat: Record<string, number> = {};
    paid.forEach((b) => b.tickets.forEach((t) => (cat[t.catId] = (cat[t.catId] || 0) + 1)));
    const offerPerf = db.offers.map((o) => ({ o, n: paid.filter((b) => b.offerIds.includes(o.id)).length, rev: paid.filter((b) => b.offerIds.includes(o.id)).reduce((s, b) => s + b.totals.total, 0) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    return { paid, revenue, ticketsSold, upcoming, pending, activeOffers, days, byDay, cat, offerPerf };
  }, [db]);
}

// ---------- Dashboard ----------
function Dashboard({ go }: { go: (m: Mod) => void }) {
  const { db } = useStore(); const s = useStats(db);
  const catData = db.tickets.map((t, i) => ({ label: t.name, value: s.cat[t.id] || 0, color: PALETTE[i % PALETTE.length] }));
  const conv = Math.round(db.bookings.length * 4.6);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 stagger">
        <Kpi label="Total bookings" value={db.bookings.length.toLocaleString("en-IN")} icon="file" sub={`${s.paid.length} paid · ${s.pending} pending`} />
        <Kpi label="Online revenue" value={inr(s.revenue)} icon="rupee" tone="yellow" sub="Paid bookings · incl. GST" />
        <Kpi label="Tickets sold" value={s.ticketsSold.toLocaleString("en-IN")} icon="ticket" tone="sky" sub={`Avg ${(s.ticketsSold / Math.max(1, s.paid.length)).toFixed(1)} per booking`} />
        <Kpi label="Upcoming visitors" value={s.upcoming.toLocaleString("en-IN")} icon="users" tone="green" sub="From today onwards" />
        <Kpi label="Active offers" value={String(s.activeOffers)} icon="tag" tone="red" sub={`${db.offers.length} offers configured`} />
        <Kpi label="Pending payments" value={String(s.pending)} icon="clock" tone="amber" sub="Awaiting confirmation" />
      </div>
      <TodayCapacity />
      <div className="grid xl:grid-cols-2 gap-5">
        <Card title="Daily booking trend" action={<span className="text-xs text-slate-400">Last 30 days</span>}>
          <LineChart labels={s.days.map(fmtShort)} series={[{ name: "Bookings", color: "#111111", values: s.byDay.map((x) => x.length) }, { name: "Tickets", color: "#CE3B37", values: s.byDay.map((x) => x.reduce((a, b) => a + b.tickets.length, 0)) }]} />
        </Card>
        <Card title="Revenue trend" action={<span className="text-xs text-slate-400">Last 30 days · incl. GST</span>}>
          <BarChart labels={s.days.map(fmtShort)} series={[{ name: "Revenue", color: "#F6CD45", values: s.byDay.map((x) => x.reduce((a, b) => a + b.totals.total, 0)) }]} fmt={inr} />
        </Card>
      </div>
      <div className="grid lg:grid-cols-3 gap-5">
        <Card title="Ticket category mix"><Donut data={catData} center={{ value: s.ticketsSold.toLocaleString("en-IN"), label: "tickets" }} /></Card>
        <Card title="Offer performance" action={<button onClick={() => go("offers")} className="text-xs font-semibold text-mgm-red">Manage</button>}>
          <HBars data={s.offerPerf.slice(0, 5).map((x) => ({ label: x.o.name, value: x.n, sub: "bookings" }))} />
        </Card>
        <Card title="Booking conversion" action={<span className="text-xs text-slate-400">Illustrative funnel</span>}>
          <Funnel steps={[{ label: "Site visits", value: conv }, { label: "Date selected", value: Math.round(conv * 0.58) }, { label: "Tickets added", value: Math.round(conv * 0.39) }, { label: "Reached payment", value: Math.round(db.bookings.length * 1.25) }, { label: "Paid", value: s.paid.length }]} />
        </Card>
      </div>
      <Card title="Recent bookings" action={<button onClick={() => go("bookings")} className="text-xs font-semibold text-mgm-red">View all</button>}>
        <div className="overflow-x-auto -mx-5"><table className="w-full"><thead className="bg-slate-50"><tr><Th>Booking</Th><Th>Customer</Th><Th>Visit</Th><Th>Tickets</Th><Th>Amount</Th><Th>Payment</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">{db.bookings.slice(0, 6).map((b) => <tr key={b.id}><Td className="font-mono font-semibold">{b.id}</Td><Td>{b.customer.name}</Td><Td>{fmtShort(b.visitDate)}</Td><Td>{b.tickets.length}</Td><Td className="font-semibold">{inr(b.totals.total)}</Td><Td><Badge tone={payTone(b.payment.status)}>{b.payment.status}</Badge></Td></tr>)}</tbody></table></div>
      </Card>
    </div>
  );
}

// Today's park operations. All four figures come from the same set of tickets, so admitted + remaining = expected.
function TodayCapacity() {
  const { db } = useStore();
  const today = db.bookings.filter((b) => b.visitDate === TODAY && b.payment.status === "paid" && b.status !== "cancelled").flatMap((b) => b.tickets.filter((t) => t.status !== "cancelled"));
  const admitted = today.filter((t) => t.status === "used").length;
  const capacity = db.dateCfg[TODAY]?.capacity ?? db.settings.defaultCapacity;
  const pct = capacity ? Math.round((today.length / capacity) * 100) : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 stagger">
      <Kpi label="Admitted today" value={admitted.toLocaleString("en-IN")} icon="checkCircle" tone="green" sub="Tickets scanned in at the gate" />
      <Kpi label="Expected today" value={today.length.toLocaleString("en-IN")} icon="users" tone="sky" sub="Paid, non-cancelled tickets for today" />
      <Kpi label="Remaining to enter" value={(today.length - admitted).toLocaleString("en-IN")} icon="clock" tone="amber" sub="Not yet scanned" />
      <Kpi label="Park capacity today" value={capacity.toLocaleString("en-IN")} icon="shield" tone="navy" sub={`${pct}% booked · set in Calendar / Settings`} />
    </div>
  );
}

// ---------- Calendar ----------
function CalendarMgmt() {
  const { db, call } = useStore(); const ctx = useCtx();
  const [month, setMonth] = useState(parseISO(TODAY).getMonth());
  const [sel, setSel] = useState(TODAY);
  const first = new Date(2026, month, 1); const days = new Date(2026, month + 1, 0).getDate(); const lead = (first.getDay() + 6) % 7;
  const bookingsOn = (d: string) => db.bookings.filter((b) => b.visitDate === d && b.payment.status === "paid");
  const cfg = db.dateCfg[sel] || {};
  const cap = cfg.capacity ?? db.settings.defaultCapacity;
  const put = (patch: Record<string, unknown>, ok: string) => call(() => api(`/api/admin/park-dates/${sel}`, { method: "PUT", body: patch }), ok);
  const [draft, setDraft] = useState({ capacity: cap, priceAdj: priceAdj(sel, ctx), note: cfg.note || "" });
  useEffect(() => { setDraft({ capacity: cap, priceAdj: priceAdj(sel, ctx), note: cfg.note || "" }); }, [sel, db.dateCfg]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = draft.capacity !== cap || draft.priceAdj !== priceAdj(sel, ctx) || draft.note !== (cfg.note || "");
  const selBookings = bookingsOn(sel);
  const visitors = selBookings.reduce((s, b) => s + b.tickets.length, 0);
  return (
    <div className="grid xl:grid-cols-[1fr_380px] gap-5">
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1"><button disabled={month <= 10} onClick={() => setMonth(month - 1)} className="h-9 w-9 grid place-items-center rounded-lg border border-slate-200 disabled:opacity-30" aria-label="Previous month"><Icon name="left" /></button><div className="w-36 text-center font-bold text-navy-950">{MONTHS[month]} 2026</div><button disabled={month >= 11} onClick={() => setMonth(month + 1)} className="h-9 w-9 grid place-items-center rounded-lg border border-slate-200 disabled:opacity-30" aria-label="Next month"><Icon name="right" /></button></div>
          <div className="hidden md:flex gap-3 text-[11px] text-slate-500"><span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />Regular</span><span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" />Weekend</span><span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-mgm-red" />Peak</span><span className="flex items-center gap-1"><span className="h-2 w-3 rounded hatch bg-slate-200" />Closed / blackout</span></div>
        </div>
        <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] font-bold uppercase text-slate-400 mb-1.5">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}</div>
        <div className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: lead }).map((_, i) => <div key={i} />)}
          {Array.from({ length: days }).map((_, i) => {
            const d = `2026-${String(month + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
            const c = db.dateCfg[d] || {}; const closed = c.enabled === false || c.blackout;
            const v = bookingsOn(d).reduce((s, b) => s + b.tickets.length, 0); const capD = c.capacity ?? db.settings.defaultCapacity;
            const tier = tierOf(d, ctx); const offers = eligibleOffers(db.offers, d).length;
            return (
              <button key={d} onClick={() => setSel(d)} className={`min-h-[86px] rounded-xl border p-1.5 sm:p-2 text-left flex flex-col transition ${sel === d ? "border-navy-950 ring-2 ring-mgm-yellow" : "border-slate-200 hover:border-slate-400"} ${closed ? "hatch bg-slate-100" : d < TODAY ? "bg-slate-50" : "bg-white"}`}>
                <div className="flex items-center justify-between"><span className={`text-sm font-bold ${d === TODAY ? "text-mgm-red" : "text-navy-950"}`}>{i + 1}</span><span className={`h-2 w-2 rounded-full ${closed ? "bg-slate-400" : tier === "peak" ? "bg-mgm-red" : tier === "weekend" ? "bg-amber-500" : "bg-emerald-500"}`} /></div>
                {closed ? <span className="mt-auto text-[10px] font-semibold text-slate-500 truncate">{c.blackout ? "Blackout" : "Closed"}</span> : (
                  <>
                    <span className="hidden sm:block text-[10px] text-slate-500 mt-1">{v}/{capD}</span>
                    <div className="mt-auto h-1 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full ${v / capD > 0.8 ? "bg-mgm-red" : "bg-navy-950"}`} style={{ width: `${Math.min(100, (v / capD) * 100 * 8)}%` }} /></div>
                    {offers > 0 && <span className="hidden sm:block text-[10px] font-semibold text-mgm-red mt-1">{offers} offer{offers > 1 ? "s" : ""}</span>}
                  </>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-slate-400">Capacity bars are scaled ×8 for visibility with demo volumes.</p>
      </Card>
      <div className="space-y-4">
        <Card title={fmtDate(sel, { weekday: "long", day: "numeric", month: "long" })} action={dateStatus(sel, db).open ? <Badge tone="green">On sale</Badge> : <Badge tone="red">{dateStatus(sel, db).reason}</Badge>}>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-4"><Toggle on={cfg.enabled !== false} onChange={(v) => put({ enabled: v }, v ? "Date enabled for booking" : "Date disabled")} label="Open for booking" /><Toggle on={!!cfg.blackout} onChange={(v) => put({ blackout: v }, v ? "Marked as blackout date" : "Blackout removed")} label="Blackout" /></div>
            <Field label="Daily ticket capacity" hint="Total admissions the park sells for this date (website + counter)"><input type="number" className={inputCls} value={draft.capacity} onChange={(e) => setDraft({ ...draft, capacity: Number(e.target.value) })} /></Field>
            <Field label="Date-specific price adjustment (%)" hint={`Default for this date: ${sel >= "2026-12-20" ? "+15% holiday" : WD[parseISO(sel).getDay()] === "Sat" || WD[parseISO(sel).getDay()] === "Sun" ? "+10% weekend" : "0% regular"}`}>
              <div className="flex gap-2"><input type="number" className={inputCls} value={draft.priceAdj} onChange={(e) => setDraft({ ...draft, priceAdj: Number(e.target.value) })} />{typeof cfg.priceAdj === "number" && <Button variant="outline" onClick={() => put({ priceAdj: null }, "Price adjustment reset to default")}>Reset</Button>}</div>
            </Field>
            <div className="flex flex-wrap gap-1.5">{[-20, -10, 0, 10, 25].map((p) => <button key={p} onClick={() => setDraft({ ...draft, priceAdj: p })} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold hover:border-navy-900">{p > 0 ? "+" : ""}{p}%</button>)}</div>
            <Field label="Note / special pricing label"><input className={inputCls} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="e.g. Diwali special" /></Field>
            <Button className="w-full" disabled={!dirty} onClick={() => put({ capacity: draft.capacity, priceAdj: draft.priceAdj, note: draft.note }, "Date settings saved")}>Save date settings</Button>
            <div className="rounded-xl bg-slate-50 p-3 text-sm space-y-1">{db.tickets.filter((t) => t.active).map((t) => <div key={t.id} className="flex justify-between"><span className="text-slate-600">{t.name}</span><span className="font-semibold">{inr(ticketPrice(t, sel, ctx))}</span></div>)}</div>
          </div>
        </Card>
        <Card title="Bookings & offers">
          <div className="grid grid-cols-2 gap-3 mb-3"><div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Bookings</div><div className="text-xl font-bold text-navy-950">{selBookings.length}</div></div><div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Visitors / capacity</div><div className="text-xl font-bold text-navy-950">{visitors}<span className="text-sm text-slate-400">/{cap}</span></div></div></div>
          <div className="text-xs font-bold uppercase text-slate-500 mb-1.5">Active offers</div>
          {eligibleOffers(db.offers, sel).map((o) => <div key={o.id} className="flex items-center gap-2 text-sm py-1"><span className="h-1.5 w-1.5 rounded-full bg-mgm-red" />{o.name}{o.coupon && <Badge>{o.coupon}</Badge>}</div>)}
          {eligibleOffers(db.offers, sel).length === 0 && <p className="text-sm text-slate-400">No offers apply.</p>}
          <div className="text-xs font-bold uppercase text-slate-500 mt-3 mb-1.5">Bookings</div>
          <div className="max-h-48 overflow-y-auto divide-y divide-slate-100">{selBookings.map((b) => <div key={b.id} className="flex justify-between py-1.5 text-sm"><span><span className="font-mono text-xs">{b.id}</span> · {b.customer.name}</span><span className="font-semibold">{b.tickets.length}</span></div>)}{selBookings.length === 0 && <p className="text-sm text-slate-400">No bookings yet.</p>}</div>
        </Card>
      </div>
    </div>
  );
}

// ---------- Tickets ----------
function TicketMgmt() {
  const { db, call } = useStore();
  const [edit, setEdit] = useState<TicketCat | null>(null);
  const put = (t: TicketCat, ok: string) => call(() => api(`/api/admin/ticket-categories/${t.id}`, { method: "PUT", body: t }), ok);
  const save = async () => { if (!edit) return; if (await put(edit, `${edit.name} saved – customer prices updated`)) setEdit(null); };
  const sold = (id: string) => db.bookings.filter((b) => b.payment.status === "paid").reduce((s, b) => s + b.tickets.filter((t) => t.catId === id).length, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-500">Base prices before GST. Date adjustments are set in Calendar Management.</p><Button icon="plus" onClick={() => setEdit({ id: "t-" + rid(4).toLowerCase(), name: "", kind: "general", audience: "adult", basePrice: 999, description: "", eligibility: "", active: true, dailyLimit: 1000, validityNote: "Valid on the selected visit date only", reEntry: false, restrictions: "" })}>New ticket category</Button></div>
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4 stagger">
        {db.tickets.map((t) => (
          <div key={t.id} className={`card-flat overflow-hidden ${t.active ? "" : "opacity-60"}`}>
            <div className={`h-2 ${t.kind === "fasttrack" ? "bg-mgm-red" : "bg-navy-950"}`} />
            <div className="p-4">
              <div className="flex items-start justify-between gap-2"><div><Badge tone={t.kind === "fasttrack" ? "red" : "navy"}>{t.kind === "fasttrack" ? "Fast Track" : "General"} · {t.audience}</Badge><h3 className="mt-2 font-bold text-navy-950">{t.name}</h3></div><Toggle on={t.active} onChange={(v) => put({ ...t, active: v }, `${t.name} ${v ? "activated" : "deactivated"}`)} /></div>
              <p className="text-xs text-slate-500 mt-1 line-clamp-2 min-h-8">{t.description}</p>
              <div className="mt-2 flex flex-wrap gap-1">{t.validityNote && <Badge tone="slate">{t.validityNote}</Badge>}<Badge tone={t.reEntry ? "green" : "slate"}>{t.reEntry ? "Re-entry allowed" : "No re-entry"}</Badge></div>
              <div className="mt-3 flex items-end justify-between"><div><div className="text-[11px] text-slate-400">Base price</div><div className="font-display text-2xl font-bold text-navy-950">{inr(t.basePrice)}</div></div><div className="text-right text-xs text-slate-500"><div>{sold(t.id)} sold</div><div>Limit {t.dailyLimit}/day</div></div></div>
              <Button size="sm" variant="outline" icon="edit" className="mt-3 w-full" onClick={() => setEdit({ ...t })}>Edit</Button>
            </div>
          </div>
        ))}
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit && db.tickets.some((t) => t.id === edit.id) ? "Edit ticket category" : "New ticket category"} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save} disabled={!edit?.name}>Save</Button></>}>
        {edit && (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><Field label="Ticket name"><input className={inputCls} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field></div>
            <Field label="Type"><Select value={edit.kind} onChange={(v) => setEdit({ ...edit, kind: v as TicketCat["kind"] })} options={[{ value: "general", label: "General" }, { value: "fasttrack", label: "Fast Track", hint: "Priority queue access" }]} /></Field>
            <Field label="Audience"><Select value={edit.audience} onChange={(v) => setEdit({ ...edit, audience: v as TicketCat["audience"] })} options={[{ value: "adult", label: "Adult", hint: "Above 140 cm" }, { value: "child", label: "Child", hint: "90 – 140 cm" }]} /></Field>
            <Field label="Base price (₹)"><input type="number" className={inputCls} value={edit.basePrice} onChange={(e) => setEdit({ ...edit, basePrice: Number(e.target.value) })} /></Field>
            <Field label="Daily availability"><input type="number" className={inputCls} value={edit.dailyLimit} onChange={(e) => setEdit({ ...edit, dailyLimit: Number(e.target.value) })} /></Field>
            <div className="col-span-2"><Field label="Description"><textarea className={inputCls + " h-20 py-2"} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field></div>
            <div className="col-span-2"><Field label="Eligibility"><input className={inputCls} value={edit.eligibility} onChange={(e) => setEdit({ ...edit, eligibility: e.target.value })} /></Field></div>
            <div className="col-span-2"><Field label="Validity period" hint="Shown to customers on the ticket card"><input className={inputCls} value={edit.validityNote || ""} placeholder="e.g. Valid on the selected visit date only" onChange={(e) => setEdit({ ...edit, validityNote: e.target.value })} /></Field></div>
            <div className="col-span-2"><Toggle on={!!edit.reEntry} onChange={(v) => setEdit({ ...edit, reEntry: v })} label="Same-day re-entry allowed" /></div>
            <div className="col-span-2"><Field label="Restrictions / conditions" hint="Optional · shown to customers"><textarea className={inputCls + " h-16 py-2"} value={edit.restrictions || ""} placeholder="e.g. Height restriction, ID required" onChange={(e) => setEdit({ ...edit, restrictions: e.target.value })} /></Field></div>
            <div className="col-span-2"><Toggle on={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Active – visible to customers" /></div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------- Offers ----------
const STATUS_TONE: Record<OfferStatus, string> = { draft: "slate", scheduled: "blue", active: "green", paused: "amber", expired: "red" };
const TYPE_LABEL: Record<OfferType, string> = { bxgy: "Buy X Get Y", percent: "Percentage", flat: "Flat discount", package: "Fixed-price package" };
const blankOffer = (): Offer => ({ id: "o-" + rid(5).toLowerCase(), name: "", description: "", theme: "sunset", type: "percent", categories: ["ga"], bookingStart: TODAY, bookingEnd: MAX_DATE, visitStart: TODAY, visitEnd: MAX_DATE, weekdays: [], dates: [], minQty: 1, value: 10, buyX: 3, getY: 1, packagePrice: 2999, packageContents: { ga: 2, gc: 1 }, maxRedemptions: 500, redemptions: 0, coupon: "", terms: "", priority: 5, status: "draft", featured: false, requiresId: "" });

function OfferMgmt() {
  const { db, call } = useStore();
  const [filter, setFilter] = useState<"all" | OfferStatus>("all");
  const [edit, setEdit] = useState<Offer | null>(null);
  const [del, setDel] = useState<Offer | null>(null);
  const list = db.offers.filter((o) => filter === "all" || effectiveStatus(o) === filter).sort((a, b) => a.priority - b.priority);
  const setStatus = (o: Offer, s: OfferStatus) => call(() => api(`/api/admin/offers/${o.id}`, { method: "PUT", body: { ...o, status: s } }), `${o.name} is now ${s}`);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">{(["all", "active", "scheduled", "paused", "draft", "expired"] as const).map((f) => <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3.5 py-1.5 text-xs font-semibold capitalize transition ${filter === f ? "bg-navy-950 text-white shadow" : "bg-white ring-1 ring-black/5 text-slate-600 hover:bg-slate-50"}`}>{f} <span className="opacity-60">{f === "all" ? db.offers.length : db.offers.filter((o) => effectiveStatus(o) === f).length}</span></button>)}</div>
        <Button icon="plus" onClick={() => setEdit(blankOffer())}>Create offer</Button>
      </div>
      <div className="card-flat overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50"><tr><Th>Offer</Th><Th>Type</Th><Th>Validity</Th><Th>Applicable ticket</Th><Th>Redemptions</Th><Th>Status</Th><Th className="text-right">Actions</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((o) => {
                const st = effectiveStatus(o);
                return (
                  <tr key={o.id} className="hover:bg-slate-50/60 transition-colors">
                    <Td><div className="flex items-center gap-3"><OfferArt theme={o.theme} type={o.type} image={o.image} className="h-9 w-9 rounded-lg shrink-0 [&>div]:hidden" /><div><div className="font-semibold text-navy-950 flex items-center gap-1.5">{o.name}{o.featured && <Icon name="star" size={13} className="text-mgm-yellow" />}</div><div className="text-xs text-slate-500">{o.coupon ? <span className="font-mono font-bold text-mgm-red">{o.coupon}</span> : "Offer ticket"} · priority {o.priority}</div></div></div></Td>
                    <Td>{TYPE_LABEL[o.type]}<div className="text-xs text-slate-500">{o.type === "percent" ? `${o.value}% off` : o.type === "flat" ? `${inr(o.value)} off` : o.type === "bxgy" ? `Buy ${o.buyX} get ${o.getY}` : inr(o.packagePrice)}</div></Td>
                    <Td className="text-xs text-slate-600 !whitespace-normal"><div className="w-36">{validityText(o)}</div></Td>
                    <Td className="text-xs !whitespace-normal"><div className="w-32">{o.categories.map((c) => db.tickets.find((t) => t.id === c)?.name).join(", ")}</div></Td>
                    <Td><div className="text-sm font-semibold">{o.redemptions}<span className="text-slate-400 font-normal">/{o.maxRedemptions}</span></div><div className="mt-1 h-1.5 w-20 rounded-full bg-slate-100"><div className="h-full rounded-full bg-mgm-red" style={{ width: `${Math.min(100, (o.redemptions / o.maxRedemptions) * 100)}%` }} /></div></Td>
                    <Td><Badge tone={STATUS_TONE[st]}>{st}</Badge></Td>
                    <Td className="text-right">
                      <div className="inline-flex gap-1">
                        {st === "active" || st === "scheduled" ? <button title="Pause" onClick={() => setStatus(o, "paused")} className="h-8 w-8 grid place-items-center rounded-lg hover:bg-amber-50 text-amber-600"><Icon name="pause" size={15} /></button>
                          : st !== "expired" ? <button title="Publish / activate" onClick={() => setStatus(o, "active")} className="h-8 w-8 grid place-items-center rounded-lg hover:bg-emerald-50 text-emerald-600"><Icon name="play" size={15} /></button> : null}
                        <button title="Edit" onClick={() => setEdit(JSON.parse(JSON.stringify(o)))} className="h-8 w-8 grid place-items-center rounded-lg hover:bg-slate-100"><Icon name="edit" size={15} /></button>
                        <button title="Delete" onClick={() => setDel(o)} className="h-8 w-8 grid place-items-center rounded-lg hover:bg-red-50 text-red-600"><Icon name="trash" size={15} /></button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.length === 0 && <Empty text="No offers with this status." />}
        </div>
      </div>
      {edit && <OfferForm offer={edit} onClose={() => setEdit(null)} />}
      <Modal open={!!del} onClose={() => setDel(null)} title="Delete offer?" footer={<><Button variant="ghost" onClick={() => setDel(null)}>Cancel</Button><Button variant="danger" icon="trash" onClick={async () => { await call(() => api(`/api/admin/offers/${del!.id}`, { method: "DELETE" }), `${del!.name} deleted`); setDel(null); }}>Delete</Button></>}>
        <p className="text-sm text-slate-600"><b>{del?.name}</b> will be removed from the customer booking site immediately. Existing bookings keep their discount.</p>
      </Modal>
    </div>
  );
}

function OfferForm({ offer, onClose }: { offer: Offer; onClose: () => void }) {
  const { db, call, refresh } = useStore(); const ctx = useCtx();
  const [o, setO] = useState<Offer>(offer);
  const [err, setErr] = useState("");
  // optional banner image: chosen locally (previewed), uploaded after the offer itself is saved
  const [img, setImg] = useState<{ file: File | null; preview?: string; removed: boolean; error?: string }>({ file: null, removed: false });
  const fileRef = useRef<HTMLInputElement>(null);
  const shownImg = img.preview ?? (img.removed ? undefined : o.image);
  const pickImage = (f?: File) => {
    if (!f) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) return setImg((s) => ({ ...s, error: "Choose a JPEG, PNG or WebP image." }));
    if (f.size > 2 * 1024 * 1024) return setImg((s) => ({ ...s, error: "This image is larger than 2 MB." }));
    if (img.preview) URL.revokeObjectURL(img.preview);
    setImg({ file: f, preview: URL.createObjectURL(f), removed: false });
  };
  const removeImage = () => { if (img.preview) URL.revokeObjectURL(img.preview); setImg({ file: null, removed: true }); if (fileRef.current) fileRef.current.value = ""; };
  const isNew = !db.offers.some((x) => x.id === offer.id);
  const set = <K extends keyof Offer>(k: K, v: Offer[K]) => setO((p) => ({ ...p, [k]: v }));
  const toggleArr = (arr: (string | number)[], v: string | number) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const preview = datesBetween(o.visitStart < MIN_DATE ? MIN_DATE : o.visitStart, o.visitEnd > MAX_DATE ? MAX_DATE : o.visitEnd).filter((d) => (!o.weekdays.length || o.weekdays.includes(parseISO(d).getDay())) && (!o.dates.length || o.dates.includes(d)));
  const sampleDate = preview.find((d) => d >= TODAY) || preview[0] || TODAY;
  const u = offerUnit(o, sampleDate, ctx);
  const save = (status?: OfferStatus) => {
    const final = { ...o, status: status || o.status, coupon: o.coupon.trim().toUpperCase() };
    if (!final.name.trim()) return setErr("Offer name is required.");
    if (!final.categories.length && final.type !== "package") return setErr("Choose at least one applicable ticket category.");
    if (final.visitEnd < final.visitStart || final.bookingEnd < final.bookingStart) return setErr("End dates must be after start dates.");
    if (final.coupon && db.offers.some((x) => x.id !== final.id && x.coupon.toUpperCase() === final.coupon)) return setErr("Another offer already uses this coupon code.");
    if (final.type === "package" && !Object.values(final.packageContents).some((q) => q > 0)) return setErr("Add at least one ticket to the package.");
    void (async () => {
      const r = await call(() => api(`/api/admin/offers/${final.id}`, { method: "PUT", body: final }), status === "active" ? `${final.name} published – live on matching dates` : `${final.name} saved`);
      if (!r) return;
      try {
        if (img.file) await uploadFile(`/api/admin/offers/${final.id}/image`, img.file);
        else if (img.removed && offer.image) await api(`/api/admin/offers/${final.id}/image`, { method: "DELETE" });
      } catch (e) {
        setErr(`Offer saved, but the image ${img.file ? "upload" : "removal"} failed: ${(e as Error).message}`);
        await refresh().catch(() => undefined);
        return;
      }
      if (img.file || img.removed) await refresh().catch(() => undefined);
      onClose();
    })();
  };
  const months: [number, string][] = [[10, "Nov"], [11, "Dec"]];
  return (
    <Modal open wide onClose={onClose} title={isNew ? "Create offer" : `Edit · ${offer.name}`}
      footer={<>{err && <span className="mr-auto self-center text-sm font-medium text-red-600">{err}</span>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="outline" onClick={() => save("draft")}>Save as draft</Button>{!isNew && o.status !== "draft" && <Button variant="dark" onClick={() => save()}>Save changes</Button>}<Button onClick={() => save("active")} icon="zap">Publish offer</Button></>}>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-6">
        <div className="space-y-5">
          <FormSection title="Basics">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2"><Field label="Offer name *"><input className={inputCls} value={o.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Diwali Family Bonanza" /></Field></div>
              <div className="sm:col-span-2"><Field label="Offer description"><textarea className={inputCls + " h-16 py-2"} value={o.description} onChange={(e) => set("description", e.target.value)} /></Field></div>
              <Field label="Offer type"><Select value={o.type} onChange={(v) => set("type", v as OfferType)} options={[{ value: "percent", label: TYPE_LABEL.percent, hint: "e.g. 25% off a ticket" }, { value: "flat", label: TYPE_LABEL.flat, hint: "e.g. ₹250 off per ticket" }, { value: "bxgy", label: TYPE_LABEL.bxgy, hint: "e.g. buy 4, get 2 free" }, { value: "package", label: TYPE_LABEL.package, hint: "e.g. 2 adults + 2 kids for ₹3,499" }]} /></Field>
              <Field label="Status"><Select value={o.status} onChange={(v) => set("status", v as OfferStatus)} options={[{ value: "draft", label: "Draft", dot: "#A0A0A0" }, { value: "scheduled", label: "Scheduled", dot: "#0EA5E9" }, { value: "active", label: "Active", dot: "#10B981" }, { value: "paused", label: "Paused", dot: "#F59E0B" }, { value: "expired", label: "Expired", dot: "#CE3B37" }]} /></Field>
              <Field label="Banner theme"><div className="flex gap-1.5 flex-wrap">{Object.entries(THEMES).map(([k, t]) => <button key={k} type="button" title={t.label} onClick={() => set("theme", k)} className={`h-9 w-9 rounded-lg ${o.theme === k ? "ring-2 ring-offset-2 ring-navy-950" : ""}`} style={{ background: t.bg }} />)}</div></Field>
              <div className="sm:col-span-2"><Field label="Offer image (optional)" error={img.error} hint="JPEG, PNG or WebP, up to 2 MB. Shown on the customer's offer card instead of the theme pattern.">
                <div className="flex flex-wrap items-center gap-3">
                  {shownImg ? <img src={shownImg.startsWith("/") ? API + shownImg : shownImg} alt="Offer image preview" className="h-16 w-28 rounded-lg object-cover border border-slate-200" />
                    : <div className="h-16 w-28 rounded-lg border border-dashed border-slate-300 grid place-items-center text-xs text-slate-400">No image</div>}
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Offer image file" onChange={(e) => pickImage(e.target.files?.[0])} />
                  <Button type="button" variant="outline" icon="upload" onClick={() => fileRef.current?.click()}>{shownImg ? "Replace image" : "Upload image"}</Button>
                  {shownImg && <Button type="button" variant="ghost" icon="trash" onClick={removeImage}>Remove</Button>}
                </div>
              </Field></div>
              <div className="flex items-end gap-4"><Field label="Priority (1 = top)"><input type="number" min={1} className={inputCls + " w-24"} value={o.priority} onChange={(e) => set("priority", Number(e.target.value))} /></Field><div className="pb-2"><Toggle on={o.featured} onChange={(v) => set("featured", v)} label="Featured" /></div></div>
            </div>
          </FormSection>
          <FormSection title="Benefit">
            <div className="grid sm:grid-cols-3 gap-3">
              {o.type === "percent" && <Field label="Discount %"><input type="number" className={inputCls} value={o.value} onChange={(e) => set("value", Number(e.target.value))} /></Field>}
              {o.type === "flat" && <Field label="Discount amount (₹ per ticket)"><input type="number" className={inputCls} value={o.value} onChange={(e) => set("value", Number(e.target.value))} /></Field>}
              {o.type === "bxgy" && <><Field label="Buy X quantity"><input type="number" className={inputCls} value={o.buyX} onChange={(e) => set("buyX", Number(e.target.value))} /></Field><Field label="Get Y free"><input type="number" className={inputCls} value={o.getY} onChange={(e) => set("getY", Number(e.target.value))} /></Field></>}
              {o.type === "package" && <Field label="Package price (₹)"><input type="number" className={inputCls} value={o.packagePrice} onChange={(e) => set("packagePrice", Number(e.target.value))} /></Field>}
              <Field label="Minimum ticket quantity"><input type="number" min={1} className={inputCls} value={o.minQty} onChange={(e) => set("minQty", Number(e.target.value))} /></Field>
              <Field label="Maximum redemptions"><input type="number" className={inputCls} value={o.maxRedemptions} onChange={(e) => set("maxRedemptions", Number(e.target.value))} /></Field>
              <Field label="Coupon code (optional)" hint="If set, customers apply it as a code"><input className={inputCls + " uppercase font-mono"} value={o.coupon} onChange={(e) => set("coupon", e.target.value.toUpperCase().replace(/\s/g, ""))} placeholder="e.g. DIWALI20" /></Field>
              <div className="sm:col-span-2"><Field label="ID required at gate (optional)"><input className={inputCls} value={o.requiresId} onChange={(e) => set("requiresId", e.target.value)} placeholder="e.g. Valid student ID" /></Field></div>
            </div>
            <div className="mt-3">
              <div className="text-xs font-semibold text-slate-600 mb-1.5">{o.type === "package" ? "Package contents" : "Applicable ticket categories"}</div>
              <div className="grid sm:grid-cols-2 gap-2">
                {db.tickets.map((t) => o.type === "package" ? (
                  <div key={t.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2 text-sm"><span>{t.name}</span><input type="number" min={0} className="w-16 h-8 rounded-lg border border-slate-200 px-2" value={o.packageContents[t.id] || 0} onChange={(e) => { const q = Number(e.target.value); setO((p) => ({ ...p, packageContents: { ...p.packageContents, [t.id]: q }, categories: Object.entries({ ...p.packageContents, [t.id]: q }).filter(([, n]) => n > 0).map(([k]) => k) })); }} /></div>
                ) : (
                  <label key={t.id} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm cursor-pointer ${o.categories.includes(t.id) ? "border-navy-950 bg-navy-950/5" : "border-slate-200"}`}><input type="checkbox" checked={o.categories.includes(t.id)} onChange={() => set("categories", toggleArr(o.categories, t.id) as string[])} />{t.name}</label>
                ))}
              </div>
              {(o.type === "bxgy" || (!o.coupon && (o.type === "percent" || o.type === "flat"))) && o.categories.length > 1 && <p className="text-xs text-amber-700 mt-1.5">Offer tickets use the first selected category ({db.tickets.find((t) => t.id === o.categories[0])?.name}). Coupons apply to all selected.</p>}
            </div>
          </FormSection>
          <FormSection title="Validity">
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Booking start date"><DateInput value={o.bookingStart} onChange={(v) => set("bookingStart", v)} max={MAX_DATE} /></Field>
              <Field label="Booking end date"><DateInput value={o.bookingEnd} onChange={(v) => set("bookingEnd", v)} min={o.bookingStart} max={MAX_DATE} /></Field>
              <Field label="Visit start date"><DateInput value={o.visitStart} onChange={(v) => set("visitStart", v)} min={MIN_DATE} max={MAX_DATE} /></Field>
              <Field label="Visit end date"><DateInput value={o.visitEnd} onChange={(v) => set("visitEnd", v)} min={o.visitStart > MIN_DATE ? o.visitStart : MIN_DATE} max={MAX_DATE} /></Field>
            </div>
            <div className="mt-3"><div className="text-xs font-semibold text-slate-600 mb-1.5">Applicable weekdays <span className="font-normal text-slate-400">(none = all days)</span></div>
              <div className="flex flex-wrap gap-1.5">{[1, 2, 3, 4, 5, 6, 0].map((w) => <button key={w} type="button" onClick={() => set("weekdays", toggleArr(o.weekdays, w) as number[])} className={`h-9 w-12 rounded-lg text-xs font-bold ${o.weekdays.includes(w) ? "bg-navy-950 text-white" : "bg-slate-100 text-slate-600"}`}>{WD[w]}</button>)}
                <button type="button" onClick={() => set("weekdays", [0, 6])} className="h-9 px-3 rounded-lg text-xs font-semibold border border-slate-200">Weekends</button><button type="button" onClick={() => set("weekdays", [1, 2, 3, 4, 5])} className="h-9 px-3 rounded-lg text-xs font-semibold border border-slate-200">Weekdays</button><button type="button" onClick={() => set("weekdays", [])} className="h-9 px-3 rounded-lg text-xs font-semibold border border-slate-200">Clear</button></div>
            </div>
            <div className="mt-3"><div className="text-xs font-semibold text-slate-600 mb-1.5">Individual applicable dates <span className="font-normal text-slate-400">(optional – limits the offer to these dates only)</span></div>
              <div className="grid sm:grid-cols-2 gap-3">
                {months.map(([m, name]) => {
                  const nd = new Date(2026, m + 1, 0).getDate(); const ld = (new Date(2026, m, 1).getDay() + 6) % 7;
                  return (
                    <div key={m} className="rounded-xl border border-slate-200 p-2"><div className="text-xs font-bold text-center mb-1">{name} 2026</div>
                      <div className="grid grid-cols-7 gap-0.5">{Array.from({ length: ld }).map((_, i) => <span key={i} />)}{Array.from({ length: nd }).map((_, i) => { const d = `2026-${m + 1}-${String(i + 1).padStart(2, "0")}`; const on = o.dates.includes(d); return <button type="button" key={d} onClick={() => set("dates", toggleArr(o.dates, d) as string[])} className={`h-7 rounded text-[11px] font-semibold ${on ? "bg-mgm-red text-white" : "hover:bg-slate-100 text-slate-600"}`}>{i + 1}</button>; })}</div>
                    </div>
                  );
                })}
              </div>
              {o.dates.length > 0 && <button type="button" onClick={() => set("dates", [])} className="mt-1 text-xs font-semibold text-mgm-red">Clear {o.dates.length} selected dates</button>}
            </div>
          </FormSection>
          <FormSection title="Terms & conditions"><textarea className={inputCls + " h-24 py-2"} value={o.terms} onChange={(e) => set("terms", e.target.value)} placeholder="One condition per line" /></FormSection>
        </div>
        <div className="lg:sticky lg:top-0 self-start space-y-3">
          <div className="text-xs font-bold uppercase text-slate-500">Customer preview</div>
          <div className="rounded-2xl border border-slate-200 overflow-hidden">
            <OfferArt theme={o.theme} type={o.type} image={shownImg} className="h-28" />
            <div className="p-3"><div className="font-bold text-navy-950">{o.name || "Offer name"}</div><div className="text-xs text-slate-500 line-clamp-2">{o.description || "Description"}</div>
              {o.coupon ? <div className="mt-2 rounded-lg border-2 border-dashed border-mgm-red/40 px-2 py-1 font-mono font-bold text-mgm-red text-sm inline-block">{o.coupon}</div> : u && <div className="mt-2 flex items-baseline gap-2"><span className="font-display text-xl font-bold">{inr(u.price)}</span>{u.original > u.price && <span className="text-xs line-through text-slate-400">{inr(u.original)}</span>}</div>}
              {u && !o.coupon && <div className="text-[11px] text-slate-500">{u.label} · {u.benefit}</div>}
            </div>
          </div>
          <div className="rounded-2xl bg-slate-50 p-3 text-xs"><div className="font-bold text-navy-950 mb-1">Shows on {preview.length} visit dates</div><div className="text-slate-500 leading-relaxed">{preview.slice(0, 14).map(fmtShort).join(", ")}{preview.length > 14 ? ` +${preview.length - 14} more` : ""}</div>{!preview.length && <div className="text-red-600">No dates match – check weekdays/dates.</div>}</div>
          <p className="text-[11px] text-slate-400">Published offers appear instantly in the customer booking site for matching dates.</p>
        </div>
      </div>
    </Modal>
  );
}
const FormSection = ({ title, children }: { title: string; children: React.ReactNode }) => <div><div className="text-sm font-bold text-navy-950 mb-2 pb-1 border-b border-slate-100">{title}</div>{children}</div>;

// ---------- Bookings ----------
function BookingMgmt() {
  const { db, call, toast } = useStore();
  const [q, setQ] = useState(""); const [pay, setPay] = useState("all"); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [view, setView] = useState<Booking | null>(null); const [exp, setExp] = useState("");
  const [modify, setModify] = useState<Booking | null>(null);
  const [page, setPage] = useState(0);
  const rows = db.bookings.filter((b) => (pay === "all" || b.payment.status === pay) && (!from || b.visitDate >= from) && (!to || b.visitDate <= to) &&
    (!q || [b.id, b.customer.name, b.customer.phone, b.customer.email, ...b.tickets.map((t) => t.id)].join(" ").toLowerCase().includes(q.toLowerCase())));
  const per = 15; const pageRows = rows.slice(page * per, page * per + per);
  const exportCsv = async () => {
    const csv = ["Booking ID,Customer,Phone,Visit Date,Ticket Type,Tickets,Offer,Total,Payment,Entry", ...rows.map((b) => [b.id, b.customer.name, b.customer.phone, b.visitDate, ticketTypeOf(b), b.tickets.length, b.offerIds.map((id) => db.offers.find((o) => o.id === id)?.name || id).join(" + "), b.totals.total, b.payment.status, entryOf(b).label].join(","))].join("\n");
    if (await copyText(csv)) toast(`${rows.length} bookings copied as CSV`); else setExp(csv);
    setExp(csv);
  };
  const live = view ? db.bookings.find((b) => b.id === view.id) || view : null;
  return (
    <div className="space-y-4">
      <div className="card-flat p-3 flex flex-wrap gap-2 items-end">
        <div className="relative flex-1 min-w-56"><Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className={inputCls + " pl-9"} placeholder="Search booking ID, name, phone, ticket ID…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} /></div>
        <Field label="Visit from"><DateInput value={from} onChange={(v) => { setFrom(v); setPage(0); }} min={MIN_DATE} max={MAX_DATE} placeholder="Any date" clearable /></Field>
        <Field label="Visit to"><DateInput value={to} onChange={(v) => { setTo(v); setPage(0); }} min={from || MIN_DATE} max={MAX_DATE} placeholder="Any date" clearable /></Field>
        <Field label="Payment"><Select value={pay} onChange={(v) => { setPay(v); setPage(0); }} options={[{ value: "all", label: "All payments" }, { value: "paid", label: "Paid", dot: "#10B981" }, { value: "pending", label: "Pending", dot: "#F59E0B" }, { value: "failed", label: "Failed", dot: "#CE3B37" }, { value: "refunded", label: "Refunded", dot: "#8B5CF6" }]} /></Field>
        <Button variant="outline" icon="download" onClick={exportCsv}>Export</Button>
      </div>
      <div className="card-flat overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full">
          <thead className="bg-slate-50"><tr><Th>Booking ID</Th><Th>Customer</Th><Th>Visit date</Th><Th>Ticket type</Th><Th>Qty</Th><Th>Offer applied</Th><Th>Total</Th><Th>Payment</Th><Th>Entry</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">{pageRows.map((b) => { const e = entryOf(b); return (
            <tr key={b.id} className="hover:bg-mgm-yellow/10 cursor-pointer transition-colors" onClick={() => setView(b)}>
              <Td className="font-mono font-semibold text-navy-950">{b.id}</Td><Td><div className="font-medium">{b.customer.name}</div><div className="text-xs text-slate-400">{b.customer.phone}</div></Td><Td>{fmtDate(b.visitDate, { day: "numeric", month: "short" })}</Td>
              <Td>{ticketTypeOf(b)}</Td><Td>{b.tickets.length}</Td><Td className="text-xs max-w-40 truncate">{b.offerIds.length ? b.offerIds.map((id) => db.offers.find((o) => o.id === id)?.name || id).join(", ") : <span className="text-slate-300">—</span>}</Td>
              <Td className="font-semibold">{inr(b.totals.total)}</Td><Td><Badge tone={payTone(b.payment.status)}>{b.payment.status}</Badge></Td><Td><Badge tone={e.tone}>{e.label}</Badge></Td>
            </tr>); })}</tbody>
        </table>{rows.length === 0 && <Empty text="No bookings match these filters." />}</div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-sm text-slate-500"><span>{rows.length} bookings</span><div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)} icon="left" /><span>{page + 1} / {Math.max(1, Math.ceil(rows.length / per))}</span><Button size="sm" variant="outline" disabled={(page + 1) * per >= rows.length} onClick={() => setPage(page + 1)} icon="right" /></div></div>
      </div>
      <Modal open={!!live} wide onClose={() => setView(null)} title={live ? `Booking ${live.id}` : ""}
        footer={live && live.status !== "cancelled" && live.payment.status === "paid" ? <>
          <Button variant="outline" icon="edit" onClick={() => setModify(live)}>Modify booking</Button>
          <Button variant="danger" icon="refresh" onClick={() => { const fee = Math.round(live.totals.total * db.settings.cancellationFeePct / 100); if (!window.confirm(`Cancel ${live.id} and refund ${inr(live.totals.total - fee)} (${db.settings.cancellationFeePct}% fee)? This can't be undone.`)) return; void call(() => api(`/api/admin/bookings/${live.id}/cancel`, { method: "POST" }), "Booking cancelled · refund recorded (simulated provider)"); }}>Cancel & refund</Button>
        </> : undefined}>
        {live && (
          <div className="grid md:grid-cols-2 gap-5 text-sm">
            <div className="space-y-3">
              <div className="rounded-xl bg-slate-50 p-3"><div className="font-bold text-navy-950">{live.customer.name}</div><div className="text-slate-500">+91 {live.customer.phone} · {live.customer.email}</div>{live.customer.notes && <div className="text-xs mt-1">Note: {live.customer.notes}</div>}</div>
              <div className="grid grid-cols-2 gap-2"><Info k="Visit date" v={fmtDate(live.visitDate)} /><Info k="Booked on" v={fmtTime(live.createdAt)} /><Info k="Payment" v={<Badge tone={payTone(live.payment.status)}>{live.payment.status}</Badge>} /><Info k="Entry" v={<Badge tone={entryOf(live).tone}>{entryOf(live).label}</Badge>} /></div>
              <div><div className="font-bold mb-1">Items</div>{live.items.map((i) => <div key={i.label} className="flex justify-between py-0.5"><span>{i.qty}× {i.label}</span><span>{inr(i.amount)}</span></div>)}
                <div className="border-t border-slate-100 mt-2 pt-2 space-y-0.5"><div className="flex justify-between text-emerald-700"><span>Discounts</span><span>– {inr(live.totals.discount)}</span></div><div className="flex justify-between"><span>GST</span><span>{inr(live.totals.tax)}</span></div><div className="flex justify-between font-bold"><span>Total</span><span>{inr(live.totals.total)}</span></div></div></div>
              <div className="rounded-xl border border-slate-200 p-3"><div className="font-bold mb-1">Cancellation / refund</div><RefundStatus b={live} />
                {live.modifications?.length ? <div className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-500">{live.modifications.map((m) => <div key={m.at}>Modified {fmtTime(m.at)}: {fmtShort(m.previousVisitDate)} → {fmtShort(m.visitDate)}, {inr(m.previousTotal)} → {inr(m.newTotal)}</div>)}</div> : null}</div>
            </div>
            <div><div className="font-bold mb-2">Tickets &amp; QR references</div>
              <div className="space-y-2 max-h-96 overflow-y-auto">{live.tickets.map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-2"><QR text={t.qr || t.id} size={56} /><div className="min-w-0 flex-1"><div className="font-mono font-semibold text-xs">{t.id}</div><div className="text-xs text-slate-500">{t.label}{t.complimentary ? " · free" : ""}</div><div className="text-[10px] text-slate-400 font-mono truncate">{t.status === "used" && t.gate ? `Used at ${t.gate}` : ""}</div></div><Badge tone={t.status === "used" ? "slate" : t.status === "valid" ? "green" : "red"}>{t.status}</Badge></div>
              ))}</div>
            </div>
          </div>
        )}
      </Modal>
      {modify && <ModifyBookingModal booking={modify} onClose={() => setModify(null)} />}
      <Modal open={!!exp} onClose={() => setExp("")} title="Export booking data (CSV)"><p className="text-sm text-slate-500 mb-2">Downloads are disabled in this preview. Copy the sample CSV below:</p><textarea readOnly className="w-full h-64 rounded-xl border border-slate-200 p-2 font-mono text-[11px]" value={exp} onFocus={(e) => e.target.select()} /></Modal>
    </div>
  );
}
const Info = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="rounded-xl bg-slate-50 p-2.5"><div className="text-[11px] text-slate-500">{k}</div><div className="font-semibold text-navy-950">{v}</div></div>;

function RefundStatus({ b }: { b: Booking }) {
  const { db } = useStore();
  const r = b.refund;
  if (!r) return <div className="text-slate-500">Regular tickets: cancellable up to {db.settings.cancelNoticeDays * 24} hrs before visit with {db.settings.cancellationFeePct}% fee. Offer tickets: non-refundable.</div>;
  if (r.status === "pending") return <div><Badge tone="amber">Cancellation requested · pending review</Badge><div className="mt-1 text-slate-600">Indicative refund {inr(r.amount)} (fee {inr(r.deduction || 0)}) · approve or reject under Payment Management → Pending refund requests.</div></div>;
  if (r.status === "rejected") return <div className="text-red-700">Rejected · {r.rejectionReason} · {fmtTime(r.rejectedAt || r.at)}</div>;
  return <div className="text-violet-700">Refund {inr(r.amount)} approved {fmtTime(r.approvedAt || r.at)} · {r.reason}{(b.refunds || []).map((x) => <div key={x.id} className="text-xs text-slate-500">Refund #{x.id}: {inr(x.amount)} · {x.status}</div>)}</div>;
}

function RefundRequests() {
  const { db, call } = useStore();
  const [reject, setReject] = useState<Booking | null>(null); const [reason, setReason] = useState("");
  const pending = db.bookings.filter((b) => b.refund?.status === "pending");
  return (
    <div className="card-flat overflow-hidden">
      <div className="p-3 font-bold text-navy-950 flex items-center gap-2">Pending refund requests {pending.length > 0 && <Badge tone="amber">{pending.length}</Badge>}</div>
      {pending.length === 0 ? <div className="px-4 pb-4 text-sm text-slate-500">No pending refund requests.</div> : (
        <div className="overflow-x-auto"><table className="w-full"><thead className="bg-slate-50"><tr><Th>Booking</Th><Th>Customer</Th><Th>Visit date</Th><Th>Requested</Th><Th>Paid</Th><Th>Fee</Th><Th>Refund</Th><Th /></tr></thead>
          <tbody className="divide-y divide-slate-100">{pending.map((b) => (
            <tr key={b.id}><Td className="font-mono text-xs font-semibold">{b.id}</Td><Td>{b.customer.name}</Td><Td>{fmtShort(b.visitDate)}</Td><Td className="text-xs">{fmtTime(b.refund!.requestedAt || b.refund!.at)}</Td><Td>{inr(b.totals.total)}</Td><Td>{inr(b.refund!.deduction || 0)}</Td><Td className="font-semibold">{inr(b.refund!.amount)}</Td>
              <Td><div className="flex gap-1.5">
                <Button size="sm" onClick={() => { if (!window.confirm(`Approve refund of ${inr(b.refund!.amount)} for ${b.id}? Its tickets will be cancelled.`)) return; void call(() => api(`/api/admin/bookings/${b.id}/cancellation/approve`, { method: "POST" }), "Refund approved (simulated provider – no money moved)"); }}>Approve</Button>
                <Button size="sm" variant="outline" onClick={() => { setReason(""); setReject(b); }}>Reject</Button>
              </div></Td></tr>))}</tbody></table></div>)}
      <Modal open={!!reject} onClose={() => setReject(null)} title={`Reject cancellation ${reject?.id || ""}`}
        footer={<><Button variant="ghost" onClick={() => setReject(null)}>Back</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={async () => { const id = reject!.id; if (await call(() => api(`/api/admin/bookings/${id}/cancellation/reject`, { method: "POST", body: { reason } }), "Cancellation request rejected")) setReject(null); }}>Reject request</Button></>}>
        <p className="text-sm text-slate-500 mb-3">The booking stays valid. The reason is shown to the customer in their booking.</p>
        <Field label="Reason"><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Request received less than 48 hours before the visit" autoFocus /></Field>
      </Modal>
    </div>
  );
}

function ModifyBookingModal({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const { db, call, toast } = useStore();
  const [date, setDate] = useState(booking.visitDate);
  const [qty, setQty] = useState<Record<string, number>>(() => { const m: Record<string, number> = {}; booking.tickets.forEach((t) => { if (t.status !== "cancelled") m[t.catId] = (m[t.catId] || 0) + 1; }); return m; });
  const [addons, setAddons] = useState<Record<string, number>>(() => Object.fromEntries(booking.items.filter((i) => i.kind === "addon").map((i) => [i.refId, i.qty])));
  const elig = modificationEligibility(booking, db);
  const ds = dateStatus(date, db);
  const pr = priceCart({ tickets: qty, offers: {}, addons, coupon: "" }, date, { tickets: db.tickets, offers: db.offers, dateCfg: db.dateCfg, settings: db.settings }, TODAY, db.addons);
  const diff = pr.total - booking.totals.total;
  const Stepper = ({ v, set }: { v: number; set: (n: number) => void }) => <div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => set(Math.max(0, v - 1))} aria-label="Decrease">−</Button><span className="w-6 text-center tabular-nums">{v}</span><Button size="sm" variant="outline" onClick={() => set(v + 1)} aria-label="Increase">+</Button></div>;
  const save = async () => {
    // The server re-prices, moves inventory, keeps existing ticket codes and records the difference to settle.
    const r = await call(() => api<{ difference: number; settlement: string }>(`/api/admin/bookings/${booking.id}/modify`, { method: "POST", body: { visit_date: date, tickets: qty, addons } }));
    if (!r) return;
    toast(`Booking ${booking.id} updated${r.difference ? ` · ${r.difference > 0 ? "collect" : "refund"} ${inr(Math.abs(r.difference))} (see Payment Management)` : ""}`);
    onClose();
  };
  return (
    <Modal open wide onClose={onClose} title={`Modify booking ${booking.id}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!elig.ok || !ds.open || pr.ticketCount === 0} onClick={save}>Save · {inr(pr.total)}</Button></>}>
      {!elig.ok ? <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">{elig.reason}</div> : (
        <div className="grid md:grid-cols-2 gap-5 text-sm">
          <div className="space-y-4">
            <Field label="Visit date" error={ds.open ? undefined : ds.reason}><DateInput value={date} onChange={setDate} min={TODAY} max={MAX_DATE} /></Field>
            <div><div className="font-bold mb-2">Tickets</div>{db.tickets.filter((t) => t.active || qty[t.id]).map((t) => <div key={t.id} className="flex items-center justify-between py-1"><span>{t.name}</span><Stepper v={qty[t.id] || 0} set={(n) => setQty({ ...qty, [t.id]: n })} /></div>)}</div>
            <div><div className="font-bold mb-2">Add-ons</div>{db.addons.map((a) => <div key={a.id} className="flex items-center justify-between py-1"><span>{a.name} <span className="text-slate-400">{inr(a.price)}</span></span><Stepper v={addons[a.id] || 0} set={(n) => setAddons({ ...addons, [a.id]: n })} /></div>)}</div>
          </div>
          <div className="rounded-xl bg-slate-50 p-4 space-y-1 self-start">
            <div className="flex justify-between"><span>Current total</span><span>{inr(booking.totals.total)}</span></div>
            <div className="flex justify-between font-bold text-navy-950"><span>New total</span><span>{inr(pr.total)}</span></div>
            <div className={`flex justify-between ${diff > 0 ? "text-amber-700" : diff < 0 ? "text-emerald-700" : "text-slate-500"}`}><span>{diff > 0 ? "To collect" : diff < 0 ? "To refund" : "Difference"}</span><span>{inr(Math.abs(diff))}</span></div>
            <p className="pt-2 text-xs text-slate-500">Existing ticket codes are kept where the category is kept; removed tickets stop working. If the date changes, customers need their updated tickets (the QR includes the date). The difference is recorded under Payment Management to collect or refund.</p>
          </div>
        </div>)}
    </Modal>
  );
}

function NotificationsPage() {
  const { db, call } = useStore();
  const list = db.notifications || [];
  const unread = list.filter((n) => !n.read).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-slate-500">{unread} unread · recorded by the ticketing server for bookings, cancellations, refunds and changes. No email, SMS or WhatsApp is sent.</p><Button size="sm" variant="outline" disabled={!unread} onClick={() => call(() => api("/api/admin/notifications/read-all", { method: "POST" }))}>Mark all read</Button></div>
      {list.length === 0 ? <div className="card-flat"><Empty text="No notifications yet — they appear as bookings, cancellations, refunds and changes happen." /></div> : (
        <div className="space-y-2">{list.slice(0, 200).map((n) => (
          <div key={n.id} className={`card-flat p-3 flex items-start justify-between gap-3 ${n.read ? "opacity-60" : ""}`}>
            <div><div className="text-sm font-semibold text-navy-950">{n.message}</div><div className="text-xs text-slate-500 mt-0.5">{fmtTime(n.at)} · {n.type}{n.ref && <> · <span className="font-mono">{n.ref}</span></>}</div></div>
            {!n.read ? <Button size="sm" variant="ghost" onClick={() => call(() => api(`/api/admin/notifications/${n.id}/read`, { method: "POST" }))}>Mark read</Button> : <Badge>Read</Badge>}
          </div>))}</div>)}
    </div>
  );
}

function ActivityLog() {
  const { db } = useStore();
  const [q, setQ] = useState("");
  const rows = useMemo(() => [
    ...(db.auditLog || []).map((a) => ({ at: a.at, desc: a.message, ref: a.ref, actor: a.actor, type: a.type })),
    ...db.scans.map((s) => ({ at: s.at, desc: `Gate scan at ${s.gate} · ${s.result} · ${s.reason}`, ref: s.bookingId, actor: s.staffId, type: "scan" })),
  ].filter((r) => !q || `${r.desc} ${r.ref} ${r.actor}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300), [db.auditLog, db.scans, q]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 justify-between"><p className="text-sm text-slate-500">Admin actions, customer requests and gate scans recorded in this app. Demonstration log — not a tamper-proof security audit trail.</p>
        <div className="relative w-64"><Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className={inputCls + " pl-9"} placeholder="Search booking, staff, action…" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      <div className="card-flat overflow-hidden"><div className="overflow-x-auto"><table className="w-full"><thead className="bg-slate-50"><tr><Th>When</Th><Th>Action</Th><Th>Reference</Th><Th>Actor</Th></tr></thead>
        <tbody className="divide-y divide-slate-100">{rows.map((r, i) => <tr key={i}><Td className="text-xs">{fmtTime(r.at)}</Td><Td className="whitespace-normal">{r.desc}</Td><Td className="font-mono text-xs">{r.ref}</Td><Td className="text-xs">{r.actor}</Td></tr>)}</tbody></table>
        {rows.length === 0 && <Empty text="No activity recorded yet." />}</div></div>
    </div>
  );
}

// ---------- Payments ----------
function PaymentMgmt() {
  const { db } = useStore();
  const [st, setSt] = useState("all");
  const rows = db.bookings.filter((b) => st === "all" || b.payment.status === st);
  const sum = (s: string) => db.bookings.filter((b) => b.payment.status === s).reduce((a, b) => a + b.totals.total, 0);
  const byMethod = ["UPI", "Card", "Net Banking", "Cash"].map((m, i) => ({ label: m, value: db.bookings.filter((b) => b.payment.method === m && b.payment.status === "paid").length, color: PALETTE[i] }));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 stagger"><Kpi label="Captured" value={inr(sum("paid"))} icon="checkCircle" tone="green" /><Kpi label="Pending" value={inr(sum("pending"))} icon="clock" tone="amber" /><Kpi label="Failed" value={inr(sum("failed"))} icon="xCircle" tone="red" /><Kpi label="Refunded" value={inr(db.bookings.reduce((a, b) => a + (isRefunded(b) ? b.refund!.amount : 0), 0))} icon="refresh" tone="sky" sub="Approved refunds only" /></div>
      <RefundRequests />
      <Settlements />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4">
        <div className="card-flat overflow-hidden">
          <div className="p-3 flex gap-1.5 flex-wrap">{["all", "paid", "pending", "failed", "refunded"].map((s) => <button key={s} onClick={() => setSt(s)} className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize ${st === s ? "bg-navy-950 text-white" : "bg-slate-100 text-slate-600"}`}>{s}</button>)}</div>
          <div className="overflow-x-auto max-h-[560px]"><table className="w-full"><thead className="bg-slate-50 sticky top-0"><tr><Th>Transaction ID</Th><Th>Booking</Th><Th>Gateway</Th><Th>Method</Th><Th>Amount</Th><Th>Status</Th><Th>Date</Th><Th>Refund</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">{rows.slice(0, 80).map((b) => <tr key={b.id}><Td className="font-mono text-xs">{b.payment.txnId}</Td><Td className="font-mono text-xs font-semibold">{b.id}</Td><Td>{b.payment.gateway}</Td><Td>{b.payment.method}</Td><Td className="font-semibold">{inr(b.totals.total)}</Td><Td><Badge tone={payTone(b.payment.status)}>{b.payment.status}</Badge></Td><Td className="text-xs">{fmtTime(b.payment.at)}</Td><Td className="text-xs">{!b.refund ? "—" : isRefunded(b) ? <span className="text-violet-700 font-semibold">{inr(b.refund.amount)} processed</span> : b.refund.status === "pending" ? <span className="text-amber-700 font-semibold">{inr(b.refund.amount)} requested</span> : <span className="text-red-700">Rejected</span>}</Td></tr>)}</tbody></table></div>
        </div>
        <Card title="Payment methods (paid)"><Donut data={byMethod} center={{ value: String(byMethod.reduce((a, b) => a + b.value, 0)), label: "payments" }} /></Card>
      </div>
    </div>
  );
}

/** Money still to move after a booking modification: differences to collect, refunds to process. */
function Settlements() {
  const { db, call } = useStore();
  const toCollect = db.bookings.flatMap((b) => (b.differences || []).filter((d) => d.status === "created").map((d) => ({ b, d })));
  const toRefund = db.bookings.flatMap((b) => (b.refunds || []).filter((r) => r.status === "pending" || r.status === "failed").map((r) => ({ b, r })));
  if (!toCollect.length && !toRefund.length) return null;
  return (
    <div className="card-flat overflow-hidden">
      <div className="p-3 font-bold text-navy-950 flex items-center gap-2">Pending settlements <Badge tone="amber">{toCollect.length + toRefund.length}</Badge></div>
      <div className="divide-y divide-slate-100 text-sm">
        {toCollect.map(({ b, d }) => <div key={"c" + d.id} className="px-4 py-2 flex items-center justify-between gap-3"><span><span className="font-mono text-xs font-semibold">{b.id}</span> · {b.customer.name} · collect <b>{inr(d.amount)}</b> (booking changed)</span>
          <div className="flex gap-1.5">{["Cash", "UPI", "Card"].map((m) => <Button key={m} size="sm" variant="outline" onClick={() => call(() => api(`/api/admin/payments/${d.id}/collect`, { method: "POST", body: { method: m } }), `Collected ${inr(d.amount)} by ${m}`)}>{m}</Button>)}</div></div>)}
        {toRefund.map(({ b, r }) => <div key={"r" + r.id} className="px-4 py-2 flex items-center justify-between gap-3"><span><span className="font-mono text-xs font-semibold">{b.id}</span> · {b.customer.name} · refund <b>{inr(r.amount)}</b> ({r.reason || r.kind})</span>
          <Button size="sm" onClick={() => call(() => api(`/api/admin/refunds/${r.id}/process`, { method: "POST" }), "Refund recorded as paid (simulated provider)")}>Mark refunded</Button></div>)}
      </div>
    </div>
  );
}

// ---------- Customers ----------
function CustomerMgmt() {
  const { db } = useStore(); const [q, setQ] = useState("");
  const custs = useMemo(() => {
    const m = new Map<string, { name: string; phone: string; email: string; n: number; spent: number; last: string; visitors: number }>();
    db.bookings.forEach((b) => { const c = m.get(b.customer.phone) || { name: b.customer.name, phone: b.customer.phone, email: b.customer.email, n: 0, spent: 0, last: "", visitors: 0 }; c.n++; if (b.payment.status === "paid") c.spent += b.totals.total; c.visitors += b.tickets.length; if (b.visitDate > c.last) c.last = b.visitDate; m.set(b.customer.phone, c); });
    return [...m.values()].sort((a, b) => b.spent - a.spent);
  }, [db]);
  const rows = custs.filter((c) => !q || (c.name + c.phone + c.email).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 stagger"><Kpi label="Customers" value={String(custs.length)} icon="users" /><Kpi label="Repeat customers" value={String(custs.filter((c) => c.n > 1).length)} icon="refresh" tone="green" /><Kpi label="Avg. spend" value={inr(custs.reduce((a, c) => a + c.spent, 0) / Math.max(1, custs.length))} icon="rupee" tone="yellow" /><Kpi label="Avg. group size" value={(custs.reduce((a, c) => a + c.visitors, 0) / Math.max(1, custs.reduce((a, c) => a + c.n, 0))).toFixed(1)} icon="users" tone="sky" /></div>
      <div className="card-flat overflow-hidden">
        <div className="p-3"><div className="relative max-w-sm"><Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className={inputCls + " pl-9"} placeholder="Search customers" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
        <div className="overflow-x-auto max-h-[600px]"><table className="w-full"><thead className="bg-slate-50 sticky top-0"><tr><Th>Customer</Th><Th>Phone</Th><Th>Email</Th><Th>Bookings</Th><Th>Visitors</Th><Th>Total spent</Th><Th>Last visit</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">{rows.slice(0, 100).map((c) => <tr key={c.phone}><Td><div className="flex items-center gap-2"><span className="h-8 w-8 rounded-full bg-navy-950 text-mgm-yellow grid place-items-center text-xs font-bold">{c.name.split(" ").map((x) => x[0]).join("").slice(0, 2)}</span><span className="font-medium">{c.name}</span>{c.n > 1 && <Badge tone="green">Repeat</Badge>}</div></Td><Td>{c.phone}</Td><Td className="text-xs">{c.email}</Td><Td>{c.n}</Td><Td>{c.visitors}</Td><Td className="font-semibold">{inr(c.spent)}</Td><Td>{fmtShort(c.last)}</Td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}

// ---------- Entry ----------
function EntryMgmt() {
  const { db } = useStore();
  const paidTickets = db.bookings.filter((b) => b.payment.status === "paid").flatMap((b) => b.tickets.map((t) => ({ t, b })));
  const scanned = paidTickets.filter((x) => x.t.status === "used").length;
  const pending = paidTickets.filter((x) => x.t.status === "valid" && x.b.visitDate >= TODAY).length;
  const invalid = db.scans.filter((s) => s.result === "invalid").length; const dup = db.scans.filter((s) => s.result === "duplicate").length;
  const today = db.scans.filter((s) => s.at.slice(0, 10) === TODAY);
  const gates = ["Main Gate A", "Main Gate B", "Water Park Gate", "Fast Track Lane"].map((g, i) => ({ label: g, value: db.scans.filter((s) => s.gate === g && s.result === "valid" && s.at.slice(0, 10) === TODAY).length, color: PALETTE[i] }));
  const hours = Array.from({ length: 9 }, (_, i) => 10 + i);
  const [f, setF] = useState("all");
  const log = [...db.scans].filter((s) => f === "all" || s.result === f).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 stagger"><Kpi label="Tickets sold" value={paidTickets.length.toLocaleString("en-IN")} icon="ticket" /><Kpi label="Tickets scanned" value={scanned.toLocaleString("en-IN")} icon="scan" tone="green" /><Kpi label="Pending entry" value={pending.toLocaleString("en-IN")} icon="clock" tone="sky" /><Kpi label="Invalid scans" value={String(invalid)} icon="xCircle" tone="red" /><Kpi label="Duplicate scans" value={String(dup)} icon="alert" tone="amber" /><Kpi label="Entries today" value={String(today.filter((s) => s.result === "valid").length)} icon="door" tone="yellow" /></div>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Today's entries by hour"><BarChart labels={hours.map((h) => `${h > 12 ? h - 12 : h}${h >= 12 ? "pm" : "am"}`)} series={[{ name: "Valid", color: "#10B981", values: hours.map((h) => today.filter((s) => s.result === "valid" && Number(s.at.slice(11, 13)) === h).length) }, { name: "Rejected", color: "#CE3B37", values: hours.map((h) => today.filter((s) => s.result !== "valid" && Number(s.at.slice(11, 13)) === h).length) }]} stacked /></Card>
        <Card title="Entries by gate (today)"><HBars data={gates} /></Card>
      </div>
      <div className="card-flat overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4"><h3 className="font-bold text-navy-950">Entry history</h3><div className="flex gap-1.5">{["all", "valid", "duplicate", "invalid"].map((s) => <button key={s} onClick={() => setF(s)} className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${f === s ? "bg-navy-950 text-white" : "bg-slate-100 text-slate-600"}`}>{s}</button>)}</div></div>
        <div className="overflow-x-auto max-h-[480px]"><table className="w-full"><thead className="bg-slate-50 sticky top-0"><tr><Th>Time</Th><Th>Ticket</Th><Th>Booking</Th><Th>Gate</Th><Th>Staff</Th><Th>Result</Th><Th>Reason</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">{log.map((s) => <tr key={s.id}><Td className="text-xs">{fmtTime(s.at)}</Td><Td className="font-mono text-xs">{s.ticketId}</Td><Td className="font-mono text-xs">{s.bookingId}</Td><Td>{s.gate}</Td><Td className="text-xs">{db.staff.find((x) => x.id === s.staffId)?.name || s.staffId}</Td><Td><Badge tone={s.result === "valid" ? "green" : s.result === "duplicate" ? "amber" : "red"}>{s.result}</Badge></Td><Td className="text-xs text-slate-500">{s.reason}</Td></tr>)}</tbody></table>{log.length === 0 && <Empty text="No scans yet." />}</div>
      </div>
    </div>
  );
}

// ---------- Reports ----------
function Reports() {
  const { db } = useStore(); const s = useStats(db);
  const visitDays = datesBetween(MIN_DATE, MAX_DATE);
  const revByVisit = visitDays.map((d) => s.paid.filter((b) => b.visitDate === d).reduce((a, b) => a + b.totals.total, 0));
  const catRev = db.tickets.map((t, i) => ({ label: t.name, value: s.paid.reduce((a, b) => a + b.items.filter((x) => x.kind === "ticket" && x.refId === t.id).reduce((q, x) => q + x.amount, 0), 0), color: PALETTE[i] }));
  const weeks = Array.from({ length: 9 }, (_, i) => addDays(MIN_DATE, i * 7));
  const recentWeeks = Array.from({ length: 6 }, (_, i) => addDays(TODAY, -7 * (5 - i) - 6));
  const gvf = (kind: string) => weeks.map((w) => s.paid.filter((b) => b.visitDate >= w && b.visitDate < addDays(w, 7)).reduce((a, b) => a + b.tickets.filter((t) => (kind === "f" ? t.catId.startsWith("f") : !t.catId.startsWith("f"))).length, 0));
  const abv = s.revenue / Math.max(1, s.paid.length);
  const conv = db.offers.filter((o) => o.redemptions > 0 || s.offerPerf.some((x) => x.o.id === o.id)).map((o) => {
    const eligibleBookings = s.paid.filter((b) => eligibleOffers([{ ...o, status: "active", redemptions: 0 }], b.visitDate, b.createdAt.slice(0, 10)).length > 0).length;
    const used = s.paid.filter((b) => b.offerIds.includes(o.id)).length;
    return { o, eligibleBookings, used, rate: eligibleBookings ? used / eligibleBookings : 0, rev: s.offerPerf.find((x) => x.o.id === o.id)?.rev || 0 };
  });
  const newVsRepeat = recentWeeks.map((w) => { const seen = new Set<string>(); s.paid.filter((b) => b.createdAt.slice(0, 10) < w).forEach((b) => seen.add(b.customer.phone)); const wk = s.paid.filter((b) => b.createdAt.slice(0, 10) >= w && b.createdAt.slice(0, 10) < addDays(w, 7)); return [wk.filter((b) => !seen.has(b.customer.phone)).length, wk.filter((b) => seen.has(b.customer.phone)).length]; });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 stagger"><Kpi label="Net revenue" value={inr(s.revenue)} icon="rupee" tone="yellow" /><Kpi label="Average booking value" value={inr(abv)} icon="wallet" /><Kpi label="Offer-led bookings" value={`${Math.round((s.paid.filter((b) => b.offerIds.length).length / Math.max(1, s.paid.length)) * 100)}%`} icon="tag" tone="red" /><Kpi label="Fast Track share" value={`${Math.round((((s.cat.fa || 0) + (s.cat.fc || 0)) / Math.max(1, s.ticketsSold)) * 100)}%`} icon="zap" tone="sky" /></div>
      <Card title="Revenue by visit date" action={<span className="text-xs text-slate-400">Nov – Dec 2026</span>}><BarChart labels={visitDays.map(fmtShort)} series={[{ name: "Revenue", color: "#111111", values: revByVisit }]} fmt={inr} /></Card>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Revenue by ticket category"><Donut data={catRev} fmt={inr} center={{ value: inr(catRev.reduce((a, b) => a + b.value, 0)), label: "regular tickets" }} /></Card>
        <Card title="General vs Fast Track (tickets per week)"><BarChart labels={weeks.map((w) => "Wk " + fmtShort(w))} series={[{ name: "General", color: "#111111", values: gvf("g") }, { name: "Fast Track", color: "#CE3B37", values: gvf("f") }]} /></Card>
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Offer-wise bookings & revenue"><HBars data={s.offerPerf.map((x) => ({ label: x.o.name, value: x.rev, sub: `· ${x.n} bookings` }))} fmt={inr} /></Card>
        <Card title="Customer booking trend (new vs repeat)"><BarChart labels={recentWeeks.map((w) => "Wk " + fmtShort(w))} series={[{ name: "New", color: "#F6CD45", values: newVsRepeat.map((x) => x[0]) }, { name: "Repeat", color: "#10B981", values: newVsRepeat.map((x) => x[1]) }]} stacked /></Card>
      </div>
      <Card title="Offer conversion" action={<span className="text-xs text-slate-400">Bookings using the offer ÷ bookings on eligible dates</span>}>
        <div className="overflow-x-auto -mx-5"><table className="w-full"><thead className="bg-slate-50"><tr><Th>Offer</Th><Th>Eligible bookings</Th><Th>Used offer</Th><Th>Conversion</Th><Th>Revenue</Th><Th>Lifetime redemptions</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">{conv.map((c) => <tr key={c.o.id}><Td className="font-medium">{c.o.name}</Td><Td>{c.eligibleBookings}</Td><Td>{c.used}</Td><Td><div className="flex items-center gap-2"><div className="h-2 w-24 rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${c.rate * 100}%` }} /></div><span className="text-xs font-semibold">{Math.round(c.rate * 100)}%</span></div></Td><Td className="font-semibold">{inr(c.rev)}</Td><Td>{c.o.redemptions}</Td></tr>)}</tbody></table></div>
      </Card>
    </div>
  );
}

// ---------- Staff ----------
function StaffMgmt() {
  const { db, call } = useStore();
  type Edit = Staff & { roles: string[]; password: string; isNew: boolean };
  const [edit, setEdit] = useState<Edit | null>(null);
  const ROLES: [string, string][] = [["admin", "Administrator (everything)"], ["finance", "Finance – bookings, refunds, reports"], ["counter", "Counter sales"], ["gate", "Gate scanner"], ["marketing", "Influencers & regions"]];
  const save = async () => {
    if (!edit) return;
    const body = { name: edit.name, phone: edit.phone || null, gate: edit.gate || null, roles: edit.roles, active: edit.active, ...(edit.password ? { password: edit.password } : {}) };
    const r = await call(() => edit.isNew ? api("/api/admin/users", { method: "POST", body: { ...body, code: edit.id } }) : api(`/api/admin/users/${edit.id}`, { method: "PATCH", body }), "Staff account saved");
    if (r) setEdit(null);
  };
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-3"><p className="text-sm text-slate-500">Each person signs in with their own Staff ID and password. Passwords are stored as Argon2id hashes; nobody can read them, so set a new one to reset.</p><Button icon="plus" onClick={() => setEdit({ id: "", name: "", gate: "Main Gate A", role: "", roles: ["gate"], active: true, phone: "", password: "", isNew: true })}>Add staff</Button></div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4 stagger">
        {db.staff.map((s) => { const scans = db.scans.filter((x) => x.staffId === s.id); return (
          <div key={s.id} className={`card-flat p-4 ${s.active ? "" : "opacity-60"}`}>
            <div className="flex items-start justify-between"><div className="flex items-center gap-3"><span className="h-11 w-11 rounded-full bg-navy-950 text-mgm-yellow grid place-items-center font-bold">{s.name.split(" ").map((x) => x[0]).join("").slice(0, 2)}</span><div><div className="font-bold text-navy-950">{s.name}</div><div className="text-xs text-slate-500">{s.role}</div></div></div><Toggle on={s.active} onChange={(v) => call(() => api(`/api/admin/users/${s.id}`, { method: "PATCH", body: { active: v } }), `${s.name} ${v ? "activated" : "deactivated (signed out everywhere)"}`)} /></div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><Info k="Staff ID" v={<span className="font-mono">{s.id}</span>} /><Info k="Gate" v={s.gate || "—"} /><Info k="Total scans" v={scans.length} /><Info k="Last sign-in" v={s.lastLoginAt ? fmtTime(s.lastLoginAt) : "never"} /></div>
            <Button size="sm" variant="outline" icon="edit" className="w-full mt-3" onClick={() => setEdit({ ...s, roles: s.roles || [], password: "", isNew: false })}>Edit</Button>
          </div>); })}
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.isNew ? "Add staff member" : "Edit staff"} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={!edit?.name || !edit.id || !edit.roles.length || (edit.isNew && edit.password.length < 10)} onClick={save}>Save</Button></>}>
        {edit && <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Field label="Full name"><input className={inputCls} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field></div>
          <Field label="Staff ID"><input className={inputCls + " font-mono"} value={edit.id} disabled={!edit.isNew} onChange={(e) => setEdit({ ...edit, id: e.target.value.toUpperCase() })} placeholder="STF1060" /></Field>
          <Field label={edit.isNew ? "Initial password" : "New password (optional)"} hint="At least 10 characters"><input type="password" autoComplete="new-password" className={inputCls} value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
          <Field label="Assigned gate"><Select value={edit.gate || ""} onChange={(v) => setEdit({ ...edit, gate: v })} options={["Main Gate A", "Main Gate B", "Water Park Gate", "Fast Track Lane"].map((g) => ({ value: g, label: g }))} /></Field>
          <Field label="Phone"><input className={inputCls} value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
          <div className="col-span-2"><div className="text-xs font-semibold text-slate-600 mb-1">Access</div>{ROLES.map(([r, l]) => <label key={r} className="flex items-center gap-2 text-sm py-0.5"><input type="checkbox" checked={edit.roles.includes(r)} onChange={(e) => setEdit({ ...edit, roles: e.target.checked ? [...edit.roles, r] : edit.roles.filter((x) => x !== r) })} />{l}</label>)}</div>
          <div className="col-span-2"><Toggle on={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Active – can sign in" /></div>
        </div>}
      </Modal>
    </div>
  );
}

// ---------- Settings ----------
function SettingsPage() {
  const { db, call, toast } = useStore();
  const [s, setS] = useState(db.settings);
  useEffect(() => setS(db.settings), [db.settings]);
  const set = (k: keyof typeof s, v: string | number) => setS({ ...s, [k]: v });
  const changed = (Object.keys(s) as (keyof typeof s)[]).filter((k) => s[k] !== db.settings[k]);
  const [importResult, setImportResult] = useState<{ summary: Record<string, number>; results: { ref: string; result: string; reason: string }[] } | null>(null);
  const legacy = legacyBookings();
  const exportLegacy = () => {
    const raw = localStorage.getItem(LEGACY_KEY) || "{}";
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([raw], { type: "application/json" })); a.download = `mgm-browser-data-${TODAY}.json`; a.click();
  };
  const importLegacy = async () => {
    const r = await call(() => api<{ summary: Record<string, number>; results: { ref: string; result: string; reason: string }[] }>("/api/admin/legacy-import", { method: "POST", body: { bookings: legacy } }));
    if (r) { setImportResult(r); toast(`Imported ${r.summary.imported}, already present ${r.summary.already_present}`); }
  };
  return (
    <div className="grid lg:grid-cols-2 gap-4 max-w-5xl">
      <Card title="Park information"><div className="grid grid-cols-2 gap-3"><div className="col-span-2"><Field label="Park name"><input className={inputCls} value={s.parkName} onChange={(e) => set("parkName", e.target.value)} /></Field></div><Field label="Opening time"><TimeInput value={s.openTime} onChange={(v) => set("openTime", v)} /></Field><Field label="Closing time"><TimeInput value={s.closeTime} onChange={(v) => set("closeTime", v)} /></Field><Field label="Support phone"><input className={inputCls} value={s.phone} onChange={(e) => set("phone", e.target.value)} /></Field><Field label="Support email"><input className={inputCls} value={s.email} onChange={(e) => set("email", e.target.value)} /></Field></div></Card>
      <Card title="Booking rules"><div className="grid grid-cols-2 gap-3">
        <Field label="GST on tickets (%)"><input type="number" className={inputCls} value={s.gst} onChange={(e) => set("gst", Number(e.target.value))} /></Field>
        <Field label="Default daily capacity"><input type="number" className={inputCls} value={s.defaultCapacity} onChange={(e) => set("defaultCapacity", Number(e.target.value))} /></Field>
        <Field label="Cancellation fee (%)" hint="Provisional 25% (MGM FAQ) – MGM to confirm"><input type="number" className={inputCls} value={s.cancellationFeePct} onChange={(e) => set("cancellationFeePct", Number(e.target.value))} /></Field>
        <Field label="Cancellation notice (days)"><input type="number" className={inputCls} value={s.cancelNoticeDays} onChange={(e) => set("cancelNoticeDays", Number(e.target.value))} /></Field>
        <Field label="Sales open from"><DateInput value={s.saleStart || ""} onChange={(v) => set("saleStart", v)} /></Field>
        <Field label="Sales open until"><DateInput value={s.saleEnd || ""} onChange={(v) => set("saleEnd", v)} /></Field>
        <Field label="Payment hold (minutes)" hint="How long unpaid tickets are held"><input type="number" className={inputCls} value={s.holdMinutes || 15} onChange={(e) => set("holdMinutes", Number(e.target.value))} /></Field>
        <div className="col-span-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">Payments: <b>simulated provider</b> (no money moves) · Park date today: <b>{fmtDate(TODAY)}</b></div>
      </div></Card>
      <div className="lg:col-span-2 flex justify-end"><Button disabled={!changed.length} onClick={() => call(() => api("/api/admin/settings", { method: "PATCH", body: Object.fromEntries(changed.map((k) => [k, s[k]])) }), "Settings saved")}>Save settings</Button></div>
      <Card title="Bookings from the earlier browser-only version" className="lg:col-span-2">
        <p className="text-sm text-slate-600">The earlier version stored bookings only in the browser that made them. This browser holds <b>{legacy.length}</b> such booking{legacy.length === 1 ? "" : "s"} (demo samples are excluded). Export them as a file, or import them into the ticketing server: each booking keeps its reference and ticket codes, nothing on the server is overwritten, and importing twice is safe. The browser copy is never deleted.</p>
        <div className="flex flex-wrap gap-2 mt-3"><Button variant="outline" icon="download" onClick={exportLegacy} disabled={!localStorage.getItem(LEGACY_KEY)}>Export this browser's data</Button><Button icon="upload" onClick={importLegacy} disabled={!legacy.length}>Import {legacy.length} booking{legacy.length === 1 ? "" : "s"}</Button></div>
        {importResult && <div className="mt-3 text-sm"><div className="font-semibold">{Object.entries(importResult.summary).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(" · ")}</div>
          <div className="max-h-40 overflow-y-auto mt-1 text-xs text-slate-600">{importResult.results.filter((r) => r.result !== "imported").map((r) => <div key={r.ref}><span className="font-mono">{r.ref}</span> – {r.result}: {r.reason}</div>)}</div></div>}
      </Card>
    </div>
  );
}
