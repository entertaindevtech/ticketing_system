// Admin › Influencers & Regions: influencer management, commissions and referral/regional analytics.
// All figures come from the backend (backend/app/analytics.py) — nothing here is mock data.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, Kpi, Td, Th } from "./admin";
import { HBars } from "./charts";
import { api } from "./api";
import { fmtTime, inr } from "./store";
import { Badge, Button, DateInput, Field, Icon, Modal, Select, Toggle, copyText, inputCls, useStore } from "./ui";

const PLATFORMS = ["Instagram", "YouTube", "Facebook", "X", "TikTok", "Blog", "Other"];
const STATUS_TONE: Record<string, string> = { pending: "amber", approved: "blue", paid: "green", reversed: "violet" };

type Influencer = { id: number; name: string; platform: string; referral_code: string; referral_url: string; commission_rate: number; handle: string | null; email: string | null; phone: string | null; notes: string | null; active: boolean };
type Perf = { id: number; name: string; platform: string; referral_code: string; active: boolean; commission_rate: number; clicks: number; sessions: number; attributed_bookings: number; paid_bookings: number; conversion_rate: number; tickets: number; revenue: number; commission_earned: number; commission_pending: number; commission_approved: number; commission_paid: number; commission_reversed: number };
type Region = { paid_bookings: number; tickets: number; revenue: number };
type Analytics = {
  summary: { revenue: number; paid_bookings: number; attributed_bookings: number; tickets: number; clicks: number; sessions: number; conversion_rate: number; commission_pending: number; commission_paid: number };
  influencers: Perf[];
  regions: { states: (Region & { state: string })[]; cities: (Region & { city: string; state: string })[]; state_influencers: (Region & { state: string; influencer: string })[];
    city_influencers: (Region & { city: string; state: string; influencer: string })[]; campaign_states: (Region & { influencer: string; campaign: string; state: string })[] };
  campaigns: { influencer: string; campaign: string; clicks: number; sessions: number; attributed_bookings: number; paid_bookings: number; conversion_rate: number; tickets: number; revenue: number; commission: number }[];
  geoip_available: boolean;
};
type Commission = {
  id: number; influencer: string; referral_code: string; booking_ref: string; booking_status: string; campaign: string | null; paid_at: string; visit_date: string | null;
  tickets: number; ticket_net_amount: number; addons_amount: number; tax_amount: number; total_amount: number; rate: number; basis: string; basis_amount: number; amount: number;
  status: string; approved_at: string | null; paid_out_at: string | null; payout_reference: string | null; reversed_at: string | null; reversal_reason: string | null;
  region: { country_code: string | null; state: string | null; city: string | null }; events?: { from: string | null; to: string; note: string | null; at: string }[];
};

