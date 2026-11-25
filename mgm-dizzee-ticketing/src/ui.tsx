import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DB, setToday } from "./store";
import { api } from "./api";
import { qrSvgPath } from "./qr";
import logoUrl from "./assets/logo.png";

// ---------- Icons (Lucide-style strokes) ----------
const P: Record<string, string> = {
  ticket: "M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z M13 5v2 M13 17v2 M13 11v2",
  calendar: "M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  left: "m15 18-6-6 6-6", right: "m9 18 6-6-6-6", down: "m6 9 6 6 6-6", up: "m18 15-6-6-6 6",
  plus: "M5 12h14 M12 5v14", minus: "M5 12h14", check: "M20 6 9 17l-5-5", x: "M18 6 6 18 M6 6l12 12",
  copy: "M8 8h12v12H8z M4 16V4h12",
  tag: "M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z M7.5 7.5h.01",
  gift: "M3 8h18v4H3z M12 8v13 M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7 M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
  sparkles: "M9.9 15.5A2 2 0 0 0 8.5 14l-6.1-1.6a.5.5 0 0 1 0-1L8.5 9.9A2 2 0 0 0 9.9 8.5l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 6v6l4 2",
  pin: "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z m18 2-10 7L2 6",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 16v-4 M12 8h.01",
  alert: "m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z M12 9v4 M12 17h.01",
  shield: "M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z M9 12l2 2 4-4",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8",
  user: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  home: "m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10",
  grid: "M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  chart: "M3 3v18h18 M7 16v-5 M12 16V7 M17 16v-8",
  card: "M2 5h20v14H2z M2 10h20",
  qr: "M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h2v2h-2z M19 15h2 M15 19h2 M19 19h2v2",
  scan: "M3 7V5a2 2 0 0 1 2-2h2 M17 3h2a2 2 0 0 1 2 2v2 M21 17v2a2 2 0 0 1-2 2h-2 M7 21H5a2 2 0 0 1-2-2v-2 M7 12h10",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z m21 21-4.3-4.3",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  edit: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  trash: "M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
  zap: "M13 2 3 14h9l-1 8 10-12h-9z",
  percent: "M19 5 5 19 M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  food: "M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2 M7 2v20 M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7",
  locker: "M5 11h14v10H5z M7 11V7a5 5 0 0 1 10 0v4",
  swim: "M2 18c2 0 2-1.5 4-1.5S8 18 10 18s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5 M2 22c2 0 2-1.5 4-1.5S8 22 10 22s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5 M15 4a2 2 0 1 0 0-.1 M7 14l4-6 4 3 3-2",
  vr: "M3 8h18v8h-6l-2-2h-2l-2 2H3z",
  camera: "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  cabana: "M12 2 2 9h20z M5 9v12 M19 9v12 M2 21h20 M9 21v-6h6v6",
  bank: "M3 21h18 M3 10h18 M5 6l7-3 7 3 M4 10v11 M20 10v11 M8 14v3 M12 14v3 M16 14v3",
  phoneDev: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M12 18h.01",
  arrow: "M5 12h14 M12 5l7 7-7 7",
  back: "M19 12H5 M12 19l-7-7 7-7",
  refresh: "M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16 M8 16H3v5",
  pause: "M6 4h4v16H6z M14 4h4v16h-4z", play: "M6 3l14 9-14 9z",
  history: "M3 12a9 9 0 1 0 9-9 9.8 9.8 0 0 0-6.7 2.7L3 8 M3 3v5h5 M12 7v5l4 2",
  door: "M13 4h3a2 2 0 0 1 2 2v14 M2 20h3 M13 20h9 M10 12v.01 M13 4.6v16.2a1 1 0 0 1-1.2 1L5 20V5.6a2 2 0 0 1 1.5-1.9l4-1A2 2 0 0 1 13 4.6Z",
  wallet: "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1 M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M6.3 17.7l-1.4 1.4 M19.1 4.9l-1.4 1.4",
  lock: "M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4",
  file: "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z M14 2v6h6 M8 13h8 M8 17h8",
  trend: "M22 7 13.5 15.5 8.5 10.5 2 17 M16 7h6v6",
  layers: "m12 2 10 5-10 5L2 7z M2 17l10 5 10-5 M2 12l10 5 10-5",
  rupee: "M6 3h12 M6 8h12 M6 13l8.5 8 M6 13h3 M9 13c6.7 0 6.7-10 0-10",
  ban: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M4.9 4.9l14.2 14.2",
  checkCircle: "M22 11.1V12a10 10 0 1 1-5.9-9.1 M22 4 12 14l-3-3",
  xCircle: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z m15 9-6 6 m0-6 6 6",
  keyboard: "M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12",
};
export function Icon({ name, size = 18, className = "", strokeWidth = 2 }: { name: string; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={"shrink-0 " + className} aria-hidden="true">
      <path d={P[name] || P.info} />
    </svg>
  );
}

