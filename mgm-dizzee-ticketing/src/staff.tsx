// Gate scanner. Staff sign in with their own account (server session); every scan is validated and recorded by
// the server (signature, payment, cancellation, date, and an atomic one-time admit).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { fmtDate, fmtTime } from "./store";
import { api, idemKey } from "./api";
import { Badge, Button, Icon, Logo, inputCls, type Me, useStore } from "./ui";

type ScanRow = { id: string; at: string; ticketId: string; bookingId: string; gate: string; staffId: string; result: "valid" | "duplicate" | "invalid"; reason: string };
type Res = {
  kind: "valid" | "duplicate" | "invalid"; title: string; reason: string; at: string;
  ticket?: { id: string; catId: string; label: string; status: string };
  booking?: { id: string; visitDate: string; customer: { name: string; visitors: number }; tickets: number };
  previous?: { at: string; gate: string };
};

/** A stable id for this scanning device, so a retried request is recognised by the server (not counted twice). */
function deviceId() {
  try { let d = localStorage.getItem("mgm-scanner-device"); if (!d) { d = idemKey(); localStorage.setItem("mgm-scanner-device", d); } return d; } catch { return "unknown-device"; }
}

export default function StaffApp() {
  const { me, setMe } = useStore();
  const canScan = !!me && (me.roles.includes("gate") || me.roles.includes("admin"));
  return (
    <div className="min-h-[calc(100vh-44px)] bg-slate-200/60 flex justify-center">
      <div className="w-full max-w-md bg-slate-50 min-h-[calc(100vh-44px)] shadow-2xl relative">
        {me && canScan ? <Scanner staff={me} onLogout={async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => undefined); setMe(null); }} />
          : <StaffLogin title="Gate Scanner" subtitle={me ? "This account has no gate access. Sign in with a gate staff account." : "Sign in to start validating tickets."} />}
      </div>
    </div>
  );
}

export function StaffLogin({ title, subtitle }: { title: string; subtitle: string }) {
  const { setMe } = useStore();
  const [id, setId] = useState(""); const [pw, setPw] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { const u = await api<{ id: string; name: string; roles: string[]; gate: string }>("/api/auth/login", { method: "POST", body: { code: id.trim().toUpperCase(), password: pw } }); setMe(u as Me); }
    catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };
  return (
    <div className="min-h-[calc(100vh-44px)] flex flex-col hero-mesh text-white">
      <div className="flex-1 flex flex-col justify-center px-7 hero-in">
        <Logo size={110} />
        <h1 className="mt-10 font-display text-3xl font-bold">{title}</h1>
        <p className="text-white/80 mt-1">{subtitle}</p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          <label className="block"><span className="text-xs font-semibold text-white/80">Staff ID</span><input value={id} onChange={(e) => setId(e.target.value)} className="mt-1 w-full h-14 rounded-2xl bg-white/10 border border-white/15 px-4 text-lg font-mono uppercase tracking-wider outline-none focus:border-mgm-yellow" placeholder="STF1024" autoComplete="username" /></label>
          <label className="block"><span className="text-xs font-semibold text-white/80">Password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="mt-1 w-full h-14 rounded-2xl bg-white/10 border border-white/15 px-4 text-lg outline-none focus:border-mgm-yellow" placeholder="••••••••••" autoComplete="current-password" /></label>
          {err && <p className="text-sm font-semibold text-red-300 flex items-center gap-1.5"><Icon name="alert" size={16} />{err}</p>}
          <Button type="submit" size="lg" className="w-full !h-14 !text-lg" disabled={busy || !id || !pw}>{busy ? "Signing in…" : "Sign in"}</Button>
        </form>
        <p className="mt-6 text-xs text-white/60">Accounts are created by an MGM administrator. Ask your supervisor if you can't sign in.</p>
      </div>
    </div>
  );
}