// ---------- api ----------
// Uses the signed-in staff session (admin or marketing role); the server checks the role on every call.
function useApi() {
  return useCallback(<T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => api<T>(`/api/admin${path}`, init), []);
}
type Call = ReturnType<typeof useApi>;

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const run = useCallback(() => { setState((s) => ({ ...s, loading: true, error: undefined })); load().then((data) => setState({ data, loading: false })).catch((e: Error) => setState({ error: e.message, loading: false })); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(run, [run]);
  return { ...state, reload: run };
}

const qs = (o: Record<string, string | number | undefined>) => { const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== ""); return p.length ? "?" + p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&") : ""; };
const pct = (n: number) => `${n.toFixed(1)}%`;
const num = (n: number) => n.toLocaleString("en-IN");
// Commission amounts keep paise; inr() rounds to whole rupees, which is fine for revenue but not for payouts.
const money = (n: number) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const Loading = () => <div className="py-12 text-center text-sm text-slate-500"><div className="mx-auto mb-3 h-8 w-8 rounded-full border-4 border-slate-200 border-t-navy-950 animate-spin" />Loading…</div>;
const ErrorBox = ({ text, retry }: { text: string; retry?: () => void }) => <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-center justify-between gap-3"><span className="flex items-center gap-2"><Icon name="alert" size={16} />{text}</span>{retry && <Button size="sm" variant="outline" onClick={retry}>Retry</Button>}</div>;

// ---------- root ----------
export default function InfluencerModule() {
  const [tab, setTab] = useState<"regional" | "overview" | "influencers" | "commissions">("regional");
  const call = useApi();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {([["regional", "Regions & channels"], ["overview", "Influencer performance"], ["influencers", "Influencers"], ["commissions", "Commissions"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ${tab === k ? "bg-navy-950 text-white" : "bg-white text-slate-600 border border-slate-200 hover:border-slate-300"}`}>{l}</button>
        ))}
      </div>
      {tab === "regional" && <RegionalDashboard call={call} />}
      {tab === "overview" && <Overview call={call} />}
      {tab === "influencers" && <InfluencerList call={call} />}
      {tab === "commissions" && <Commissions call={call} />}
      <p className="text-[11px] text-slate-400">Regions are approximate, estimated from the visitor's IP address at their first visit (one lookup per visitor session) — not the customer's address. This product includes GeoLite Data created by MaxMind, available from <a className="underline" href="https://www.maxmind.com" target="_blank" rel="noreferrer">https://www.maxmind.com</a>.</p>
    </div>
  );
}

// ---------- all website traffic: overall regional sales, acquisition channels, regional funnel ----------
type Funnel = { sessions: number; bookings: number; paid_bookings: number; tickets: number; revenue: number; conversion_rate: number };
type Regional = {
  summary: Funnel & { unknown_location_bookings: number };
  sources: (Funnel & { source: string })[]; countries: (Funnel & { country: string })[];
  states: (Funnel & { state: string })[]; cities: (Funnel & { city: string; state: string })[]; geoip_available: boolean;
};
const SOURCE_LABEL: Record<string, string> = { influencer: "Influencer referral", direct: "Direct", organic: "Organic search", paid: "Paid / tagged campaign", social: "Social", referral: "External referral", unknown: "Unknown (no session)", counter: "Counter (walk-in)", influencer_uncredited: "Influencer link · no commission" };

function FunnelTable({ rows, first }: { rows: (Funnel & { label: React.ReactNode; key: string })[]; first: string }) {
  if (!rows.length) return <Empty text="No visitor sessions or bookings in this period." />;
  return (
    <div className="overflow-x-auto -mx-5"><table className="w-full"><thead className="bg-slate-50"><tr><Th>{first}</Th><Th className="text-right">Visitor sessions</Th><Th className="text-right">Bookings</Th><Th className="text-right">Paid bookings</Th><Th className="text-right">Conversion</Th><Th className="text-right">Tickets</Th><Th className="text-right">Revenue</Th></tr></thead>
      <tbody className="divide-y divide-slate-100">{rows.map((r) => <tr key={r.key}><Td className="font-medium">{r.label}</Td><Td className="text-right tabular-nums">{num(r.sessions)}</Td><Td className="text-right tabular-nums">{num(r.bookings)}</Td><Td className="text-right tabular-nums">{num(r.paid_bookings)}</Td><Td className="text-right tabular-nums">{r.sessions ? pct(r.conversion_rate) : <span className="text-slate-300">—</span>}</Td><Td className="text-right tabular-nums">{num(r.tickets)}</Td><Td className="text-right font-semibold tabular-nums">{inr(r.revenue)}</Td></tr>)}</tbody></table></div>
  );
}

function RegionalDashboard({ call }: { call: Call }) {
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [level, setLevel] = useState<"state" | "city" | "country">("state");
  const { data, error, loading, reload } = useLoad(() => call<Regional>(`/regional${qs({ from, to })}`), [call, from, to]);
  const regionRows = !data ? [] : level === "state" ? data.states.map((r) => ({ ...r, key: r.state, label: r.state }))
    : level === "city" ? data.cities.map((r) => ({ ...r, key: r.city + "|" + r.state, label: <>{r.city}<span className="ml-1 text-xs text-slate-400">{r.city === r.state ? "" : r.state}</span></> }))
    : data.countries.map((r) => ({ ...r, key: r.country, label: r.country }));
  return (
    <div className="space-y-5">
      <div className="card-flat p-3 flex flex-wrap gap-2 items-end">
        <Field label="From"><DateInput value={from} onChange={setFrom} placeholder="All time" clearable max={to || undefined} /></Field>
        <Field label="To"><DateInput value={to} onChange={setTo} placeholder="Today" clearable min={from || undefined} /></Field>
        <Button variant="outline" icon="refresh" onClick={reload}>Refresh</Button>
        <span className="text-xs text-slate-500 ml-auto max-w-md">All visitors and bookings from the booking ledger. Sessions are counted by first-visit date, bookings by payment date. Counter (walk-in) sales are their own channel: they have no visitor session or location, so they are left out of the regional tables and of conversion.</span>
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading />}
      {data && (<>
        {!data.geoip_available && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex gap-2"><Icon name="alert" size={16} className="mt-0.5" />GeoLite2 database not loaded on the server — new visitors are being recorded under “Unknown” region.</div>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 stagger">
          <Kpi label="Visitor sessions (≈ unique visitors)" value={num(data.summary.sessions)} icon="users" sub="One per browser per 30 days — not individual people" />
          <Kpi label="Bookings" value={num(data.summary.bookings)} icon="file" sub="Paid in period, incl. later cancelled" />
          <Kpi label="Paid bookings" value={num(data.summary.paid_bookings)} icon="checkCircle" tone="green" sub="Excludes cancelled / refunded" />
          <Kpi label="Session → paid booking" value={pct(data.summary.conversion_rate)} icon="percent" tone="sky" />
          <Kpi label="Tickets sold" value={num(data.summary.tickets)} icon="ticket" />
          <Kpi label="Booking revenue" value={inr(data.summary.revenue)} icon="rupee" tone="yellow" sub="Paid bookings · incl. GST" />
          <Kpi label="Unknown-location bookings" value={num(data.summary.unknown_location_bookings)} icon="alert" tone="amber" sub="No session or unresolved IP" />
          <Kpi label="Cancelled / refunded" value={num(data.summary.bookings - data.summary.paid_bookings)} icon="refresh" tone="red" sub="Excluded from paid figures" />
        </div>
        <div className="grid lg:grid-cols-[1fr_360px] gap-5">
          <Card className="min-w-0" title="Acquisition channels" action={<span className="text-xs text-slate-400">First touch of each visitor session</span>}>
            <FunnelTable first="Channel" rows={data.sources.map((r) => ({ ...r, key: r.source, label: SOURCE_LABEL[r.source] || r.source }))} />
          </Card>
          <Card className="min-w-0" title="Revenue by channel">
            {data.summary.revenue ? <HBars data={data.sources.filter((r) => r.revenue > 0).map((r) => ({ label: SOURCE_LABEL[r.source] || r.source, value: r.revenue, sub: `${num(r.paid_bookings)} paid bookings` }))} fmt={inr} /> : <Empty text="No paid website bookings in this period." />}
          </Card>
        </div>
        <Card title="Regional traffic → booking funnel" action={<div className="w-40"><Select value={level} onChange={(v) => setLevel(v as typeof level)} ariaLabel="Region level" options={[{ value: "state", label: "By state" }, { value: "city", label: "By city" }, { value: "country", label: "By country" }]} /></div>}>
          <FunnelTable first={level === "state" ? "State / region" : level === "city" ? "City" : "Country"} rows={regionRows} />
          <p className="mt-3 text-[11px] text-slate-500">Conversion = paid bookings ÷ visitor sessions in the same period and region. A booking can come from a session that started before the period, so short date ranges can over- or under-state it. “Outside India” and “Unknown” are kept as their own rows rather than dropped.</p>
        </Card>
      </>)}
    </div>
  );
}

// ---------- overview: KPIs, influencer table, regions, campaigns ----------
type SortKey = keyof Perf;
function Overview({ call }: { call: Call }) {
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const { data, error, loading, reload } = useLoad(() => call<Analytics>(`/analytics${qs({ from, to })}`), [call, from, to]);
  const [q, setQ] = useState(""); const [platform, setPlatform] = useState("all");
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "revenue", desc: true });
  const [detail, setDetail] = useState<Perf | null>(null);
  const [stateSel, setStateSel] = useState("all");
  const [level, setLevel] = useState<"state" | "city" | "campaign">("state");

  const rows = useMemo(() => (data?.influencers || [])
    .filter((i) => (platform === "all" || i.platform === platform) && (!q || `${i.name} ${i.referral_code}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => { const x = a[sort.k], y = b[sort.k]; const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y)); return sort.desc ? -c : c; }), [data, q, platform, sort]);
  const SortTh = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <Th className={right ? "text-right" : ""}><button className="inline-flex items-center gap-1 uppercase hover:text-navy-950" onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : true }))}>{children}{sort.k === k && <span aria-hidden>{sort.desc ? "↓" : "↑"}</span>}</button></Th>
  );

  return (
    <div className="space-y-5">
      <div className="card-flat p-3 flex flex-wrap gap-2 items-end">
        <Field label="From"><DateInput value={from} onChange={setFrom} placeholder="All time" clearable max={to || undefined} /></Field>
        <Field label="To"><DateInput value={to} onChange={setTo} placeholder="Today" clearable min={from || undefined} /></Field>
        <Button variant="outline" icon="refresh" onClick={reload}>Refresh</Button>
        <span className="text-xs text-slate-500 ml-auto max-w-sm">Clicks and sessions are counted by visit date; bookings and revenue by payment date. Cancelled/refunded bookings are excluded from paid figures.</span>
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading />}
      {data && (<>
        {!data.geoip_available && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex gap-2"><Icon name="alert" size={16} className="mt-0.5" />GeoLite2 database not loaded on the server — new referral visits will be reported under “Unknown” region until it is provisioned.</div>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 stagger">
          <Kpi label="Influencer revenue" value={inr(data.summary.revenue)} icon="rupee" tone="yellow" sub="Paid bookings · incl. GST" />
          <Kpi label="Paid bookings" value={num(data.summary.paid_bookings)} icon="checkCircle" tone="green" sub={`${num(data.summary.attributed_bookings)} attributed in total`} />
          <Kpi label="Tickets sold" value={num(data.summary.tickets)} icon="ticket" />
          <Kpi label="Referral clicks" value={num(data.summary.clicks)} icon="trend" tone="red" />
          <Kpi label="Unique referral sessions" value={num(data.summary.sessions)} icon="users" />
          <Kpi label="Session → paid booking" value={pct(data.summary.conversion_rate)} icon="percent" tone="sky" />
          <Kpi label="Commission owed" value={money(data.summary.commission_pending)} icon="clock" tone="amber" sub="Pending + approved, not yet paid" />
          <Kpi label="Commission paid" value={money(data.summary.commission_paid)} icon="wallet" tone="green" />
        </div>

        <Card title="Influencer performance" action={<span className="text-xs text-slate-400">Click a row for details</span>}>
          <div className="flex flex-wrap gap-2 mb-3">
            <div className="relative flex-1 min-w-48"><Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className={inputCls + " pl-9"} placeholder="Search name or code…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="w-44"><Select value={platform} onChange={setPlatform} ariaLabel="Platform" options={[{ value: "all", label: "All platforms" }, ...PLATFORMS.map((p) => ({ value: p, label: p }))]} /></div>
          </div>
          <div className="overflow-x-auto -mx-5"><table className="w-full">
            <thead className="bg-slate-50"><tr><SortTh k="name">Influencer</SortTh><SortTh k="referral_code">Code</SortTh><SortTh k="clicks" right>Clicks</SortTh><SortTh k="attributed_bookings" right>Attributed</SortTh><SortTh k="paid_bookings" right>Paid</SortTh><SortTh k="conversion_rate" right>Conv.</SortTh><SortTh k="tickets" right>Tickets</SortTh><SortTh k="revenue" right>Revenue</SortTh><SortTh k="commission_earned" right>Commission</SortTh><Th>Commission status</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">{rows.map((i) => (
              <tr key={i.id} className="hover:bg-mgm-yellow/10 cursor-pointer" onClick={() => setDetail(i)}>
                <Td><div className="font-medium">{i.name}{!i.active && <Badge className="ml-2">inactive</Badge>}</div><div className="text-xs text-slate-400">{i.platform} · {i.commission_rate}%</div></Td>
                <Td className="font-mono text-xs">{i.referral_code}</Td><Td className="text-right tabular-nums">{num(i.clicks)}</Td><Td className="text-right tabular-nums">{num(i.attributed_bookings)}</Td>
                <Td className="text-right tabular-nums">{num(i.paid_bookings)}</Td><Td className="text-right tabular-nums">{pct(i.conversion_rate)}</Td><Td className="text-right tabular-nums">{num(i.tickets)}</Td>
                <Td className="text-right font-semibold tabular-nums">{inr(i.revenue)}</Td><Td className="text-right tabular-nums">{money(i.commission_earned)}</Td>
                <Td className="text-xs"><CommissionMix p={i} /></Td>
              </tr>))}</tbody>
          </table>{rows.length === 0 && <Empty text={data.influencers.length ? "No influencers match these filters." : "No influencers yet — add one under the Influencers tab."} />}</div>
        </Card>

        <div className="grid lg:grid-cols-2 gap-5">
          <Card title="Revenue by state" action={<span className="text-xs text-slate-400">Paid bookings · approximate</span>}>
            {data.regions.states.length ? <HBars data={data.regions.states.slice(0, 10).map((s) => ({ label: s.state, value: s.revenue, sub: `${num(s.paid_bookings)} bookings · ${num(s.tickets)} tickets` }))} fmt={inr} /> : <Empty text="No paid influencer bookings in this period." />}
          </Card>
          <Card title="Top cities" action={<span className="text-xs text-slate-400">IP-based estimate</span>}>
            {data.regions.cities.length ? <div className="overflow-x-auto -mx-5 max-h-80"><table className="w-full"><thead className="bg-slate-50 sticky top-0"><tr><Th>City</Th><Th>State</Th><Th className="text-right">Bookings</Th><Th className="text-right">Tickets</Th><Th className="text-right">Revenue</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">{data.regions.cities.slice(0, 25).map((c) => <tr key={c.city + c.state}><Td className="font-medium">{c.city}</Td><Td className="text-slate-500">{c.state}</Td><Td className="text-right">{num(c.paid_bookings)}</Td><Td className="text-right">{num(c.tickets)}</Td><Td className="text-right font-semibold">{inr(c.revenue)}</Td></tr>)}</tbody></table></div> : <Empty text="No paid influencer bookings in this period." />}
          </Card>
        </div>

        <Card title="Influencers by region" action={<div className="flex gap-2"><div className="w-44"><Select value={level} onChange={(v) => setLevel(v as typeof level)} ariaLabel="Breakdown" options={[{ value: "state", label: "Influencer × state" }, { value: "city", label: "Influencer × city" }, { value: "campaign", label: "Campaign × state" }]} /></div><div className="w-44"><Select value={stateSel} onChange={setStateSel} ariaLabel="State" options={[{ value: "all", label: "All regions" }, ...data.regions.states.map((s) => ({ value: s.state, label: s.state }))]} /></div></div>}>
          {(() => {
            const rows = (level === "state" ? data.regions.state_influencers : level === "city" ? data.regions.city_influencers : data.regions.campaign_states).filter((r) => stateSel === "all" || r.state === stateSel) as (Region & { state: string; influencer: string; city?: string; campaign?: string })[];
            return rows.length ? <div className="overflow-x-auto -mx-5"><table className="w-full"><thead className="bg-slate-50"><tr>{level === "city" && <Th>City</Th>}<Th>State / region</Th><Th>Influencer</Th>{level === "campaign" && <Th>Campaign</Th>}<Th className="text-right">Paid bookings</Th><Th className="text-right">Tickets</Th><Th className="text-right">Revenue</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">{rows.map((r) => <tr key={[r.city, r.state, r.influencer, r.campaign].join("|")}>{level === "city" && <Td className="font-medium">{r.city}</Td>}<Td>{r.state}</Td><Td className="font-medium">{r.influencer}</Td>{level === "campaign" && <Td className="font-mono text-xs">{r.campaign}</Td>}<Td className="text-right">{num(r.paid_bookings)}</Td><Td className="text-right">{num(r.tickets)}</Td><Td className="text-right font-semibold">{inr(r.revenue)}</Td></tr>)}</tbody></table></div> : <Empty text="No paid influencer bookings in this period." />;
          })()}
        </Card>

        <Card title="Campaigns" action={<span className="text-xs text-slate-400">From the campaign= link parameter</span>}>
          <CampaignTable rows={data.campaigns} />
        </Card>
      </>)}
      {detail && <InfluencerDetail call={call} perf={detail} from={from} to={to} onClose={() => setDetail(null)} />}
    </div>
  );
}