// ---------- store context ----------
// The server is the source of truth. The store holds the public catalog and, for signed-in admin/finance staff,
// the admin console's working set (GET /api/admin/state). Every change is an API call followed by a refresh;
// nothing transactional is kept in browser storage.
export type Me = { id: string; name: string; roles: string[]; gate: string };
type Store = {
  db: DB; me: Me | null; setMe: (m: Me | null) => void;
  refresh: () => Promise<void>;
  /** Runs an API mutation, shows its error (or the success message) and refreshes the data. */
  call: <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined>;
  toast: (msg: string, tone?: "ok" | "warn" | "err") => void;
};
const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
export const hasRole = (me: Me | null, ...roles: string[]) => !!me && (me.roles.includes("admin") || roles.some((r) => me.roles.includes(r)));

const EMPTY: DB = {
  tickets: [], offers: [], addons: [], dateCfg: {}, bookings: [], scans: [], staff: [], version: 3, notifications: [], auditLog: [],
  settings: { gst: 18, openTime: "", closeTime: "", parkName: "MGM Dizzee World", phone: "", email: "", defaultCapacity: 0, cancellationFeePct: 25, cancelNoticeDays: 2 },
};

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<DB>(EMPTY);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; msg: string; tone: string }[]>([]);
  const toast = useCallback((msg: string, tone: "ok" | "warn" | "err" = "ok") => {
    const id = Date.now() + Math.random(); setToasts((t) => [...t, { id, msg, tone }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "err" ? 6000 : 3200);
  }, []);
  const refresh = useCallback(async () => {
    const cat = await api<DB & { today: string }>("/api/catalog");
    setToday(cat.today, cat.settings);
    const admin = hasRole(me, "finance") ? await api<Partial<DB>>("/api/admin/state").catch(() => ({})) : {};
    setDb({ ...EMPTY, ...cat, ...admin });
  }, [me]);
  useEffect(() => { api<Me>("/api/auth/me").then(setMe).catch(() => setMe(null)).finally(() => setChecked(true)); }, []);
  const load = useCallback(() => { setPhase("loading"); refresh().then(() => setPhase("ready")).catch((e: Error) => { setErr(e.message); setPhase("error"); }); }, [refresh]);
  useEffect(() => { if (checked) load(); }, [checked, load]);
  const call = useCallback(async <T,>(fn: () => Promise<T>, ok?: string) => {
    try { const r = await fn(); await refresh().catch(() => undefined); if (ok) toast(ok); return r; }
    catch (e) { toast((e as Error).message, "err"); await refresh().catch(() => undefined); return undefined; }
  }, [refresh, toast]);
  const store = useMemo<Store>(() => ({ db, me, setMe, refresh, call, toast }), [db, me, refresh, call, toast]);
  if (phase !== "ready") return (
    <div className="min-h-screen grid place-items-center bg-slate-50 p-6 text-center">
      {phase === "loading" ? <div className="text-slate-500 text-sm flex items-center gap-2"><span className="h-4 w-4 rounded-full border-2 border-slate-300 border-t-navy-950 animate-spin" />Loading…</div>
        : <div className="max-w-sm"><Icon name="alert" size={32} className="mx-auto text-mgm-red mb-3" /><div className="font-bold text-navy-950">{err}</div>
          <p className="text-sm text-slate-500 mt-1">Bookings, tickets and payments are handled by the MGM ticketing server.</p>
          <Button className="mt-4" icon="refresh" onClick={load}>Try again</Button></div>}
    </div>
  );
  return (
    <Ctx.Provider value={store}>
      {children}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none w-[92vw] max-w-md">
        {toasts.map((t) => (
          <div key={t.id} className={"toast-in pointer-events-auto flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-xl w-full " + (t.tone === "err" ? "bg-red-600 text-white" : t.tone === "warn" ? "bg-amber-500 text-navy-950" : "bg-navy-950 text-white")}>
            <Icon name={t.tone === "ok" ? "checkCircle" : "alert"} size={18} className={t.tone === "ok" ? "text-mgm-yellow" : ""} />{t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

// ---------- primitives ----------
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "dark" | "ghost" | "outline" | "danger" | "success"; size?: "sm" | "md" | "lg"; icon?: string; iconRight?: string };
export function Button({ variant = "primary", size = "md", icon, iconRight, className = "", children, ...rest }: BtnProps) {
  const v = {
    primary: "bg-mgm-yellow text-black hover:brightness-95 shadow-[0_8px_20px_-8px_rgba(246,205,69,.8)]",
    dark: "bg-navy-950 text-white hover:bg-navy-800 shadow-[0_8px_20px_-10px_rgba(28,27,25,.6)]",
    ghost: "text-navy-800 hover:bg-slate-100",
    outline: "border border-slate-200 text-navy-900 bg-white hover:border-navy-950 hover:bg-slate-50",
    danger: "bg-mgm-red text-white hover:bg-red-700",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
  }[variant];
  const s = { sm: "h-8 px-3.5 text-xs gap-1.5 rounded-full", md: "h-10 px-5 text-sm gap-2 rounded-full", lg: "h-12 px-7 text-base gap-2 rounded-full" }[size];
  return (
    <button {...rest} className={`inline-flex items-center justify-center font-semibold transition-all hover:-translate-y-px active:translate-y-0 active:scale-[.97] disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap ${v} ${s} ${className}`}>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 18} />}{children}{iconRight && <Icon name={iconRight} size={size === "sm" ? 14 : 18} />}
    </button>
  );
}
export function Badge({ tone = "slate", children, className = "" }: { tone?: string; children: React.ReactNode; className?: string }) {
  const t: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700", green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", red: "bg-red-50 text-red-700 ring-red-600/20",
    amber: "bg-amber-50 text-amber-700 ring-amber-600/20", blue: "bg-sky-50 text-sky-700 ring-sky-600/20", yellow: "bg-mgm-yellow text-navy-950",
    navy: "bg-navy-950 text-white", violet: "bg-violet-50 text-violet-700 ring-violet-600/20",
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ring-transparent ${t[tone] || t.slate} ${className}`}>{children}</span>;
}
export function Qty({ value, onChange, min = 0, max = 20, size = "md", addLabel, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; size?: "sm" | "md"; addLabel?: string; label?: string }) {
  const sm = size === "sm";
  const h = sm ? "h-9" : "h-11";
  const btn = sm ? "h-7 w-7" : "h-9 w-9";
  if (addLabel && value === 0) {
    return (
      <button type="button" aria-label={`${addLabel}${label ? " " + label : ""}`} disabled={max <= 0} onClick={() => onChange(1)}
        className={`${h} ${sm ? "min-w-[104px] px-3 text-sm" : "min-w-[124px] px-4 text-base"} inline-flex items-center justify-center gap-1.5 rounded-full border-2 border-navy-950 bg-white font-display font-bold uppercase tracking-wide text-navy-950 transition hover:bg-mgm-yellow active:scale-95 disabled:opacity-30`}>
        {addLabel}<Icon name="plus" size={sm ? 15 : 17} strokeWidth={3} />
      </button>
    );
  }
  return (
    <div className={`${h} ${sm ? "min-w-[104px]" : "min-w-[124px]"} inline-flex items-center justify-between gap-1 rounded-full bg-navy-950 p-1 shadow-sm`} role="group" aria-label={label ? `${label} quantity` : "Quantity"}>
      <button type="button" aria-label="Decrease" className={`${btn} grid place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/25 active:scale-90 disabled:opacity-30`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}><Icon name="minus" size={sm ? 14 : 16} strokeWidth={3} /></button>
      <span key={value} className={`pop-in min-w-6 text-center font-display font-bold tabular-nums text-white ${sm ? "text-base" : "text-lg"}`} aria-live="polite">{value}</span>
      <button type="button" aria-label="Increase" className={`${btn} grid place-items-center rounded-full bg-mgm-yellow text-navy-950 transition hover:brightness-95 active:scale-90 disabled:opacity-30`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}><Icon name="plus" size={sm ? 14 : 16} strokeWidth={3} /></button>
    </div>
  );
}
// Stops the page behind a pop-up from scrolling (supports stacked pop-ups)
let lockCount = 0;
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const b = document.body, h = document.documentElement;
    if (lockCount === 0) {
      const gap = window.innerWidth - h.clientWidth;
      b.dataset.prevOverflow = b.style.overflow; b.dataset.prevPad = b.style.paddingRight;
      b.style.overflow = "hidden"; h.style.overflow = "hidden";
      if (gap > 0) b.style.paddingRight = gap + "px";
    }
    lockCount++;
    return () => {
      lockCount--;
      if (lockCount === 0) { b.style.overflow = b.dataset.prevOverflow || ""; h.style.overflow = ""; b.style.paddingRight = b.dataset.prevPad || ""; }
    };
  }, [active]);
}
export function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; wide?: boolean; footer?: React.ReactNode }) {
  useScrollLock(open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] overscroll-contain flex items-end sm:items-center justify-center bg-navy-950/45 backdrop-blur-md p-0 sm:p-4 fade-in" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className={`slide-up bg-white w-full ${wide ? "sm:max-w-4xl" : "sm:max-w-lg"} max-h-[92vh] flex flex-col rounded-t-[28px] sm:rounded-[28px] shadow-2xl ring-1 ring-black/5`}>
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <h3 className="font-display text-xl font-bold text-navy-950">{title}</h3>
          <button onClick={onClose} className="h-9 w-9 grid place-items-center rounded-full hover:bg-slate-100" aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 py-4 flex-1">{children}</div>
        {footer && <div className="border-t border-slate-100 px-5 py-3 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>, document.body
  );
}
export function Field({ label, children, hint, error }: { label: string; children: React.ReactNode; hint?: string; error?: string }) {
  return (
    <div className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs font-medium text-red-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </div>
  );
}
export const inputCls = "w-full h-11 rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 text-sm text-navy-950 outline-none placeholder:text-slate-400 hover:border-slate-300 focus:bg-white focus:border-navy-950 focus:ring-4 focus:ring-mgm-yellow/30 transition";
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="inline-flex items-center gap-2 text-sm" role="switch" aria-checked={on}>
      <span className={`relative h-6 w-11 rounded-full transition ${on ? "bg-emerald-500" : "bg-slate-300"}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-300 ease-[cubic-bezier(.2,.8,.2,1)] ${on ? "left-[22px]" : "left-0.5"}`} /></span>
      {label && <span className="font-medium text-slate-700">{label}</span>}
    </button>
  );
}

export function QR({ text, size = 140, className = "" }: { text: string; size?: number; className?: string }) {
  const q = useMemo(() => qrSvgPath(text), [text]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${q.size} ${q.size}`} className={className} shapeRendering="crispEdges" role="img" aria-label="Ticket QR code">
      <rect width={q.size} height={q.size} fill="#fff" /><path d={q.path} fill="#111111" />
    </svg>
  );
}

export function Logo({ compact = false, size }: { light?: boolean; compact?: boolean; size?: number }) {
  const h = size || (compact ? 42 : 56);
  return <img src={logoUrl} alt="MGM Dizzee World" width={Math.round((h * 213) / 183)} height={h} style={{ height: h, width: Math.round((h * 213) / 183) }} className="shrink-0 self-start max-w-none object-contain select-none drop-shadow-sm" draggable={false} />;
}

export function useOutside(cb: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) cb(); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, [cb]);
  return ref;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok; } catch { return false; }
  }
}

