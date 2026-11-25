import React, { useEffect, useRef, useState } from "react";
import { ScanResult, Staff, TODAY, evaluateScan, fmtDate, fmtTime, nowStamp, qrPayload, rid } from "./store";
import { Badge, Button, Icon, Logo, inputCls, useScrollLock, useStore } from "./ui";

export default function StaffApp() {
  const { db } = useStore();
  const [staffId, setStaffId] = useState<string | null>(() => { try { return sessionStorage.getItem("mgm-staff"); } catch { return null; } });
  const staff = db.staff.find((s) => s.id === staffId && s.active) || null;
  const login = (id: string | null) => { setStaffId(id); try { id ? sessionStorage.setItem("mgm-staff", id) : sessionStorage.removeItem("mgm-staff"); } catch { /* ignore */ } };
  return (
    <div className="min-h-[calc(100vh-44px)] bg-slate-200/60 flex justify-center">
      <div className="w-full max-w-md bg-slate-50 min-h-[calc(100vh-44px)] shadow-2xl relative">
        {staff ? <Scanner staff={staff} onLogout={() => login(null)} /> : <Login onLogin={login} />}
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (id: string) => void }) {
  const { db } = useStore();
  const [id, setId] = useState(""); const [pw, setPw] = useState(""); const [err, setErr] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const s = db.staff.find((x) => x.id === id.trim().toUpperCase());
    if (!s || s.password !== pw) return setErr("Invalid Staff ID or password");
    if (!s.active) return setErr("This staff account is deactivated. Contact your supervisor.");
    onLogin(s.id);
  };
  return (
    <div className="min-h-[calc(100vh-44px)] flex flex-col hero-mesh text-white">
      <div className="flex-1 flex flex-col justify-center px-7 hero-in">
        <Logo size={110} />
        <h1 className="mt-10 font-display text-3xl font-bold">Gate Scanner</h1>
        <p className="text-white/80 mt-1">Sign in to start validating tickets.</p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          <label className="block"><span className="text-xs font-semibold text-white/80">Staff ID</span><input value={id} onChange={(e) => setId(e.target.value)} className="mt-1 w-full h-14 rounded-2xl bg-white/10 border border-white/15 px-4 text-lg font-mono uppercase tracking-wider outline-none focus:border-mgm-yellow" placeholder="STF1024" autoComplete="username" /></label>
          <label className="block"><span className="text-xs font-semibold text-white/80">Password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="mt-1 w-full h-14 rounded-2xl bg-white/10 border border-white/15 px-4 text-lg outline-none focus:border-mgm-yellow" placeholder="••••••" autoComplete="current-password" /></label>
          {err && <p className="text-sm font-semibold text-red-400 flex items-center gap-1.5"><Icon name="alert" size={16} />{err}</p>}
          <Button type="submit" size="lg" className="w-full !h-14 !text-lg">Login</Button>
        </form>
        <button onClick={() => { setId("STF1024"); setPw("mgm123"); }} className="mt-6 rounded-2xl bg-white/5 border border-dashed border-white/20 p-3 text-left text-sm text-white/70 hover:bg-white/10">
          <span className="font-semibold text-mgm-yellow">Demo login</span> – tap to fill: <span className="font-mono">STF1024</span> / <span className="font-mono">mgm123</span>
        </button>
      </div>
      <p className="text-center text-xs text-white/40 pb-6">Prototype · illustrative data</p>
    </div>
  );
}

type Res = ScanResult & { at: string };