const CommissionMix = ({ p }: { p: Pick<Perf, "commission_pending" | "commission_approved" | "commission_paid" | "commission_reversed"> }) => {
  const parts = ([["pending", p.commission_pending], ["approved", p.commission_approved], ["paid", p.commission_paid], ["reversed", p.commission_reversed]] as const).filter(([, v]) => v > 0);
  return parts.length ? <div className="flex flex-wrap gap-1">{parts.map(([k, v]) => <Badge key={k} tone={STATUS_TONE[k]}>{k} {money(v)}</Badge>)}</div> : <span className="text-slate-300">—</span>;
};

function CampaignTable({ rows }: { rows: Analytics["campaigns"] }) {
  if (!rows.length) return <Empty text="No referral activity in this period." />;
  return (
    <div className="overflow-x-auto -mx-5"><table className="w-full"><thead className="bg-slate-50"><tr><Th>Campaign</Th><Th>Influencer</Th><Th className="text-right">Clicks</Th><Th className="text-right">Sessions</Th><Th className="text-right">Paid bookings</Th><Th className="text-right">Conv.</Th><Th className="text-right">Revenue</Th><Th className="text-right">Commission</Th></tr></thead>
      <tbody className="divide-y divide-slate-100">{rows.map((c) => <tr key={c.influencer + c.campaign}><Td className="font-mono text-xs">{c.campaign}</Td><Td>{c.influencer}</Td><Td className="text-right">{num(c.clicks)}</Td><Td className="text-right">{num(c.sessions)}</Td><Td className="text-right">{num(c.paid_bookings)}</Td><Td className="text-right">{pct(c.conversion_rate)}</Td><Td className="text-right font-semibold">{inr(c.revenue)}</Td><Td className="text-right">{money(c.commission)}</Td></tr>)}</tbody></table></div>
  );
}