// themed gradient banners for offers
export const THEMES: Record<string, { bg: string; label: string; ink: string }> = {
  sunset: { bg: "linear-gradient(135deg,#D9473F 0%,#9E2621 100%)", label: "MGM Red", ink: "#fff" },
  ocean: { bg: "linear-gradient(135deg,#3A3834 0%,#1C1B19 100%)", label: "Charcoal", ink: "#F6CD45" },
  berry: { bg: "linear-gradient(135deg,#C2541F 0%,#7A3212 100%)", label: "Rust", ink: "#fff" },
  mint: { bg: "linear-gradient(135deg,#3F7D3A 0%,#24502A 100%)", label: "Forest", ink: "#fff" },
  festive: { bg: "linear-gradient(135deg,#9E2621 0%,#4A1210 100%)", label: "Maroon", ink: "#F6CD45" },
  night: { bg: "linear-gradient(135deg,#2A2926 0%,#111111 100%)", label: "Night", ink: "#F6CD45" },
  gold: { bg: "linear-gradient(135deg,#F9DB73 0%,#E9B825 100%)", label: "MGM Yellow", ink: "#1C1B19" },
};
export function OfferArt({ theme, type, className = "" }: { theme: string; type: string; className?: string }) {
  const t = THEMES[theme] || THEMES.sunset;
  const icon = type === "bxgy" ? "gift" : type === "package" ? "users" : type === "flat" ? "tag" : "percent";
  return (
    <div className={`relative overflow-hidden ${className}`} style={{ background: t.bg }}>
      <svg className="absolute inset-0 h-full w-full opacity-25" viewBox="0 0 200 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <circle cx="170" cy="20" r="40" fill="none" stroke="#fff" strokeWidth="2" />
        {Array.from({ length: 10 }).map((_, i) => <line key={i} x1="170" y1="20" x2={170 + 40 * Math.cos(i * 0.628)} y2={20 + 40 * Math.sin(i * 0.628)} stroke="#fff" strokeWidth="1" />)}
        <path d="M0 90 Q 30 40 60 70 T 120 60 T 200 80" fill="none" stroke="#fff" strokeWidth="3" />
        <circle cx="25" cy="25" r="3" fill="#fff" /><circle cx="60" cy="15" r="2" fill="#fff" /><circle cx="110" cy="30" r="2.5" fill="#fff" />
      </svg>
      <div className="absolute left-3 bottom-3 grid h-11 w-11 place-items-center rounded-2xl bg-white/20 backdrop-blur" style={{ color: t.ink }}><Icon name={icon} size={22} /></div>
    </div>
  );
}