function Scanner({ staff, onLogout }: { staff: Me; onLogout: () => void }) {
  const { toast } = useStore();
  const [result, setResult] = useState<Res | null>(null);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [camState, setCamState] = useState<"off" | "on" | "unsupported">("off");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadScans = useCallback(() => { api<ScanRow[]>("/api/gate/scans").then(setScans).catch(() => undefined); }, []);
  useEffect(loadScans, [loadScans]);
  const ok = scans.filter((s) => s.result === "valid").length;

  const process = async (code: string) => {
    stopCam(); setBusy(true);
    try {
      const r = await api<Res>("/api/gate/scan", { method: "POST", body: { code, device_id: deviceId(), client_scan_id: idemKey() } });
      setResult(r);
      try { navigator.vibrate?.(r.kind === "valid" ? 80 : [80, 60, 80]); } catch { /* ignore */ }
      loadScans();
    } catch (e) { toast((e as Error).message, "err"); }
    setBusy(false);
  };

  const stopCam = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCamState((c) => (c === "on" ? "off" : c)); };
  useEffect(() => () => stopCam(), []);
  const startScan = async () => {
    const BD = (window as unknown as { BarcodeDetector?: new (o: object) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!BD || !navigator.mediaDevices?.getUserMedia) { setCamState("unsupported"); inputRef.current?.focus(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream; setCamState("on");
      const v = videoRef.current!; v.srcObject = stream; await v.play();
      const det = new BD({ formats: ["qr_code"] });
      const loop = async () => {
        if (!streamRef.current) return;
        try { const codes = await det.detect(v); if (codes[0]) { void process(codes[0].rawValue); return; } } catch { /* keep trying */ }
        requestAnimationFrame(loop);
      };
      loop();
    } catch { setCamState("unsupported"); inputRef.current?.focus(); }
  };

  if (result) return <ResultScreen r={result} gate={staff.gate} onNext={() => { setResult(null); setManual(""); }} />;

  return (
    <div className="flex flex-col min-h-[calc(100vh-44px)]">
      <header className="hero-mesh text-white px-5 border-b-4 border-mgm-yellow pt-5 pb-6 rounded-b-[28px]">
        <div className="flex items-center justify-between"><Logo light compact /><button onClick={() => { stopCam(); onLogout(); }} className="flex items-center gap-1.5 text-sm text-white/70 hover:text-white"><Icon name="logout" size={16} />Logout</button></div>
        <div className="mt-4"><div className="text-white/80 text-sm">Hello,</div><div className="font-display text-2xl font-bold">{staff.name}</div><div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-mgm-yellow px-3 py-1 text-xs font-bold text-navy-950"><Icon name="door" size={13} />{staff.gate || "No gate assigned"}</div></div>
        <div className="mt-5 grid grid-cols-3 gap-2 text-center">
          <Stat v={scans.length} l="My scans" /><Stat v={ok} l="Admitted" c="text-emerald-400" /><Stat v={scans.length - ok} l="Rejected" c="text-red-400" />
        </div>
      </header>

      <div className="px-5 -mt-1 pt-5 flex-1 flex flex-col">
        <div className="relative aspect-square w-full rounded-[28px] bg-navy-950 overflow-hidden">
          <video ref={videoRef} className={`absolute inset-0 h-full w-full object-cover ${camState === "on" ? "" : "hidden"}`} muted playsInline />
          {camState !== "on" && <div className="absolute inset-0 grid place-items-center"><div className="text-center text-white/75 px-8"><Icon name="camera" size={40} className="mx-auto" /><p className="mt-2 text-sm">{camState === "unsupported" ? "Camera scanning isn't available on this device. Type the ticket ID or paste the QR text below." : "Point the camera at the visitor's QR ticket"}</p></div></div>}
          <div className="absolute inset-10 rounded-3xl"><span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />{(busy || camState === "on") && <span className="scanline" />}</div>
          {busy && <div className="absolute bottom-4 inset-x-0 text-center text-sm font-semibold text-mgm-yellow">Checking ticket…</div>}
        </div>
        <Button size="lg" className="mt-4 w-full !h-16 !text-lg !rounded-2xl" icon="scan" onClick={startScan} disabled={busy}>{camState === "on" ? "Scanning…" : "Scan QR"}</Button>
        {camState === "on" && <button onClick={stopCam} className="mt-2 text-sm font-semibold text-slate-500">Stop camera</button>}

        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) void process(manual); }}>
          <div className="relative flex-1"><Icon name="keyboard" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input ref={inputRef} value={manual} onChange={(e) => setManual(e.target.value)} className={inputCls + " !h-12 pl-9 font-mono"} placeholder="Ticket ID (TKT-…) or QR text" aria-label="Manual ticket ID" /></div>
          <Button type="submit" variant="dark" className="!h-12" disabled={!manual.trim() || busy}>Check</Button>
        </form>

        <div className="mt-6 mb-6">
          <div className="flex items-center justify-between mb-2"><h3 className="font-bold text-navy-950 flex items-center gap-1.5"><Icon name="history" size={17} />Scan history</h3><span className="text-xs text-slate-400">Today · {staff.gate}</span></div>
          {scans.length === 0 && <p className="rounded-2xl bg-white p-4 text-center text-sm text-slate-500">No scans yet today.</p>}
          <div className="space-y-2 stagger">
            {scans.slice(0, 8).map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-2xl bg-white p-3">
                <span className={`grid h-9 w-9 place-items-center rounded-full ${s.result === "valid" ? "bg-emerald-100 text-emerald-600" : s.result === "duplicate" ? "bg-amber-100 text-amber-600" : "bg-red-100 text-red-600"}`}><Icon name={s.result === "valid" ? "check" : s.result === "duplicate" ? "alert" : "x"} size={17} strokeWidth={3} /></span>
                <div className="flex-1 min-w-0"><div className="text-sm font-semibold text-navy-950 truncate">{s.bookingId !== "-" ? s.bookingId : "Unknown ticket"}</div><div className="text-xs text-slate-500 font-mono truncate">{s.ticketId}</div></div>
                <div className="text-right"><div className="text-xs font-semibold">{s.at.slice(11, 16)}</div><div className="text-[10px] text-slate-400 max-w-28 truncate">{s.reason}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
const Stat = ({ v, l, c = "text-white" }: { v: number; l: string; c?: string }) => <div className="rounded-2xl bg-white/10 py-2.5"><div className={`font-display text-2xl font-bold ${c}`}>{v}</div><div className="text-[11px] text-white/80">{l}</div></div>;

function ResultScreen({ r, gate, onNext }: { r: Res; gate: string; onNext: () => void }) {
  const theme = r.kind === "valid" ? "bg-emerald-600" : r.kind === "duplicate" ? "bg-amber-500" : "bg-red-600";
  const icon = r.kind === "valid" ? "check" : r.kind === "duplicate" ? "alert" : "x";
  return (
    <div className={`min-h-[calc(100vh-44px)] ${theme} text-white flex flex-col fade-in ${r.kind !== "valid" ? "shake" : ""}`}>
      <div className="flex-1 px-6 pt-10 flex flex-col">
        <div className="relative mx-auto grid h-28 w-28 place-items-center rounded-full bg-white/20 pop-in ring"><div className="grid h-20 w-20 place-items-center rounded-full bg-white text-current"><Icon name={icon} size={46} strokeWidth={3.2} className={r.kind === "valid" ? "text-emerald-600" : r.kind === "duplicate" ? "text-amber-500" : "text-red-600"} /></div></div>
        <h1 className="mt-6 text-center font-display text-3xl font-bold leading-tight">{r.title}</h1>
        <p className="text-center text-lg font-semibold text-white/90 mt-1">{r.kind === "valid" ? "Entry approved" : r.reason}</p>
        {r.kind === "duplicate" && r.previous && (
          <div className="mt-5 rounded-2xl bg-navy-950/25 p-4 text-sm"><div className="font-bold mb-1 flex items-center gap-1.5"><Icon name="history" size={16} />Previous scan</div><div>{r.previous.at ? fmtTime(r.previous.at) : "—"}</div><div>{r.previous.gate}</div></div>
        )}
        {r.booking && r.ticket && (
          <div className="mt-5 rounded-3xl bg-white text-navy-950 p-5 space-y-2.5 text-sm slide-up" style={{ animationDelay: ".2s" }}>
            <Row k="Customer" v={r.booking.customer.name} />
            <Row k="Booking ID" v={<span className="font-mono">{r.booking.id}</span>} />
            <Row k="Ticket ID" v={<span className="font-mono">{r.ticket.id}</span>} />
            <Row k="Ticket category" v={<>{r.ticket.label}{r.ticket.catId.startsWith("f") && <Badge tone="red" className="ml-1">FAST</Badge>}</>} />
            <Row k="Visit date" v={fmtDate(r.booking.visitDate)} />
            <Row k="Ticket status" v={<Badge tone={r.kind === "valid" ? "green" : r.kind === "duplicate" ? "amber" : "red"}>{r.kind === "valid" ? "Checked in" : r.ticket.status}</Badge>} />
            <Row k="Party size" v={`${r.booking.tickets} tickets on booking`} />
          </div>
        )}
        <p className="mt-4 text-center text-xs text-white/70">{gate} · {r.at.slice(11, 19)}</p>
      </div>
      <div className="p-5"><button onClick={onNext} className="w-full h-16 rounded-2xl bg-white text-navy-950 font-display text-lg font-bold flex items-center justify-center gap-2 active:scale-[.98]"><Icon name="scan" />Scan next visitor</button></div>
    </div>
  );
}
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-3"><span className="text-slate-500">{k}</span><span className="font-semibold text-right">{v}</span></div>;