function InfluencerDetail({ call, perf, from, to, onClose }: { call: Call; perf: Perf; from: string; to: string; onClose: () => void }) {
  const a = useLoad(() => call<Analytics>(`/analytics${qs({ influencer_id: perf.id, from, to })}`), [call, perf.id, from, to]);
  const c = useLoad(() => call<Commission[]>(`/commissions${qs({ influencer_id: perf.id, from, to, limit: 50 })}`), [call, perf.id, from, to]);
  return (
    <Modal open wide onClose={onClose} title={`${perf.name} · ${perf.referral_code}`}>
      {(a.error || c.error) && <ErrorBox text={(a.error || c.error)!} />}
      {a.data ? (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {([["Clicks", num(a.data.summary.clicks)], ["Sessions", num(a.data.summary.sessions)], ["Paid bookings", num(a.data.summary.paid_bookings)], ["Conversion", pct(a.data.summary.conversion_rate)], ["Tickets", num(a.data.summary.tickets)], ["Revenue", inr(a.data.summary.revenue)], ["Commission owed", money(a.data.summary.commission_pending)], ["Commission paid", money(a.data.summary.commission_paid)]] as const).map(([k, v]) => (
              <div key={k} className="rounded-xl bg-slate-50 p-2.5"><div className="text-[11px] text-slate-500">{k}</div><div className="font-semibold text-navy-950">{v}</div></div>
            ))}
          </div>
          <div><div className="font-bold mb-1">Regions</div>{a.data.regions.states.length ? <HBars data={a.data.regions.states.map((s) => ({ label: s.state, value: s.revenue, sub: `${num(s.paid_bookings)} bookings` }))} fmt={inr} /> : <div className="text-slate-500">No paid bookings yet.</div>}</div>
          <div><div className="font-bold mb-1">Campaigns</div><CampaignTable rows={a.data.campaigns} /></div>
          <div><div className="font-bold mb-1">Recent commissions</div>{c.data?.length ? c.data.slice(0, 10).map((x) => <div key={x.id} className="flex justify-between gap-2 py-1 border-b border-slate-100"><span className="font-mono text-xs">{x.booking_ref}</span><span className="text-slate-500">{fmtTime(x.paid_at)}</span><span>{money(x.amount)}</span><Badge tone={STATUS_TONE[x.status]}>{x.status}</Badge></div>) : <div className="text-slate-500">None yet.</div>}</div>
        </div>
      ) : !a.error && <Loading />}
    </Modal>
  );
}

