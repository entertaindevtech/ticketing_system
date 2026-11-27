// Gate scanner. Staff sign in with their own account (server session); every scan is validated and recorded by
// the server (signature, payment, cancellation, date, and an atomic one-time admit). The browser never approves a
// ticket: no server answer means "not checked", never "valid".
import React, { useCallback, useEffect, useRef, useState } from "react";
import { fmtDate, fmtTime } from "./store";
import { ApiError, api, idemKey } from "./api";
import { CAM_MESSAGES, type CamProblem, type Detector, type Outcome, type ScanKind, beep, camProblem, isBookingCode, getDetector, openCamera, outcome } from "./scan";
import { Badge, Button, Icon, Logo, inputCls, type Me, useStore } from "./ui";
import { GroupScreen, type GroupView } from "./group";

type ScanRow = { id: string; at: string; ticketId: string; bookingId: string; gate: string; staffId: string; result: ScanKind; reason: string };
type Res = {
  kind: ScanKind; title: string; reason: string; at: string;
  ticket?: { id: string; catId: string; label: string; status: string };
  booking?: { id: string; visitDate: string; customer: { name: string; visitors: number }; tickets: number };
  previous?: { at: string; gate: string };
};
/** A scan the server did not answer: kept with its scan id so a retry is recognised by the server, not counted twice. */
type Failed = { code: string; scanId: string; message: string };

const pref = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
/** A stable id for this scanning device, so a retried request is recognised by the server (not counted twice). */
function deviceId() {
  let d = pref("mgm-scanner-device", "");
  if (!d) { d = idemKey(); setPref("mgm-scanner-device", d); }
  return d;
}

export default function StaffApp() {
  const { me, setMe } = useStore();
  const canScan = !!me && (me.roles.includes("gate") || me.roles.includes("admin"));
  return (
    <div className="staff-h bg-slate-200/60 flex justify-center">
      <div className="w-full max-w-md bg-slate-50 staff-h shadow-2xl relative">
        {me && canScan ? <Scanner staff={me} onLogout={async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => undefined); setMe(null); }} />
          : <StaffLogin title="Gate Scanner" subtitle={me ? "This account has no gate access. Sign in with a gate staff account." : "Sign in to start validating tickets."}><InstallHint /></StaffLogin>}
      </div>
    </div>
  );
}

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
/** Install button (Android/desktop Chrome) or Add-to-Home-Screen steps (iOS). */
function InstallHint() {
  const [evt, setEvt] = useState<InstallEvent | null>(null);
  useEffect(() => {
    const f = (e: Event) => { e.preventDefault(); setEvt(e as InstallEvent); };
    window.addEventListener("beforeinstallprompt", f); return () => window.removeEventListener("beforeinstallprompt", f);
  }, []);
  const installed = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
  if (installed) return null;
  const box = "mt-6 rounded-2xl bg-white/10 p-4 text-sm text-white/85";
  if (evt) return <button onClick={async () => { await evt.prompt(); await evt.userChoice; setEvt(null); }} className={box + " w-full flex items-center justify-center gap-2 font-bold"}><Icon name="download" size={18} />Install the gate app on this phone</button>;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return <p className={box}><b>Install on iPhone:</b> open this page in Safari, tap the Share button, then <b>Add to Home Screen</b>.</p>;
  return <p className={box}><b>Install:</b> open your browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.</p>;
}

