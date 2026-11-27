// Gate group admission (Model A): one booking QR, several admission transactions. Staff pick how many people of each
// ticket category are entering now and confirm; the server locks the booking, re-counts what remains and records the
// admission. The browser only proposes numbers: limits, dates and cancellation are enforced by the server.
import React, { useRef, useState } from "react";
import { fmtDate } from "./store";
import { ApiError, api, idemKey } from "./api";
import { beep } from "./scan";
import { Icon, inputCls, type Me } from "./ui";

export type GroupStatus = "VALID" | "NOT_YET_VALID" | "EXPIRED" | "CANCELLED" | "UNPAID" | "INVALID";
type Line = { catId: string; label: string; quantity: number };
type Admission = { ref: string; kind: "admit" | "correction"; at: string; gate: string; staffId: string; quantity: number; reason: string | null; lines: Line[] };
type Cat = { catId: string; label: string; purchased: number; admitted: number; remaining: number };
export type GroupView = {
  status: GroupStatus; reason: string; fullyRedeemed: boolean;
  booking: { ref: string; visitDate: string; name: string } | null;
  categories: Cat[]; totals: { purchased: number; admitted: number; remaining: number } | null;
  admission: Admission | null; history: Admission[];
};

const BAD: Record<Exclude<GroupStatus, "VALID">, { bg: string; text: string; head: string }> = {
  NOT_YET_VALID: { bg: "bg-amber-400", text: "text-navy-950", head: "NOT VALID YET" },
  EXPIRED: { bg: "bg-red-700", text: "text-white", head: "EXPIRED" },
  CANCELLED: { bg: "bg-orange-700", text: "text-white", head: "BOOKING CANCELLED" },
  UNPAID: { bg: "bg-red-700", text: "text-white", head: "NOT PAID" },
  INVALID: { bg: "bg-red-700", text: "text-white", head: "INVALID QR" },
};