// ---------- influencer management ----------
const blank = { name: "", platform: "Instagram", referral_code: "", commission_rate: "", handle: "", email: "", phone: "", notes: "", active: true };
type Form = typeof blank;
// Same rules as the server (backend/app/services.py CODE_RE, api.py EMAIL_RE / PHONE_RE); the server re-checks.
const CODE_RE = /^[A-Z0-9_-]{3,32}$/;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const HANDLE_HINT: Record<string, string> = {
  Instagram: "@handle or instagram.com/handle", YouTube: "@channel or youtube.com/@channel", Facebook: "facebook.com/page",
  X: "@handle or x.com/handle", TikTok: "@handle or tiktok.com/@handle", Blog: "https://blog.example.com", Other: "Profile link or handle",
};
/** Suggested code: letters of the name + 2 digits, not already taken. Editable before saving. */
function suggestCode(name: string, taken: Set<string>) {
  const stem = (name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "MGM").padEnd(3, "X");
  for (let i = 0; i < 200; i++) { const c = stem + String(Math.floor(10 + Math.random() * 90)); if (!taken.has(c)) return c; }
  return stem + Date.now().toString(36).toUpperCase().slice(-4);
}
function formErrors(f: Form, isNew: boolean, taken: Set<string>) {
  const e: Partial<Record<keyof Form, string>> = {};
  if (f.name.trim().length < 2) e.name = "Enter the influencer's name";
  const code = f.referral_code.trim().toUpperCase();
  if (isNew && !CODE_RE.test(code)) e.referral_code = "3–32 letters, digits, - or _";
  else if (isNew && taken.has(code)) e.referral_code = "This code is already used by another influencer";
  const rate = Number(f.commission_rate);
  if (f.commission_rate.trim() === "" || !Number.isFinite(rate) || rate < 0 || rate > 100) e.commission_rate = "Enter a number from 0 to 100";
  if (f.email.trim() && !EMAIL_RE.test(f.email.trim())) e.email = "Enter a valid email address, or leave it blank";
  if (f.phone.trim() && !PHONE_RE.test(f.phone.trim())) e.phone = "Digits, spaces, + ( ) - only (7–20), or leave it blank";
  return e;
}