export function StaffLogin({ title, subtitle, children }: { title: string; subtitle: string; children?: React.ReactNode }) {
  const { setMe } = useStore();
  const [id, setId] = useState(""); const [pw, setPw] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { const u = await api<{ id: string; name: string; roles: string[]; gate: string }>("/api/auth/login", { method: "POST", body: { code: id.trim().toUpperCase(), password: pw } }); setMe(u as Me); }
    catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };
  return (
    <div className="staff-h flex flex-col hero-mesh text-white">
      <div className="flex-1 flex flex-col justify-center px-6 xs:px-7 safe-pad hero-in">
        <Logo size={96} />
        <h1 className="mt-8 font-display text-3xl font-bold">{title}</h1>
        <p className="text-white/80 mt-1">{subtitle}</p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          <label className="block"><span className="text-xs font-semibold text-white/80">Staff ID</span><input value={id} onChange={(e) => setId(e.target.value)} className="mt-1 w-full h-14 rounded-2xl bg-white/10 border border-white/15 px-4 text-lg font-mono uppercase tracking-wider outline-none focus:border-mgm-yellow" placeholder="STF1024" autoComplete="username" autoCapitalize="characters" /></label>
          <label className="block"><span className="text-xs font-semibold text-white/80">Password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="mt-1 w-full h-14 rounded-2xl bg-white/10 border border-white/15 px-4 text-lg outline-none focus:border-mgm-yellow" placeholder="••••••••••" autoComplete="current-password" /></label>
          {err && <p className="text-sm font-semibold text-red-300 flex items-center gap-1.5" role="alert"><Icon name="alert" size={16} />{err}</p>}
          <Button type="submit" size="lg" className="w-full !h-14 !text-lg" disabled={busy || !id || !pw}>{busy ? "Signing in…" : "Sign in"}</Button>
        </form>
        <p className="mt-6 text-xs text-white/60">Accounts are created by an MGM administrator. Ask your supervisor if you can't sign in.</p>
        {children}
      </div>
    </div>
  );
}