function Scanner({ staff, onLogout }: { staff: Staff; onLogout: () => void }) {
  const { db, update } = useStore();
  const [result, setResult] = useState<Res | null>(null);
  const [manual, setManual] = useState("");
  const [picker, setPicker] = useState(false);
  const [scanning, setScanning] = useState(false);
  useScrollLock(picker);
  const [camState, setCamState] = useState<"off" | "on" | "unsupported">("off");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const myScans = db.scans.filter((s) => s.staffId === staff.id && s.at.slice(0, 10) === TODAY).sort((a, b) => b.at.localeCompare(a.at));
  const ok = myScans.filter((s) => s.result === "valid").length;

  const process = (code: string) => {
    const r = evaluateScan(code, db);
    const at = TODAY + nowStamp().slice(10);
    update((d) => {
      if (r.kind === "valid" && r.ticket) {
        const b = d.bookings.find((x) => x.id === r.booking!.id)!; const t = b.tickets.find((x) => x.id === r.ticket!.id)!;
        t.status = "used"; t.scannedAt = at; t.gate = staff.gate;
      }
      d.scans.push({ id: rid(8), at, ticketId: r.ticket?.id || code.slice(0, 20), bookingId: r.booking?.id || "-", gate: staff.gate, staffId: staff.id, result: r.kind, reason: r.reason });
    });
    setResult({ ...r, at });
    stopCam();
    try { navigator.vibrate?.(r.kind === "valid" ? 80 : [80, 60, 80]); } catch { /* ignore */ }
  };

  const stopCam = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCamState((c) => (c === "on" ? "off" : c)); };
  useEffect(() => () => stopCam(), []);
  const startScan = async () => {
    const BD = (window as unknown as { BarcodeDetector?: new (o: object) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!BD || !navigator.mediaDevices?.getUserMedia) { setCamState("unsupported"); simulate(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream; setCamState("on");
      const v = videoRef.current!; v.srcObject = stream; await v.play();
      const det = new BD({ formats: ["qr_code"] });
      const loop = async () => {
        if (!streamRef.current) return;
        try { const codes = await det.detect(v); if (codes[0]) { process(codes[0].rawValue); return; } } catch { /* keep trying */ }
        requestAnimationFrame(loop);
      };
      loop();
    } catch { setCamState("unsupported"); simulate(); }
  };
  const simulate = () => { setScanning(true); setTimeout(() => { setScanning(false); setPicker(true); }, 900); };

  // demo tickets for the simulated scan
  const demo = (() => {
    const out: { label: string; hint: string; code: string; tone: string }[] = [];
    const latest = db.bookings.find((b) => b.live && b.payment.status === "paid" && b.tickets.some((t) => t.status === "valid"));
    if (latest) { const t = latest.tickets.find((x) => x.status === "valid")!; out.push({ label: `Your new booking · ${latest.customer.name}`, hint: `${t.label} · visit ${fmtDate(latest.visitDate, { day: "numeric", month: "short" })}`, code: qrPayload(t, latest), tone: "yellow" }); }
    const by = (n: string) => db.bookings.find((b) => b.customer.name === n);
    const add = (n: string, hint: string, tone: string, pickUsed = false) => { const b = by(n); if (!b) return; const t = b.tickets.find((x) => (pickUsed ? true : x.status === "valid")) || b.tickets[0]; out.push({ label: n.replace("Demo · ", ""), hint, code: qrPayload(t, b), tone }); };
    add("Demo · Valid Today", "Should be approved (each ticket once)", "green");
    add("Demo · Already Used", "Duplicate scan warning", "amber", true);
    add("Demo · Future Date", "Wrong visit date", "red");
    add("Demo · Payment Pending", "Payment not completed", "red");
    add("Demo · Cancelled", "Ticket cancelled", "red", true);
    add("Demo · Expired", "Visit date has passed", "red");
    out.push({ label: "Tampered / fake QR", hint: "Invalid QR code", code: "MGMDW1|TKT-FAKE0000|MGM-XXXXXX|" + TODAY + "|0000", tone: "red" });
    return out;
  })();

  if (result) return <ResultScreen r={result} staff={staff} onNext={() => { setResult(null); setManual(""); }} />;

  return (
    <div className="flex flex-col min-h-[calc(100vh-44px)]">
      <header className="hero-mesh text-white px-5 border-b-4 border-mgm-yellow pt-5 pb-6 rounded-b-[28px]">
        <div className="flex items-center justify-between"><Logo light compact /><button onClick={() => { stopCam(); onLogout(); }} className="flex items-center gap-1.5 text-sm text-white/70 hover:text-white"><Icon name="logout" size={16} />Logout</button></div>
        <div className="mt-4"><div className="text-white/80 text-sm">Hello,</div><div className="font-display text-2xl font-bold">{staff.name}</div><div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-mgm-yellow px-3 py-1 text-xs font-bold text-navy-950"><Icon name="door" size={13} />{staff.gate}</div></div>
        <div className="mt-5 grid grid-cols-3 gap-2 text-center">
          <Stat v={myScans.length} l="Scans today" /><Stat v={ok} l="Successful" c="text-emerald-400" /><Stat v={myScans.length - ok} l="Rejected" c="text-red-400" />
        </div>
      </header>

      <div className="px-5 -mt-1 pt-5 flex-1 flex flex-col">
        <div className="relative aspect-square w-full rounded-[28px] bg-navy-950 overflow-hidden">
          <video ref={videoRef} className={`absolute inset-0 h-full w-full object-cover ${camState === "on" ? "" : "hidden"}`} muted playsInline />
          {camState !== "on" && <div className="absolute inset-0 grid place-items-center"><div className="text-center text-white/75 px-8"><Icon name="camera" size={40} className="mx-auto" /><p className="mt-2 text-sm">{camState === "unsupported" ? "Camera isn't available in this preview – using simulated scanning." : "Point the camera at the visitor's QR ticket"}</p></div></div>}
          <div className="absolute inset-10 rounded-3xl"><span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />{(scanning || camState === "on") && <span className="scanline" />}</div>
          {scanning && <div className="absolute bottom-4 inset-x-0 text-center text-sm font-semibold text-mgm-yellow">Reading QR…</div>}
        </div>
        <Button size="lg" className="mt-4 w-full !h-16 !text-lg !rounded-2xl" icon="scan" onClick={startScan} disabled={scanning}>{camState === "on" ? "Scanning…" : "Scan QR"}</Button>
        {camState === "on" && <button onClick={stopCam} className="mt-2 text-sm font-semibold text-slate-500">Stop camera</button>}

        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) process(manual); }}>
          <div className="relative flex-1"><Icon name="keyboard" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={manual} onChange={(e) => setManual(e.target.value.toUpperCase())} className={inputCls + " !h-12 pl-9 font-mono"} placeholder="Enter ticket ID (TKT-…)" aria-label="Manual ticket ID" /></div>
          <Button type="submit" variant="dark" className="!h-12" disabled={!manual.trim()}>Check</Button>
        </form>

        <div className="mt-6 mb-6">
          <div className="flex items-center justify-between mb-2"><h3 className="font-bold text-navy-950 flex items-center gap-1.5"><Icon name="history" size={17} />Scan history</h3><span className="text-xs text-slate-400">Today · {staff.gate}</span></div>
          {myScans.length === 0 && <p className="rounded-2xl bg-white p-4 text-center text-sm text-slate-500">No scans yet today.</p>}
          <div className="space-y-2 stagger">
            {myScans.slice(0, 8).map((s) => {
              const b = db.bookings.find((x) => x.id === s.bookingId);
              return (
                <div key={s.id} className="flex items-center gap-3 rounded-2xl bg-white p-3">
                  <span className={`grid h-9 w-9 place-items-center rounded-full ${s.result === "valid" ? "bg-emerald-100 text-emerald-600" : s.result === "duplicate" ? "bg-amber-100 text-amber-600" : "bg-red-100 text-red-600"}`}><Icon name={s.result === "valid" ? "check" : s.result === "duplicate" ? "alert" : "x"} size={17} strokeWidth={3} /></span>
                  <div className="flex-1 min-w-0"><div className="text-sm font-semibold text-navy-950 truncate">{b?.customer.name || "Unknown ticket"}</div><div className="text-xs text-slate-500 font-mono truncate">{s.ticketId}</div></div>
                  <div className="text-right"><div className="text-xs font-semibold">{new Date(s.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</div><div className="text-[10px] text-slate-400 max-w-28 truncate">{s.reason}</div></div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {picker && (
        <div className="fixed inset-0 z-[70] bg-navy-950/60 flex items-end justify-center" onClick={() => setPicker(false)}>
          <div className="slide-up w-full max-w-md bg-white rounded-t-[28px] p-5 max-h-[80%] overflow-y-auto overscroll-contain" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto h-1.5 w-12 rounded-full bg-slate-200 mb-4" />
            <h3 className="font-display text-lg font-bold text-navy-950">Simulate a scan</h3>
            <p className="text-sm text-slate-500 mb-3">Choose a ticket to "hold up" to the camera. Each option uses a real QR payload from the shared booking data.</p>
            <div className="space-y-2 stagger">
              {demo.map((d) => (
                <button key={d.label} onClick={() => { setPicker(false); process(d.code); }} className="w-full flex items-center gap-3 rounded-2xl border border-slate-200 p-3 text-left hover:border-navy-950">
                  <span className={`h-10 w-10 grid place-items-center rounded-xl ${d.tone === "green" ? "bg-emerald-100 text-emerald-700" : d.tone === "amber" ? "bg-amber-100 text-amber-700" : d.tone === "yellow" ? "bg-mgm-yellow text-navy-950" : "bg-red-100 text-red-700"}`}><Icon name="qr" size={19} /></span>
                  <div className="flex-1 min-w-0"><div className="font-semibold text-navy-950 text-sm">{d.label}</div><div className="text-xs text-slate-500">{d.hint}</div></div><Icon name="right" size={16} className="text-slate-400" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
const Stat = ({ v, l, c = "text-white" }: { v: number; l: string; c?: string }) => <div className="rounded-2xl bg-white/10 py-2.5"><div className={`font-display text-2xl font-bold ${c}`}>{v}</div><div className="text-[11px] text-white/80">{l}</div></div>;

function ResultScreen({ r, staff, onNext }: { r: Res; staff: Staff; onNext: () => void }) {
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
            <Row k="Party size" v={`${r.booking.tickets.length} tickets on booking`} />
          </div>
        )}
        <p className="mt-4 text-center text-xs text-white/70">{staff.gate} · {new Date(r.at).toLocaleTimeString("en-IN")}</p>
      </div>
      <div className="p-5"><button onClick={onNext} className="w-full h-16 rounded-2xl bg-white text-navy-950 font-display text-lg font-bold flex items-center justify-center gap-2 active:scale-[.98]"><Icon name="scan" />Scan next visitor</button></div>
    </div>
  );
}
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-3"><span className="text-slate-500">{k}</span><span className="font-semibold text-right">{v}</span></div>;