export function GroupScreen({ code, view: initial, staff, deviceId, sound, onNext }: { code: string; view: GroupView; staff: Me; deviceId: string; sound: boolean; onNext: () => void }) {
  const [view, setView] = useState(initial);
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(initial.categories.map((c) => [c.catId, c.remaining])));
  const [phase, setPhase] = useState<"select" | "confirm" | "done">("select");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; retry: boolean } | null>(null);
  const txn = useRef(idemKey()); // one id per admission attempt: a retry after a lost response is not a second admission
  const chosen = view.categories.filter((c) => (qty[c.catId] || 0) > 0);
  const total = chosen.reduce((n, c) => n + qty[c.catId], 0);

  const refresh = async () => {
    const v = await api<GroupView>("/api/gate/booking", { method: "POST", body: { code } });
    setView(v); setQty(Object.fromEntries(v.categories.map((c) => [c.catId, Math.min(qty[c.catId] || 0, c.remaining)])));
  };
  const confirm = async () => {
    setBusy(true); setErr(null);
    try {
      const v = await api<GroupView>("/api/gate/booking/admit", { method: "POST", body: { code, quantities: qty, device_id: deviceId, client_txn_id: txn.current } });
      setView(v); setPhase("done");
      try { navigator.vibrate?.(120); } catch { /* not supported */ }
      if (sound) beep(true);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 0 || status >= 500) setErr({ msg: `${(e as Error).message} Admission not confirmed — tap Retry and wait for the green screen before letting anyone in.`, retry: true });
      else { setErr({ msg: (e as Error).message, retry: false }); txn.current = idemKey(); setPhase("select"); await refresh().catch(() => undefined); }
      try { navigator.vibrate?.([200, 80, 200]); } catch { /* not supported */ }
    }
    setBusy(false);
  };

  if (view.status !== "VALID") {
    const t = BAD[view.status];
    return (
      <Shell bg={t.bg} text={t.text} icon={view.status === "NOT_YET_VALID" ? "alert" : "x"} head={t.head} sub={`Do not admit — ${view.reason}`} onNext={onNext} gate={staff.gate}>
        {view.booking && <Summary view={view} />}
      </Shell>
    );
  }

  if (phase === "done" && view.admission) {
    const a = view.admission;
    return (
      <Shell bg="bg-emerald-700" text="text-white" icon="check" head={`ADMIT ${a.quantity}`} sub={view.fullyRedeemed ? "FULLY REDEEMED — everyone on this booking is in" : `${view.totals!.remaining} still to come on this booking`} onNext={onNext} gate={staff.gate}>
        <div className="mt-4 rounded-3xl bg-white text-navy-950 p-4 text-base space-y-1">
          <div className="text-xs font-semibold text-slate-500">Admitted now · {a.ref}</div>
          {a.lines.map((l) => <div key={l.catId} className="flex justify-between gap-3 font-bold"><span>{l.label}</span><span className="tabular-nums">× {l.quantity}</span></div>)}
        </div>
        <Summary view={view} />
      </Shell>
    );
  }

  const b = view.booking!;
  return (
    <div className="staff-h flex flex-col bg-slate-50">
      <header className="bg-mgm-green text-white px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 border-b-4 border-mgm-yellow">
        <div className="text-xs text-white/70">Group booking · {staff.gate || "No gate assigned"}</div>
        <div className="mt-0.5 flex items-baseline justify-between gap-3"><span className="font-mono text-2xl font-bold">{b.ref}</span><span className="text-sm font-semibold text-emerald-300">Valid today</span></div>
        <div className="text-sm text-white/80 truncate">{b.name} · {fmtDate(b.visitDate)}</div>
      </header>
      {view.fullyRedeemed ? (
        <div className="flex-1 px-4 pt-5">
          <div className="rounded-3xl bg-amber-400 text-navy-950 p-5 text-center" role="alert"><div className="font-display text-3xl font-extrabold">FULLY REDEEMED</div><p className="mt-1 font-semibold">All {view.totals!.purchased} admissions on this booking have been used. Do not admit.</p></div>
          <Summary view={view} />
          <History view={view} staff={staff} onChanged={refresh} />
        </div>
      ) : (
        <div className="flex-1 px-4 pt-4">
          <p className="text-sm font-semibold text-slate-600">How many are entering now?</p>
          <div className="mt-2 space-y-2">
            {view.categories.map((c) => (
              <div key={c.catId} className="rounded-2xl bg-white p-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-navy-950 truncate">{c.label}</div>
                  <div className="text-xs text-slate-500">Bought {c.purchased} · In {c.admitted} · <b className={c.remaining ? "text-navy-950" : ""}>Left {c.remaining}</b></div>
                </div>
                <Stepper value={qty[c.catId] || 0} max={c.remaining} label={c.label} disabled={phase === "confirm"} onChange={(n) => setQty({ ...qty, [c.catId]: n })} />
              </div>
            ))}
          </div>
          {err && <div className={`mt-3 rounded-2xl p-3 text-sm font-semibold ${err.retry ? "bg-navy-900 text-white" : "bg-red-100 text-red-800"}`} role="alert">{err.msg}</div>}
          <History view={view} staff={staff} onChanged={refresh} />
        </div>
      )}
      <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-2 bg-slate-50 sticky bottom-0">
        {!view.fullyRedeemed && phase === "select" && <button disabled={!total} onClick={() => { setErr(null); setPhase("confirm"); }} className="w-full h-16 rounded-2xl bg-mgm-yellow text-navy-950 font-display text-xl font-bold disabled:opacity-40">Admit {total} {total === 1 ? "person" : "people"}…</button>}
        {!view.fullyRedeemed && phase === "confirm" && (
          <div className="rounded-2xl bg-navy-950 text-white p-3">
            <div className="text-sm text-white/80">Confirm admission</div>
            <div className="font-bold">{chosen.map((c) => `${qty[c.catId]} × ${c.label}`).join(", ")}</div>
            <div className="mt-3 grid grid-cols-[1fr_2fr] gap-2">
              <button disabled={busy} onClick={() => { setPhase("select"); setErr(null); txn.current = idemKey(); }} className="h-14 rounded-xl bg-white/10 font-semibold">Back</button>
              <button autoFocus disabled={busy} onClick={() => void confirm()} className="h-14 rounded-xl bg-emerald-500 text-navy-950 font-display text-lg font-bold flex items-center justify-center gap-2">
                {busy ? <><span className="h-5 w-5 rounded-full border-2 border-navy-950/30 border-t-navy-950 animate-spin" />Admitting…</> : err?.retry ? <><Icon name="refresh" />Retry</> : `Confirm ${total}`}
              </button>
            </div>
          </div>
        )}
        <button disabled={busy} onClick={onNext} className="w-full h-12 rounded-2xl bg-white border border-slate-200 font-semibold text-navy-950">{view.fullyRedeemed ? "Scan next visitor" : "Cancel — back to scanner"}</button>
      </div>
    </div>
  );
}

function Stepper({ value, max, label, disabled, onChange }: { value: number; max: number; label: string; disabled?: boolean; onChange: (n: number) => void }) {
  const b = "h-14 w-14 grid place-items-center rounded-xl text-xl font-bold disabled:opacity-30";
  return (
    <div className="flex items-center gap-2 shrink-0" role="group" aria-label={`${label} entering now`}>
      <button type="button" aria-label={`One less ${label}`} disabled={disabled || value <= 0} onClick={() => onChange(value - 1)} className={b + " bg-slate-100 text-navy-950"}><Icon name="minus" size={22} strokeWidth={3} /></button>
      <span className="w-8 text-center font-display text-3xl font-bold tabular-nums" aria-live="polite">{value}</span>
      <button type="button" aria-label={`One more ${label}`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)} className={b + " bg-navy-950 text-white"}><Icon name="plus" size={22} strokeWidth={3} /></button>
    </div>
  );
}