type PersonProps = { cx: number; cy: number; r: number; skin: string; hair: string; shirt: string; trim: string; girl?: boolean; kid?: boolean; wave?: boolean; jacket?: boolean };
function Person({ cx, cy, r, skin, hair, shirt, trim, girl, kid, wave, jacket }: PersonProps) {
  const w = kid ? r * 2.3 : r * 3.1;
  const by = cy + r + (kid ? 2 : 5);
  const body = `M${cx - w / 2},130 L${cx - w / 2},${by + 12} Q${cx - w / 2},${by} ${cx - w / 2 + 12},${by} L${cx + w / 2 - 12},${by} Q${cx + w / 2},${by} ${cx + w / 2},${by + 12} L${cx + w / 2},130 Z`;
  const ex = r * 0.38, ey = cy - r * 0.02;
  return (
    <g>
      {girl && !kid && <path d={`M${cx - r - 2},${cy - 2} Q${cx - r - 7},${cy + r * 2.1} ${cx - r + 2},${cy + r * 2.5} L${cx + r - 2},${cy + r * 2.5} Q${cx + r + 7},${cy + r * 2.1} ${cx + r + 2},${cy - 2} Z`} fill={hair} />}
      {girl && kid && <><circle cx={cx - r - 3} cy={cy - r * 0.35} r={r * 0.5} fill={hair} /><circle cx={cx + r + 3} cy={cy - r * 0.35} r={r * 0.5} fill={hair} /><circle cx={cx - r + 2} cy={cy - r * 0.75} r={3} fill="#E2574C" /><circle cx={cx + r - 2} cy={cy - r * 0.75} r={3} fill="#E2574C" /></>}
      {wave && (
        <g>
          <path d={`M${cx - w / 2 + 4},${by + 8} Q${cx - w / 2 - 10},${by - 4} ${cx - w / 2 - 10},${cy - r * 0.2}`} stroke={shirt} strokeWidth={kid ? 9 : 10} strokeLinecap="round" fill="none" />
          <circle cx={cx - w / 2 - 10} cy={cy - r * 0.45} r={kid ? 6.5 : 7} fill={skin} />
          <path d={`M${cx - w / 2 - 15},${cy - r * 0.9} l2,5 M${cx - w / 2 - 10},${cy - r * 1.05} l0,5 M${cx - w / 2 - 5},${cy - r * 0.9} l-2,5`} stroke={skin} strokeWidth="3" strokeLinecap="round" />
        </g>
      )}
      <path d={body} fill={shirt} />
      {jacket && <><rect x={cx - w * 0.16} y={by} width={w * 0.32} height={40} fill={trim} /><path d={`M${cx - w * 0.16},${by} l-4,14 l4,6 M${cx + w * 0.16},${by} l4,14 l-4,6`} stroke="#00000030" strokeWidth="2" fill="none" /></>}
      {!jacket && <path d={`M${cx - r * 0.45},${by} Q${cx},${by + r * 0.6} ${cx + r * 0.45},${by}`} stroke={trim} strokeWidth="2.5" fill="none" strokeDasharray="2 2" />}
      <rect x={cx - r * 0.28} y={cy + r * 0.7} width={r * 0.56} height={by - cy - r * 0.5} rx="3" fill={skin} />
      <circle cx={cx - r} cy={cy + 1} r={r * 0.18} fill={skin} /><circle cx={cx + r} cy={cy + 1} r={r * 0.18} fill={skin} />
      <circle cx={cx} cy={cy} r={r} fill={skin} />
      {girl
        ? <path d={`M${cx - r - 1},${cy + 2} Q${cx - r - 2},${cy - r - 4} ${cx + 2},${cy - r - 2} Q${cx + r + 3},${cy - r} ${cx + r + 1},${cy + 4} Q${cx + r - 2},${cy - r * 0.45} ${cx + r * 0.1},${cy - r * 0.62} Q${cx - r * 0.5},${cy - r * 0.45} ${cx - r - 1},${cy + 2} Z`} fill={hair} />
        : <path d={`M${cx - r - 1},${cy - 1} Q${cx - r - 1},${cy - r - 6} ${cx + 1},${cy - r - 5} Q${cx + r + 3},${cy - r - 3} ${cx + r + 1},${cy - 1} Q${cx + r - 3},${cy - r * 0.55} ${cx + r * 0.2},${cy - r * 0.62} L${cx - r * 0.1},${cy - r * 0.42} L${cx - r * 0.3},${cy - r * 0.6} Q${cx - r + 3},${cy - r * 0.5} ${cx - r - 1},${cy - 1} Z`} fill={hair} />}
      <path d={`M${cx - ex - r * 0.17},${ey - r * 0.32} q${r * 0.17},-${r * 0.1} ${r * 0.34},0 M${cx + ex - r * 0.17},${ey - r * 0.32} q${r * 0.17},-${r * 0.1} ${r * 0.34},0`} stroke={hair} strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <ellipse cx={cx - ex} cy={ey} rx={r * (kid ? 0.16 : 0.12)} ry={r * (kid ? 0.2 : 0.16)} fill="#2B1B10" /><ellipse cx={cx + ex} cy={ey} rx={r * (kid ? 0.16 : 0.12)} ry={r * (kid ? 0.2 : 0.16)} fill="#2B1B10" />
      <circle cx={cx - ex + 1} cy={ey - 1.2} r={kid ? 1.4 : 1} fill="#fff" /><circle cx={cx + ex + 1} cy={ey - 1.2} r={kid ? 1.4 : 1} fill="#fff" />
      <circle cx={cx - r * 0.58} cy={cy + r * 0.32} r={r * 0.15} fill="#F28B82" opacity=".45" /><circle cx={cx + r * 0.58} cy={cy + r * 0.32} r={r * 0.15} fill="#F28B82" opacity=".45" />
      <path d={`M${cx - r * 0.34},${cy + r * 0.3} Q${cx},${cy + r * 0.78} ${cx + r * 0.34},${cy + r * 0.3} Z`} fill="#8E2B22" />
      <path d={`M${cx - r * 0.28},${cy + r * 0.33} Q${cx},${cy + r * 0.44} ${cx + r * 0.28},${cy + r * 0.33} Z`} fill="#fff" />
    </g>
  );
}