function InfluencerList({ call }: { call: Call }) {
  const { toast } = useStore();
  const { data, error, loading, reload } = useLoad(() => call<Influencer[]>("/influencers"), [call]);
  const [edit, setEdit] = useState<{ id?: number; f: Form } | null>(null);
  const [err, setErr] = useState(""); const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverErr, setServerErr] = useState<Partial<Record<keyof Form, string>>>({});
  const taken = useMemo(() => new Set((data || []).map((i) => i.referral_code.toUpperCase())), [data]);

  const save = async () => {
    if (!edit) return;
    setTouched(true);
    if (Object.keys(formErrors(edit.f, !edit.id, taken)).length) return;
    setSaving(true); setErr(""); setServerErr({});
    const f = edit.f;
    const body = { name: f.name.trim(), platform: f.platform, commission_rate: Number(f.commission_rate), handle: f.handle.trim() || null, email: f.email.trim() || null, phone: f.phone.trim() || null, notes: f.notes.trim() || null, active: f.active };
    try {
      if (edit.id) await call(`/influencers/${edit.id}`, { method: "PATCH", body });
      else await call("/influencers", { method: "POST", body: { ...body, referral_code: f.referral_code.trim().toUpperCase() } });
      toast(`${body.name} saved`); setEdit(null); reload();
    } catch (e) {
      const m = (e as Error).message;
      if (/already in use/i.test(m)) setServerErr({ referral_code: "This code is already used by another influencer" });
      else setErr(m);
    }
    setSaving(false);
  };
  const setActive = async (i: Influencer, active: boolean) => {
    try { await call(`/influencers/${i.id}`, { method: "PATCH", body: { active } }); toast(`${i.name} ${active ? "activated" : "deactivated"}`); reload(); }
    catch (e) { toast((e as Error).message, "err"); }
  };
  const f = edit?.f; const set = (p: Partial<Form>) => setEdit((e) => e && { ...e, f: { ...e.f, ...p } });
  const errs = f ? { ...formErrors(f, !edit?.id, taken), ...serverErr } : {};
  const show = (k: keyof Form) => (touched ? errs[k] : undefined);
  const open = (e: { id?: number; f: Form }) => { setErr(""); setServerErr({}); setTouched(false); setEdit(e); };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center"><p className="text-sm text-slate-500">Deactivating an influencer stops new referral visits from being tracked. Bookings already attributed keep their commission.</p><Button icon="plus" onClick={() => open({ f: { ...blank } })}>Add influencer</Button></div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Loading /> : data && (
        <div className="card-flat overflow-hidden"><div className="overflow-x-auto"><table className="w-full">
          <thead className="bg-slate-50"><tr><Th>Influencer</Th><Th>Platform</Th><Th>Referral link</Th><Th className="text-right">Commission</Th><Th>Contact</Th><Th>Active</Th><Th /></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.map((i) => (
            <tr key={i.id}>
              <Td><div className="font-medium">{i.name}</div>{i.handle && <div className="text-xs text-slate-400">{i.handle}</div>}</Td><Td>{i.platform}</Td>
              <Td><div className="flex items-center gap-2"><span className="font-mono text-xs font-semibold">{i.referral_code}</span><button className="text-xs text-mgm-red font-semibold flex items-center gap-1" onClick={async () => toast(await copyText(i.referral_url) ? "Referral link copied" : i.referral_url)}><Icon name="copy" size={13} />Copy link</button></div><div className="text-[11px] text-slate-400 max-w-64 truncate">{i.referral_url}</div></Td>
              <Td className="text-right font-semibold">{i.commission_rate}%</Td>
              <Td className="text-xs text-slate-500">{[i.email, i.phone].filter(Boolean).join(" · ") || "—"}</Td>
              <Td><Toggle on={i.active} onChange={(v) => void setActive(i, v)} /></Td>
              <Td><Button size="sm" variant="outline" icon="edit" onClick={() => { open({ id: i.id, f: { name: i.name, platform: i.platform, referral_code: i.referral_code, commission_rate: String(i.commission_rate), handle: i.handle || "", email: i.email || "", phone: i.phone || "", notes: i.notes || "", active: i.active } }); }}>Edit</Button></Td>
            </tr>))}</tbody>
        </table>{data.length === 0 && <Empty text="No influencers yet. Add your first influencer to generate a referral link." />}</div></div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit influencer" : "Add influencer"}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button></>}>
        {f && (
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2 text-xs text-slate-500">Fields marked * are required.</div>
            <Field label="Name *" error={show("name")}><input className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Platform *"><Select value={f.platform} onChange={(v) => set({ platform: v })} options={PLATFORMS.map((p) => ({ value: p, label: p }))} /></Field>
            <Field label="Referral code *" error={show("referral_code")} hint={edit?.id ? "Codes can't be changed once links are shared" : "3–32 letters, digits, - or _ · editable until saved"}>
              <div className="flex gap-2"><input className={inputCls + " font-mono uppercase"} disabled={!!edit?.id} value={f.referral_code} onChange={(e) => { setServerErr({}); set({ referral_code: e.target.value.toUpperCase().replace(/\s/g, "") }); }} />
                {!edit?.id && <Button type="button" variant="outline" onClick={() => { setServerErr({}); set({ referral_code: suggestCode(f.name, taken) }); }}>Generate</Button>}</div>
            </Field>
            <Field label="Commission rate (%) *" error={show("commission_rate")} hint="0–100 · applies to future bookings only"><input className={inputCls} type="number" min={0} max={100} step={0.5} value={f.commission_rate} onChange={(e) => set({ commission_rate: e.target.value })} /></Field>
            <Field label={f.platform === "Blog" || f.platform === "Other" ? "Website / profile URL (optional)" : `${f.platform} handle / profile URL (optional)`}><input className={inputCls} value={f.handle} placeholder={HANDLE_HINT[f.platform]} onChange={(e) => set({ handle: e.target.value })} /></Field>
            <Field label="Email (optional)" error={show("email")}><input className={inputCls} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Phone (optional)" error={show("phone")}><input className={inputCls} value={f.phone} placeholder="+91 98400 12345" onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="Status"><Toggle on={f.active} onChange={(v) => set({ active: v })} label={f.active ? "Active" : "Inactive"} /></Field>
            <div className="sm:col-span-2"><Field label="Notes (optional)"><textarea className={inputCls + " h-20 py-2"} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field></div>
            {err && <div className="sm:col-span-2 text-sm text-red-600">{err}</div>}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------- commissions ----------
function Commissions({ call }: { call: Call }) {
  const { toast } = useStore();
  const [status, setStatus] = useState(""); const [inf, setInf] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const infl = useLoad(() => call<Influencer[]>("/influencers"), [call]);
  const { data, error, loading, reload } = useLoad(() => call<Commission[]>(`/commissions${qs({ status, influencer_id: inf, from, to })}`), [call, status, inf, from, to]);
  const [detail, setDetail] = useState<number | null>(null);
  const [payout, setPayout] = useState<Commission | null>(null); const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); try { await fn(); toast(msg); reload(); } catch (e) { toast((e as Error).message, "err"); } setBusy(false); };
  const total = (data || []).reduce((s, c) => s + (c.status === "reversed" ? 0 : c.amount), 0);

  return (
    <div className="space-y-4">
      <div className="card-flat p-3 flex flex-wrap gap-2 items-end">
        <div className="w-52"><Field label="Influencer"><Select value={inf} onChange={setInf} options={[{ value: "", label: "All influencers" }, ...(infl.data || []).map((i) => ({ value: String(i.id), label: i.name }))]} /></Field></div>
        <Field label="Paid from"><DateInput value={from} onChange={setFrom} placeholder="Any date" clearable max={to || undefined} /></Field>
        <Field label="Paid to"><DateInput value={to} onChange={setTo} placeholder="Any date" clearable min={from || undefined} /></Field>
        <div className="flex gap-1.5 flex-wrap pb-1.5">{["", "pending", "approved", "paid", "reversed"].map((s) => <button key={s} onClick={() => setStatus(s)} className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize ${status === s ? "bg-navy-950 text-white" : "bg-slate-100 text-slate-600"}`}>{s || "all"}</button>)}</div>
      </div>
      <p className="text-xs text-slate-500">Commission = influencer's rate (frozen when the booking was paid) × ticket revenue after discounts, excluding GST and add-ons. “Mark paid” records a settlement made outside this system — no money is transferred from here.</p>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data ? <Loading /> : data && (
        <div className="card-flat overflow-hidden"><div className="overflow-x-auto"><table className="w-full">
          <thead className="bg-slate-50"><tr><Th>Booking</Th><Th>Influencer</Th><Th>Paid on</Th><Th className="text-right">Basis</Th><Th className="text-right">Rate</Th><Th className="text-right">Commission</Th><Th>Status</Th><Th /></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.map((c) => (
            <tr key={c.id} className="hover:bg-mgm-yellow/10 cursor-pointer" onClick={() => setDetail(c.id)}>
              <Td><div className="font-mono font-semibold text-xs">{c.booking_ref}</div>{c.booking_status === "cancelled" && <div className="text-[11px] text-violet-600">booking cancelled</div>}</Td>
              <Td>{c.influencer}</Td><Td className="text-xs">{fmtTime(c.paid_at)}</Td><Td className="text-right">{inr(c.basis_amount)}</Td><Td className="text-right">{c.rate}%</Td>
              <Td className={`text-right font-semibold ${c.status === "reversed" ? "line-through text-slate-400" : ""}`}>{money(c.amount)}</Td><Td><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></Td>
              <Td><div className="flex gap-1.5 justify-end" onClick={(e) => e.stopPropagation()}>
                {c.status === "pending" && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => call(`/commissions/${c.id}/approve`, { method: "POST" }), "Commission approved")}>Approve</Button>}
                {c.status === "approved" && <Button size="sm" disabled={busy} onClick={() => { setRef(""); setPayout(c); }}>Mark paid</Button>}
              </div></Td>
            </tr>))}</tbody>
        </table>{data.length === 0 && <Empty text="No commissions match these filters." />}</div>
          <div className="px-4 py-3 border-t border-slate-100 text-sm text-slate-500 flex justify-between"><span>{data.length} commissions{data.length >= 200 ? " (showing latest 200)" : ""}</span><span>Not reversed: <b className="text-navy-950">{money(total)}</b></span></div></div>
      )}
      <Modal open={!!payout} onClose={() => setPayout(null)} title="Record commission payout"
        footer={<><Button variant="ghost" onClick={() => setPayout(null)}>Cancel</Button><Button disabled={ref.trim().length < 2 || busy} onClick={() => { const c = payout!; setPayout(null); void act(() => call(`/commissions/${c.id}/mark-paid`, { method: "POST", body: { payout_reference: ref.trim() } }), "Commission marked as paid"); }}>Mark paid</Button></>}>
        {payout && <div className="space-y-3 text-sm"><p>{payout.influencer} · {payout.booking_ref} · <b>{money(payout.amount)}</b></p><p className="text-slate-500">Enter the reference of the transfer you made (e.g. NEFT/UPI transaction ID). This only records the payout; it does not send money.</p><Field label="Payout reference"><input className={inputCls} value={ref} onChange={(e) => setRef(e.target.value)} autoFocus /></Field></div>}
      </Modal>
      {detail !== null && <CommissionDetail call={call} id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function CommissionDetail({ call, id, onClose }: { call: Call; id: number; onClose: () => void }) {
  const { data: c, error } = useLoad(() => call<Commission>(`/commissions/${id}`), [call, id]);
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between py-0.5"><span className="text-slate-500">{k}</span><span>{v}</span></div>;
  return (
    <Modal open wide onClose={onClose} title={c ? `Commission · ${c.booking_ref}` : "Commission"}>
      {error && <ErrorBox text={error} />}
      {c ? (
        <div className="grid md:grid-cols-2 gap-5 text-sm">
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-50 p-3"><div className="font-bold text-navy-950">{c.influencer} <span className="font-mono text-xs text-slate-500">{c.referral_code}</span></div><div className="text-slate-500">Campaign: {c.campaign || "—"} · Visit {c.visit_date || "—"} · {c.tickets} tickets</div></div>
            <div><div className="font-bold mb-1">Booking</div>
              <Row k="Ticket revenue (after discounts)" v={inr(c.ticket_net_amount)} /><Row k="Add-ons" v={inr(c.addons_amount)} /><Row k="GST" v={inr(c.tax_amount)} /><Row k="Total paid" v={<b>{inr(c.total_amount)}</b>} />
              <Row k="Booking status" v={<Badge tone={c.booking_status === "paid" ? "green" : "violet"}>{c.booking_status}</Badge>} />
            </div>
            <div className="rounded-xl border border-slate-200 p-3"><div className="font-bold mb-1">Calculation</div><div>{inr(c.basis_amount)} × {c.rate}% = <b>{money(c.amount)}</b></div><div className="text-xs text-slate-500 mt-1">Basis: {c.basis === "ticket_net_ex_gst" ? "ticket revenue excl. GST and add-ons" : "booking total excl. GST"}. Rate frozen at payment time.</div></div>
            <div><div className="font-bold mb-1">Approximate region</div><div className="text-slate-600">{[c.region.city, c.region.state, c.region.country_code].filter(Boolean).join(", ") || "Unknown"}</div></div>
          </div>
          <div><div className="font-bold mb-2">History</div>
            <ol className="space-y-2">{(c.events || []).map((e, i) => <li key={i} className="rounded-xl border border-slate-200 p-2"><div className="flex justify-between"><span>{e.from ? `${e.from} → ` : ""}<Badge tone={STATUS_TONE[e.to]}>{e.to}</Badge></span><span className="text-xs text-slate-400">{fmtTime(e.at)}</span></div>{e.note && <div className="text-xs text-slate-500 mt-1">{e.note}</div>}</li>)}</ol>
            {c.payout_reference && <div className="mt-3 text-xs">Payout reference: <span className="font-mono">{c.payout_reference}</span></div>}
            {c.reversal_reason && <div className="mt-1 text-xs text-violet-700">Reversed: {c.reversal_reason}</div>}
          </div>
        </div>
      ) : !error && <Loading />}
    </Modal>
  );
}