function Shell({ bg, text, icon, head, sub, gate, onNext, children }: { bg: string; text: string; icon: string; head: string; sub: string; gate: string; onNext: () => void; children?: React.ReactNode }) {
  return (
    <div className={`staff-h ${bg} ${text} flex flex-col`} role="alert">
      <div className="flex-1 px-5 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-white text-navy-950 pop-in"><Icon name={icon} size={46} strokeWidth={3.2} /></div>
        <h1 className="mt-4 text-center font-display text-3xl xs:text-4xl font-extrabold leading-tight">{head}</h1>
        <p className="text-center text-lg font-bold mt-1">{sub}</p>
        {children}
        <p className="mt-3 text-center text-xs opacity-80">{gate}</p>
      </div>
      <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"><button autoFocus onClick={onNext} className="w-full h-16 rounded-2xl bg-navy-950 text-white font-display text-xl font-bold flex items-center justify-center gap-2"><Icon name="scan" />Scan next visitor</button></div>
    </div>
  );
}

/** Per-category bought / admitted / left for the booking. */
function Summary({ view }: { view: GroupView }) {
  const b = view.booking!; const t = view.totals!;
  return (
    <div className="mt-4 rounded-3xl bg-white text-navy-950 p-4 text-sm">
      <div className="flex justify-between gap-3"><span className="font-mono font-bold">{b.ref}</span><span>{fmtDate(b.visitDate)}</span></div>
      <table className="mt-2 w-full tabular-nums">
        <thead><tr className="text-left text-[11px] uppercase text-slate-500"><th className="py-1 font-semibold">Category</th><th className="text-right font-semibold">Bought</th><th className="text-right font-semibold">In</th><th className="text-right font-semibold">Left</th></tr></thead>
        <tbody>
          {view.categories.map((c) => <tr key={c.catId} className="border-t border-slate-100"><td className="py-1.5 pr-2">{c.label}</td><td className="text-right">{c.purchased}</td><td className="text-right">{c.admitted}</td><td className="text-right font-bold">{c.remaining}</td></tr>)}
          <tr className="border-t-2 border-slate-200 font-bold"><td className="py-1.5">Total</td><td className="text-right">{t.purchased}</td><td className="text-right">{t.admitted}</td><td className="text-right">{t.remaining}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/** Earlier admission transactions for this booking; supervisors (admin) can correct one, with a reason. */
function History({ view, staff, onChanged }: { view: GroupView; staff: Me; onChanged: () => Promise<void> }) {
  const [fix, setFix] = useState<string | null>(null);
  if (!view.history.length) return null;
  const supervisor = staff.roles.includes("admin");
  return (
    <div className="mt-4 mb-2">
      <h3 className="text-sm font-bold text-navy-950 mb-1.5">Earlier admissions</h3>
      <div className="space-y-1.5">
        {view.history.map((a) => (
          <div key={a.ref} className={`rounded-xl p-2.5 text-xs ${a.kind === "correction" ? "bg-amber-50" : "bg-white"}`}>
            <div className="flex justify-between gap-2"><span className="font-semibold">{a.kind === "correction" ? `Correction −${a.quantity}` : `Admitted ${a.quantity}`}</span><span className="text-slate-500">{a.at.slice(11, 16)} · {a.gate} · {a.staffId}</span></div>
            <div className="text-slate-600">{a.lines.map((l) => `${l.quantity} × ${l.label}`).join(", ")}{a.reason && ` — ${a.reason}`}</div>
            {supervisor && a.kind === "admit" && (fix === a.ref
              ? <Correction a={a} onDone={async () => { setFix(null); await onChanged(); }} onCancel={() => setFix(null)} />
              : <button onClick={() => setFix(a.ref)} className="mt-1 text-xs font-semibold text-mgm-red underline">Correct this admission (administrator)…</button>)}
          </div>
        ))}
      </div>
      {!supervisor && <p className="mt-2 text-xs text-slate-500 flex items-center gap-1"><Icon name="lock" size={12} />Only an administrator can correct an admission. Ask your supervisor if a count was wrong.</p>}
    </div>
  );
}

function Correction({ a, onDone, onCancel }: { a: Admission; onDone: () => Promise<void>; onCancel: () => void }) {
  const [q, setQ] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const n = Object.values(q).reduce((s, x) => s + x, 0);
  const save = async () => {
    setBusy(true); setMsg("");
    try { await api(`/api/gate/admissions/${a.ref}/correct`, { method: "POST", body: { quantities: q, reason } }); await onDone(); }
    catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="mt-2 rounded-xl border border-amber-300 bg-white p-2.5 space-y-2">
      <div className="font-semibold text-navy-950">Return people to "not admitted" (administrator only, visit day only)</div>
      {a.lines.map((l) => <div key={l.catId} className="flex items-center justify-between gap-2"><span>{l.label}</span><Stepper value={q[l.catId] || 0} max={l.quantity} label={l.label} onChange={(v) => setQ({ ...q, [l.catId]: v })} /></div>)}
      <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls + " !h-11"} placeholder="Reason (required)" aria-label="Correction reason" maxLength={255} />
      {msg && <div className="text-red-700 font-semibold" role="alert">{msg}</div>}
      <div className="flex gap-2"><button onClick={onCancel} className="flex-1 h-11 rounded-lg bg-slate-100 font-semibold">Cancel</button><button disabled={busy || !n || reason.trim().length < 5} onClick={() => void save()} className="flex-1 h-11 rounded-lg bg-navy-950 text-white font-semibold disabled:opacity-40">Correct {n || ""}</button></div>
    </div>
  );
}