function Scanner({ staff, onLogout }: { staff: Me; onLogout: () => void }) {
  const { setMe, toast } = useStore();
  const [result, setResult] = useState<Res | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [group, setGroup] = useState<{ code: string; view: GroupView } | null>(null);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [cam, setCam] = useState<"off" | "starting" | "on" | CamProblem>("off");
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [sound, setSound] = useState(() => pref("mgm-scanner-sound", "off") === "on");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pending = useRef(false); // one request at a time: a QR held in front of the camera is submitted once
  const lastCam = useRef<string | undefined>(undefined);
  const resume = useRef(false); // reopen the camera after "Scan next" when the last scan came from it
  const [sum, setSum] = useState<{ admissions: number; people: number; rejected: number } | null>(null);
  const loadScans = useCallback(() => {
    api<ScanRow[]>("/api/gate/scans").then(setScans).catch(() => undefined);
    api<{ admissions: number; people: number; rejected: number }>("/api/gate/summary").then(setSum).catch(() => undefined);
  }, []);
  useEffect(loadScans, [loadScans]);

  const stopCam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCam((c) => (c === "on" || c === "starting" ? "off" : c));
  }, []);

  const submit = async (code: string, scanId = idemKey()) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      if (isBookingCode(code)) { // group booking QR: show what it allows; nobody is admitted until staff confirm
        const v = await api<GroupView>("/api/gate/booking", { method: "POST", body: { code: code.trim() } });
        setFailed(null); setGroup({ code: code.trim(), view: v });
        if (v.status !== "VALID") { try { navigator.vibrate?.([200, 80, 200]); } catch { /* not supported */ } if (sound) beep(false); }
        loadScans();
        return;
      }
      const r = await api<Res>("/api/gate/scan", { method: "POST", body: { code: code.trim(), device_id: deviceId(), client_scan_id: scanId } });
      const o = outcome(r);
      setFailed(null); setResult(r);
      try { navigator.vibrate?.(o === "valid" ? 120 : [200, 80, 200]); } catch { /* not supported */ }
      if (sound) beep(o === "valid");
      loadScans();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { stopCam(); toast("Your session has ended. Sign in again.", "err"); setMe(null); }
      else { setResult(null); setFailed({ code, scanId, message: (e as Error).message }); try { navigator.vibrate?.([200, 80, 200]); } catch { /* not supported */ } }
    } finally { pending.current = false; setBusy(false); }
  };

  const startCam = async (deviceId?: string) => {
    if (streamRef.current) stopCam();
    setCam("starting");
    let det: Detector;
    try { det = await getDetector(); } catch { setCam("unsupported"); return; }
    let stream: MediaStream;
    try { stream = await openCamera(deviceId); } catch (e) { setCam(camProblem(e)); return; }
    const v = videoRef.current;
    if (!v) { stream.getTracks().forEach((t) => t.stop()); return; } // screen closed while the camera was opening
    streamRef.current = stream;
    lastCam.current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    v.srcObject = stream;
    try { await v.play(); } catch { /* autoplay is allowed for muted inline video; keep going */ }
    setCam("on");
    navigator.mediaDevices.enumerateDevices().then((d) => setCams(d.filter((x) => x.kind === "videoinput"))).catch(() => undefined);
    let last = 0;
    const loop = async (t: number) => {
      if (streamRef.current !== stream) return; // stopped or switched
      if (t - last > 150 && !pending.current && v.readyState >= 2) {
        last = t;
        try {
          const code = (await det.detect(v))[0]?.rawValue;
          if (code && streamRef.current === stream) { resume.current = true; stopCam(); void submit(code); return; }
        } catch { /* frame not readable yet: try the next one */ }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  };
  const switchCam = () => {
    const i = cams.findIndex((c) => c.deviceId === lastCam.current);
    void startCam(cams[(i + 1) % cams.length]?.deviceId);
  };

  // Release the camera when the app is backgrounded or this screen closes.
  useEffect(() => {
    const f = () => { if (document.hidden) stopCam(); };
    document.addEventListener("visibilitychange", f);
    return () => { document.removeEventListener("visibilitychange", f); stopCam(); };
  }, [stopCam]);

  const next = () => {
    setResult(null); setFailed(null); setGroup(null); setManual(""); loadScans();
    if (resume.current) { resume.current = false; setTimeout(() => void startCam(lastCam.current), 0); }
  };

  if (group) return <GroupScreen code={group.code} view={group.view} staff={staff} deviceId={deviceId()} sound={sound} onNext={next} />;
  if (failed) return <FailedScreen f={failed} busy={busy} gate={staff.gate} onRetry={() => void submit(failed.code, failed.scanId)} onCancel={next} />;
  if (result) return <ResultScreen r={result} gate={staff.gate} onNext={next} />;

  const camOn = cam === "on" || cam === "starting";
  const problem = cam !== "off" && !camOn ? CAM_MESSAGES[cam] : "";
  return (
    <div className="flex flex-col staff-h">
      <header className="bg-mgm-green text-white px-4 pt-[max(.75rem,env(safe-area-inset-top))] pb-3 border-b-4 border-mgm-yellow">
        <div className="flex items-center gap-2 xs:gap-3">
          <Logo compact size={36} />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-white/70 truncate">{staff.name}</div>
            <div className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-mgm-yellow px-3 py-1 text-sm font-bold text-navy-950"><Icon name="door" size={14} /><span className="truncate">{staff.gate || "No gate assigned"}</span></div>
          </div>
          <button onClick={() => { const v = !sound; setSound(v); setPref("mgm-scanner-sound", v ? "on" : "off"); if (v) beep(true); }} aria-pressed={sound}
            className="h-11 shrink-0 rounded-xl px-3 text-xs font-semibold bg-white/10 hover:bg-white/20">Sound {sound ? "on" : "off"}</button>
          <button onClick={() => { stopCam(); onLogout(); }} className="h-11 w-11 shrink-0 grid place-items-center rounded-xl bg-white/10 hover:bg-white/20" aria-label="Log out"><Icon name="logout" size={18} /></button>
        </div>
        <div className="mt-3 flex justify-between gap-2 text-xs text-white/80">
          <span title="Ticket scans and group admissions you recorded today">Admissions <b className="text-white text-sm">{sum?.admissions ?? "–"}</b></span>
          <span title="People currently admitted by you today (after any supervisor corrections)">People in <b className="text-emerald-300 text-sm">{sum?.people ?? "–"}</b></span>
          <span>Rejected <b className="text-red-300 text-sm">{sum?.rejected ?? "–"}</b></span>
        </div>
      </header>

      <div className="px-4 pt-4 flex-1 flex flex-col">
        <div className="relative mx-auto aspect-square w-full max-w-[min(100%,48dvh)] rounded-3xl bg-navy-950 overflow-hidden">
          <video ref={videoRef} className={`absolute inset-0 h-full w-full object-cover ${cam === "on" ? "" : "invisible"}`} muted playsInline aria-label="Camera view" />
          {cam !== "on" && <div className="absolute inset-0 grid place-items-center"><div className="text-center text-white/85 px-8">
            <Icon name={problem ? "alert" : "camera"} size={40} className={`mx-auto ${problem ? "text-mgm-yellow" : ""}`} />
            <p className="mt-2 text-base" role={problem ? "alert" : undefined}>{cam === "starting" ? "Starting camera…" : problem || "Tap Scan QR, then point the camera at the visitor's ticket"}</p>
          </div></div>}
          <div className="absolute inset-[12%] pointer-events-none"><span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />{cam === "on" && !busy && <span className="scanline" />}</div>
          {cam === "on" && <div className="absolute top-3 left-3 rounded-full bg-black/60 px-3 py-1 text-xs font-bold text-white flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />Scanning</div>}
          {busy && <div className="absolute inset-0 grid place-items-center bg-black/60"><div className="flex items-center gap-2 text-lg font-bold text-mgm-yellow"><span className="h-5 w-5 rounded-full border-2 border-mgm-yellow/40 border-t-mgm-yellow animate-spin" />Checking ticket…</div></div>}
          {camOn && <div className="absolute bottom-3 inset-x-3 flex gap-2">
            {cams.length > 1 && <button onClick={switchCam} className="flex-1 h-12 rounded-xl bg-black/60 text-white text-sm font-semibold flex items-center justify-center gap-1.5"><Icon name="refresh" size={16} />Switch camera</button>}
            <button onClick={stopCam} className="flex-1 h-12 rounded-xl bg-black/60 text-white text-sm font-semibold">Stop camera</button>
          </div>}
        </div>
        {!camOn && <Button size="lg" className="mt-4 w-full !h-16 !text-lg !rounded-2xl" icon="scan" onClick={() => void startCam(lastCam.current)} disabled={busy}>{problem ? "Try camera again" : "Scan QR"}</Button>}

        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) { resume.current = false; void submit(manual); } }}>
          <div className="relative flex-1 min-w-0"><Icon name="keyboard" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={manual} onChange={(e) => setManual(e.target.value)} className={inputCls + " !h-14 pl-9 font-mono !text-base"} placeholder="Ticket ID or QR text" aria-label="Ticket ID or QR text" autoCapitalize="characters" autoComplete="off" enterKeyHint="go" /></div>
          <Button type="submit" variant="dark" className="!h-14 !px-5" disabled={!manual.trim() || busy}>Check</Button>
        </form>

        <div className="mt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between gap-2 mb-2"><h3 className="font-bold text-navy-950 flex items-center gap-1.5"><Icon name="history" size={17} />Recent scans</h3><span className="text-xs text-slate-500 truncate">{staff.gate}</span></div>
          {scans.length === 0 && <p className="rounded-2xl bg-white p-4 text-center text-sm text-slate-500">No scans yet today.</p>}
          <div className="space-y-2">
            {scans.slice(0, 8).map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-2xl bg-white p-3">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${s.result === "valid" ? "bg-emerald-100 text-emerald-700" : s.result === "duplicate" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}><Icon name={s.result === "valid" ? "check" : s.result === "duplicate" ? "alert" : "x"} size={17} strokeWidth={3} /></span>
                <div className="flex-1 min-w-0"><div className="text-sm font-semibold text-navy-950 truncate">{s.bookingId !== "-" ? s.bookingId : "Unknown ticket"}</div><div className="text-xs text-slate-500 font-mono truncate">{s.ticketId}</div></div>
                <div className="text-right min-w-0 max-w-[40%]"><div className="text-xs font-semibold">{s.at.slice(11, 16)}</div><div className="text-[11px] text-slate-500 truncate">{s.reason}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const THEMES: Record<Outcome, { bg: string; text: string; icon: string; iconCls: string; head: string; sub: (r: Res) => string }> = {
  valid: { bg: "bg-emerald-700", text: "text-white", icon: "check", iconCls: "text-emerald-700", head: "VALID TICKET", sub: () => "Entry approved — admit visitor" },
  duplicate: { bg: "bg-amber-400", text: "text-navy-950", icon: "alert", iconCls: "text-amber-600", head: "ALREADY SCANNED", sub: () => "Do not admit — this ticket has already been used" },
  cancelled: { bg: "bg-orange-700", text: "text-white", icon: "x", iconCls: "text-orange-700", head: "TICKET CANCELLED", sub: () => "Do not admit — this booking or ticket was cancelled" },
  invalid: { bg: "bg-red-700", text: "text-white", icon: "x", iconCls: "text-red-700", head: "INVALID TICKET", sub: (r) => `Do not admit — ${r.reason}` },
};

function ResultScreen({ r, gate, onNext }: { r: Res; gate: string; onNext: () => void }) {
  const o = outcome(r); const t = THEMES[o];
  return (
    <div className={`staff-h ${t.bg} ${t.text} flex flex-col ${o !== "valid" ? "shake" : ""}`} role="alert">
      <div className="flex-1 px-5 pt-[max(2rem,env(safe-area-inset-top))] flex flex-col">
        <div className="mx-auto grid h-24 w-24 place-items-center rounded-full bg-white pop-in"><Icon name={t.icon} size={56} strokeWidth={3.2} className={t.iconCls} /></div>
        <h1 className="mt-5 text-center font-display text-3xl xs:text-4xl font-extrabold leading-tight">{t.head}</h1>
        <p className="text-center text-lg font-bold mt-2">{t.sub(r)}</p>
        {r.kind === "duplicate" && r.previous && (
          <div className="mt-4 rounded-2xl bg-navy-950/15 p-4 text-base"><div className="font-bold mb-1 flex items-center gap-1.5"><Icon name="history" size={16} />First scanned</div><div>{r.previous.at ? fmtTime(r.previous.at) : "—"} · {r.previous.gate || "—"}</div></div>
        )}
        {r.booking && r.ticket && (
          <div className="mt-4 rounded-3xl bg-white text-navy-950 p-4 xs:p-5 space-y-2.5 text-sm">
            <Row k="Ticket category" v={<>{r.ticket.label}{r.ticket.catId.startsWith("f") && <Badge tone="red" className="ml-1">FAST</Badge>}</>} />
            <Row k="Booking ref" v={<span className="font-mono">{r.booking.id}</span>} />
            <Row k="Ticket ID" v={<span className="font-mono">{r.ticket.id}</span>} />
            <Row k="Scan status" v={<Badge tone={o === "valid" ? "green" : o === "duplicate" ? "amber" : "red"}>{o === "valid" ? "Checked in now" : r.ticket.status}</Badge>} />
            <Row k="Visit date" v={fmtDate(r.booking.visitDate)} />
            <Row k="Customer" v={r.booking.customer.name} />
            <Row k="Party size" v={`${r.booking.tickets} tickets on booking`} />
          </div>
        )}
        <p className="mt-4 text-center text-xs opacity-80">{gate} · {r.at.slice(11, 19)}</p>
      </div>
      <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"><button autoFocus onClick={onNext} className="w-full h-16 rounded-2xl bg-navy-950 text-white font-display text-xl font-bold flex items-center justify-center gap-2 active:scale-[.98]"><Icon name="scan" />Scan next visitor</button></div>
    </div>
  );
}

function FailedScreen({ f, busy, gate, onRetry, onCancel }: { f: Failed; busy: boolean; gate: string; onRetry: () => void; onCancel: () => void }) {
  return (
    <div className="staff-h bg-navy-900 text-white flex flex-col" role="alert">
      <div className="flex-1 px-5 pt-[max(2rem,env(safe-area-inset-top))] flex flex-col">
        <div className="mx-auto grid h-24 w-24 place-items-center rounded-full bg-mgm-yellow text-navy-950"><Icon name="alert" size={52} strokeWidth={3} /></div>
        <h1 className="mt-5 text-center font-display text-3xl font-extrabold leading-tight">NOT CHECKED</h1>
        <p className="text-center text-lg font-bold mt-2 text-mgm-yellow">Do not admit yet — the ticket could not be validated.</p>
        <p className="mt-4 rounded-2xl bg-white/10 p-4 text-base">{f.message}</p>
        <p className="mt-3 text-sm text-white/70 break-all">Code: <span className="font-mono">{f.code.slice(0, 80)}</span> · {gate}</p>
      </div>
      <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] space-y-3">
        <button autoFocus onClick={onRetry} disabled={busy} className="w-full h-16 rounded-2xl bg-mgm-yellow text-navy-950 font-display text-xl font-bold flex items-center justify-center gap-2 disabled:opacity-60"><Icon name="refresh" />{busy ? "Checking…" : "Retry"}</button>
        <button onClick={onCancel} disabled={busy} className="w-full h-14 rounded-2xl bg-white/10 font-semibold">Back to scanner</button>
      </div>
    </div>
  );
}
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-3"><span className="text-slate-500 shrink-0">{k}</span><span className="font-semibold text-right min-w-0 break-words">{v}</span></div>;