export function TicketArt({ kind, audience }: { kind: string; audience: string }) {
  const fast = kind === "fasttrack";
  const kid = audience === "child";
  return (
    <div className="relative h-24 w-28 sm:h-28 sm:w-36 shrink-0 rounded-xl overflow-hidden ring-1 ring-black/5">
      <svg viewBox="0 0 160 125" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice" role="img" aria-label={`${kid ? "Children" : "Adults"} ${fast ? "Fast Track" : "General"} ticket`}>
        <defs>
          <linearGradient id={`bg-${kind}-${audience}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={fast ? "#FBD9D5" : "#FFF1C2"} /><stop offset="1" stopColor={fast ? "#F5B3AC" : "#FBDD7E"} />
          </linearGradient>
        </defs>
        <rect width="160" height="125" fill={`url(#bg-${kind}-${audience})`} />
        {[[14, 18, 3], [40, 8, 2], [128, 14, 2.5], [150, 40, 2], [10, 60, 2], [120, 70, 1.8], [70, 12, 1.6]].map(([x, y, rr], i) => <circle key={i} cx={x} cy={y} r={rr} fill="#fff" opacity=".8" />)}
        {kid ? (
          <>
            <Person cx={54} cy={62} r={19} skin="#E8AE7E" hair="#2B1B10" shirt="#B8BCC2" trim="#3D6FB6" kid wave jacket />
            <Person cx={110} cy={64} r={19} skin="#F0BD92" hair="#7A4A26" shirt="#3D6FB6" trim="#fff" kid girl />
          </>
        ) : (
          <>
            <Person cx={54} cy={50} r={18} skin="#D99A6C" hair="#1F140C" shirt="#9CA3AA" trim="#3D6FB6" jacket />
            <Person cx={110} cy={53} r={17} skin="#EDB78E" hair="#5B3418" shirt="#3D6FB6" trim="#fff" girl />
          </>
        )}
      </svg>
      {fast && <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-mgm-red text-mgm-yellow shadow"><Icon name="zap" size={13} /></span>}
      <span className={`absolute left-1.5 bottom-1.5 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${fast ? "bg-mgm-red text-white" : "bg-navy-950 text-mgm-yellow"}`}>{fast ? "Fast Track" : "General"}</span>
    </div>
  );
}

// ---------- themed popover, select, date & time pickers ----------
function usePopover(open: boolean, setOpen: (v: boolean) => void, width?: number) {
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean }>({ left: 0, top: 0, width: 0, up: false });
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect(); if (!r) return;
      const h = pop.current?.offsetHeight || 300;
      const w = Math.max(width || 0, r.width);
      const up = r.bottom + h + 8 > window.innerHeight && r.top - h - 8 > 0;
      setPos({ left: Math.min(r.left, window.innerWidth - w - 8), top: up ? r.top - h - 6 : r.bottom + 6, width: w, up });
    };
    place();
    const raf = requestAnimationFrame(place);
    const out = (e: MouseEvent) => { if (!anchor.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", out); document.addEventListener("keydown", esc);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); document.removeEventListener("mousedown", out); document.removeEventListener("keydown", esc); };
  }, [open]);
  return { anchor, pop, pos };
}
const triggerCls = "w-full h-11 rounded-xl border bg-white px-3.5 text-sm text-left flex items-center gap-2 outline-none transition focus:ring-2 focus:ring-mgm-yellow/60";

export type Opt = { value: string; label: string; hint?: string; dot?: string };
export function Select({ value, onChange, options, placeholder = "Select…", icon, ariaLabel }: { value: string; onChange: (v: string) => void; options: Opt[]; placeholder?: string; icon?: string; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const { anchor, pop, pos } = usePopover(open, setOpen);
  const cur = options.find((o) => o.value === value);
  useEffect(() => { if (open) setHi(Math.max(0, options.findIndex((o) => o.value === value))); }, [open]);
  const key = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpen(true); return; }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(options.length - 1, h + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    if (e.key === "Enter") { e.preventDefault(); onChange(options[hi].value); setOpen(false); }
  };
  return (
    <>
      <button type="button" ref={anchor} onClick={() => setOpen(!open)} onKeyDown={key} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        className={`${triggerCls} ${open ? "border-navy-950 ring-2 ring-mgm-yellow/60" : "border-slate-200 hover:border-slate-400"}`}>
        {icon && <Icon name={icon} size={16} className="text-slate-400" />}
        {cur?.dot && <span className="h-2 w-2 rounded-full shrink-0" style={{ background: cur.dot }} />}
        <span className={`flex-1 truncate ${cur ? "text-navy-950" : "text-slate-400"}`}>{cur ? cur.label : placeholder}</span>
        <Icon name="down" size={16} className={`text-slate-500 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && createPortal(
        <div ref={pop} role="listbox" className="fixed z-[90] rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-black/10 max-h-72 overflow-y-auto pop-open" style={{ left: pos.left, top: pos.top, width: pos.width }}>
          {options.map((o, i) => {
            const sel = o.value === value;
            return (
              <button type="button" key={o.value} role="option" aria-selected={sel} onMouseEnter={() => setHi(i)} onClick={() => { onChange(o.value); setOpen(false); }}
                className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${i === hi ? "bg-mgm-yellow/25" : ""} ${sel ? "font-semibold text-navy-950" : "text-slate-700"}`}>
                {o.dot && <span className="h-2 w-2 rounded-full shrink-0" style={{ background: o.dot }} />}
                <span className="flex-1"><span className="block">{o.label}</span>{o.hint && <span className="block text-[11px] text-slate-500 font-normal">{o.hint}</span>}</span>
                {sel && <span className="grid h-5 w-5 place-items-center rounded-full bg-navy-950 text-mgm-yellow"><Icon name="check" size={12} strokeWidth={3} /></span>}
              </button>
            );
          })}
        </div>, document.body)}
    </>
  );
}

const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const p2 = (n: number) => String(n).padStart(2, "0");
const toIso = (y: number, m: number, d: number) => `${y}-${p2(m + 1)}-${p2(d)}`;
export function DateInput({ value, onChange, min, max, placeholder = "Select date", clearable, ariaLabel }: { value: string; onChange: (v: string) => void; min?: string; max?: string; placeholder?: string; clearable?: boolean; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const { anchor, pop, pos } = usePopover(open, setOpen, 296);
  const today = (() => { const n = new Date(); return toIso(n.getFullYear(), n.getMonth(), n.getDate()); })();
  const base = value || (min && today < min ? min : max && today > max ? max : today);
  const [view, setView] = useState({ y: +base.slice(0, 4), m: +base.slice(5, 7) - 1 });
  useEffect(() => { if (open) { const b = value || base; setView({ y: +b.slice(0, 4), m: +b.slice(5, 7) - 1 }); } }, [open]);
  const first = new Date(view.y, view.m, 1); const days = new Date(view.y, view.m + 1, 0).getDate(); const lead = (first.getDay() + 6) % 7;
  const shift = (n: number) => setView((v) => { const d = new Date(v.y, v.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const prevOk = !min || toIso(view.y, view.m, 1) > min;
  const nextOk = !max || toIso(view.y, view.m, days) < max;
  const label = value ? new Date(+value.slice(0, 4), +value.slice(5, 7) - 1, +value.slice(8, 10)).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "";
  return (
    <>
      <button type="button" ref={anchor} onClick={() => setOpen(!open)} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open}
        className={`${triggerCls} ${open ? "border-navy-950 ring-2 ring-mgm-yellow/60" : "border-slate-200 hover:border-slate-400"}`}>
        <Icon name="calendar" size={16} className="text-slate-500" />
        <span className={`flex-1 truncate ${value ? "text-navy-950" : "text-slate-400"}`}>{label || placeholder}</span>
        {clearable && value ? <span role="button" tabIndex={0} aria-label="Clear date" onClick={(e) => { e.stopPropagation(); onChange(""); }} className="grid h-6 w-6 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-navy-950"><Icon name="x" size={14} /></span> : <Icon name="down" size={16} className={`text-slate-500 transition ${open ? "rotate-180" : ""}`} />}
      </button>
      {open && createPortal(
        <div ref={pop} role="dialog" aria-label="Choose date" className="fixed z-[90] w-[296px] rounded-2xl border border-slate-200 bg-white shadow-xl shadow-black/15 overflow-hidden pop-open" style={{ left: pos.left, top: pos.top }}>
          <div className="flex items-center justify-between bg-navy-950 px-3 py-2.5 text-white">
            <button type="button" disabled={!prevOk} onClick={() => shift(-1)} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-white/10 disabled:opacity-25" aria-label="Previous month"><Icon name="left" size={16} /></button>
            <div className="font-display text-base font-bold tracking-wide">{MON[view.m]} <span className="text-mgm-yellow">{view.y}</span></div>
            <button type="button" disabled={!nextOk} onClick={() => shift(1)} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-white/10 disabled:opacity-25" aria-label="Next month"><Icon name="right" size={16} /></button>
          </div>
          <div className="p-3">
            <div className="grid grid-cols-7 text-center text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">{["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => <div key={d} className="py-1">{d}</div>)}</div>
            <div className="grid grid-cols-7 gap-0.5">
              {Array.from({ length: lead }).map((_, i) => <span key={"e" + i} />)}
              {Array.from({ length: days }).map((_, i) => {
                const d = toIso(view.y, view.m, i + 1);
                const dis = (!!min && d < min) || (!!max && d > max);
                const sel = d === value; const isT = d === today;
                const wknd = [5, 6].includes((lead + i) % 7);
                return (
                  <button type="button" key={d} disabled={dis} onClick={() => { onChange(d); setOpen(false); }}
                    className={`relative h-9 rounded-lg text-sm font-semibold transition ${sel ? "bg-navy-950 text-mgm-yellow shadow" : dis ? "text-slate-300 cursor-not-allowed" : `${wknd ? "text-mgm-red" : "text-navy-950"} hover:bg-mgm-yellow/30`}`}>
                    {i + 1}{isT && !sel && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-mgm-red" />}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2">
            <button type="button" disabled={(!!min && today < min) || (!!max && today > max)} onClick={() => { onChange(today); setOpen(false); }} className="text-xs font-bold uppercase tracking-wide text-mgm-red disabled:opacity-30">Today</button>
            {clearable && <button type="button" onClick={() => { onChange(""); setOpen(false); }} className="text-xs font-semibold text-slate-500 hover:text-navy-950">Clear</button>}
          </div>
        </div>, document.body)}
    </>
  );
}

export function TimeInput({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel?: string }) {
  const opts: Opt[] = [];
  for (let h = 6; h <= 23; h++) for (const m of [0, 30]) { const v = `${p2(h)}:${p2(m)}`; opts.push({ value: v, label: `${((h + 11) % 12) + 1}:${p2(m)} ${h < 12 ? "AM" : "PM"}` }); }
  if (value && !opts.some((o) => o.value === value)) opts.unshift({ value, label: value });
  return <Select value={value} onChange={onChange} options={opts} icon="clock" ariaLabel={ariaLabel} />;
}


// ---------- motion helpers ----------
export function Reveal({ children, className = "", delay = 0, as = "div", id }: { children: React.ReactNode; className?: string; delay?: number; as?: "div" | "section"; id?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [inView, setIn] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (!("IntersectionObserver" in window)) { setIn(true); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { setIn(true); io.disconnect(); } }), { threshold: 0.12 });
    io.observe(el); return () => io.disconnect();
  }, []);
  const Tag = as as "div";
  return <Tag id={id} ref={ref as React.RefObject<HTMLDivElement>} className={`reveal ${inView ? "in" : ""} ${className}`} style={{ transitionDelay: `${delay}ms` }}>{children}</Tag>;
}

export function CountUp({ value, duration = 900 }: { value: string; duration?: number }) {
  const m = /^(\D*)([\d,]+(?:\.\d+)?)(.*)$/.exec(value);
  const target = m ? parseFloat(m[2].replace(/,/g, "")) : NaN;
  const [n, setN] = useState(isNaN(target) ? 0 : 0);
  useEffect(() => {
    if (isNaN(target)) return;
    let raf = 0; const t0 = performance.now(); const from = 0;
    const tick = (t: number) => { const k = Math.min(1, (t - t0) / duration); const e = 1 - Math.pow(1 - k, 3); setN(from + (target - from) * e); if (k < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [target]);
  if (!m || isNaN(target)) return <>{value}</>;
  const dec = (m[2].split(".")[1] || "").length;
  return <>{m[1]}{n.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec })}{m[3]}</>;
}
