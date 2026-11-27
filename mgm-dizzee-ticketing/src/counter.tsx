// Admin › Counter Sale: walk-in ticket sales. Reuses the customer booking steps; the server prices the sale, takes it
// from the same inventory as the website and records the (simulated) counter payment in one transaction.
import React, { useMemo, useState } from "react";
import { AddonsStep, DateStep, TicketsStep, useCtx, useServerQuote } from "./customer";
import { Booking, Cart, TODAY, eligibleOffers, emptyCart, fmtDate, inr, priceCart } from "./store";
import { api, idemKey } from "./api";
import { Badge, Button, Field, Logo, QR, inputCls, useStore } from "./ui";

type Step = "date" | "tickets" | "addons" | "checkout" | "done";
const METHODS = [["cash", "Cash"], ["upi", "UPI"], ["card", "Card"]] as const;
const blankCustomer = () => ({ name: "", phone: "", email: "", visitors: 0, notes: "" });

export default function CounterSale() {
  const { db, call, toast } = useStore(); const ctx = useCtx();
  const [key, setKey] = useState(idemKey);
  const [step, setStep] = useState<Step>("date");
  const [date, setDateRaw] = useState("");
  const [cart, setCart] = useState<Cart>(emptyCart());
  const [customer, setCustomer] = useState(blankCustomer());
  const [method, setMethod] = useState<(typeof METHODS)[number][0]>("cash");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Booking | null>(null);
  const local = useMemo(() => (date ? priceCart(cart, date, ctx, TODAY, db.addons) : null), [cart, date, ctx, db.addons]);
  const priced = useServerQuote(cart, date, local);
  const setDate = (d: string) => {
    setDateRaw(d);
    const ok = new Set(eligibleOffers(ctx.offers, d).map((o) => o.id));
    setCart((c) => ({ ...c, offers: Object.fromEntries(Object.entries(c.offers).filter(([id]) => ok.has(id))) }));
  };
  const reset = () => { setStep("date"); setDateRaw(""); setCart(emptyCart()); setCustomer(blankCustomer()); setMethod("cash"); setDone(null); setKey(idemKey()); };
  const canPay = !!priced && priced.ticketCount > 0 && customer.name.trim().length > 1 && /^[6-9]\d{9}$/.test(customer.phone) && !busy;

  const complete = async () => {
    if (!priced || !canPay) return;
    setBusy(true);
    const label = METHODS.find((m) => m[0] === method)![1];
    // Idempotency-Key: a double click or a retried request never sells twice. Counter sales are never attributed
    // to influencers (the server records them without a visitor session).
    const b = await call(() => api<Booking>("/api/counter/sales", { method: "POST", headers: { "Idempotency-Key": key }, body: {
      visit_date: date, method: label, cart: { ...cart, coupon: cart.coupon && !priced.couponError ? cart.coupon : "" },
      customer: { name: customer.name.trim(), phone: customer.phone } } }));
    setBusy(false);
    if (b) { setDone(b); setStep("done"); toast(`Counter sale completed — booking ${b.id}`); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <p className="text-xs text-slate-500">Cash, UPI and card are recorded for demonstration only — no real payment is taken.</p>
        {step !== "date" && step !== "done" && <Button variant="ghost" onClick={reset}>Cancel sale</Button>}
      </div>
      {step === "date" && <DateStep date={date} onPick={(d) => { setDate(d); setStep("tickets"); }} onNext={() => setStep("tickets")} />}
      {step === "tickets" && date && priced && <TicketsStep date={date} setDate={setDate} cart={cart} setCart={setCart} priced={priced} onBack={() => setStep("date")} onNext={() => setStep("addons")} />}
      {step === "addons" && date && priced && <AddonsStep cart={cart} setCart={setCart} priced={priced} date={date} onBack={() => setStep("tickets")} onNext={() => setStep("checkout")} />}
      {step === "checkout" && date && priced && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-5">
          <div className="card-flat p-5 space-y-3">
            <h3 className="font-display text-lg font-bold text-navy-950">Customer details</h3>
            <Field label="Full name"><input className={inputCls} value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} placeholder="Walk-in guest" /></Field>
            <Field label="Mobile number" hint="10 digits, starting 6–9"><input className={inputCls} inputMode="numeric" maxLength={10} value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value.replace(/\D/g, "") })} /></Field>
            <h3 className="font-display text-lg font-bold text-navy-950 pt-2">Payment method (simulated)</h3>
            <div className="flex gap-2">{METHODS.map(([k, l]) => <Button key={k} variant={method === k ? "dark" : "outline"} onClick={() => setMethod(k)}>{l}</Button>)}</div>
          </div>
          <div className="card-flat p-5">
            <h3 className="font-display text-lg font-bold text-navy-950">Order summary</h3>
            <div className="text-xs text-slate-500">{fmtDate(date)}</div>
            <div className="mt-3 space-y-1 text-sm">{priced.lines.map((l) => <div key={l.kind + l.refId} className="flex justify-between"><span>{l.qty}× {l.label}</span><span className="font-semibold">{inr(l.amount)}</span></div>)}
              <div className="flex justify-between text-slate-500"><span>GST</span><span>{inr(priced.tax)}</span></div></div>
            <div className="flex justify-between mt-3 pt-3 border-t border-slate-200 font-display text-lg font-bold text-navy-950"><span>Total</span><span>{inr(priced.total)}</span></div>
            <div className="flex gap-2 mt-4"><Button variant="ghost" onClick={() => setStep("addons")}>Back</Button><Button className="flex-1" disabled={!canPay} onClick={complete}>{busy ? "Processing…" : `Complete sale · ${inr(priced.total)}`}</Button></div>
          </div>
        </div>
      )}
      {step === "done" && done && (
        <div className="print-receipt max-w-4xl mx-auto card-flat p-6 fade-in">
          <div className="flex items-center justify-between mb-4"><Logo size={44} /><div className="text-right"><div className="text-xs text-slate-500">Booking reference</div><div className="font-mono font-bold text-navy-950">{done.id}</div></div></div>
          <Badge tone="green">Counter sale · simulated payment ({done.payment.method})</Badge>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm my-4">{([["Customer", done.customer.name], ["Visit date", fmtDate(done.visitDate)], ["Tickets", `${done.tickets.length} entries`], ["Amount paid", inr(done.totals.total)]] as const).map(([k, v]) => <div key={k} className="rounded-xl border border-slate-200 p-3"><div className="text-xs text-slate-500">{k}</div><div className="font-bold text-navy-950">{v}</div></div>)}</div>
          {done.entryQr && (
            <div className="mb-4 flex items-center gap-4 rounded-xl border-2 border-mgm-yellow p-3 break-inside-avoid">
              <QR text={done.entryQr} size={130} />
              <div className="min-w-0">
                <div className="text-xs font-bold uppercase tracking-wide text-navy-950">Group QR · whole booking ({done.tickets.length} {done.tickets.length === 1 ? "person" : "people"})</div>
                <p className="mt-1 text-sm text-slate-600">Show this once at the gate to enter together; staff confirm how many are entering. The tickets below admit one person each.</p>
                <div className="mt-1 font-mono text-xs font-bold text-navy-900">{done.id}</div>
              </div>
            </div>
          )}
          <div className="text-xs font-bold uppercase tracking-wide text-navy-950 mb-2">Individual tickets · one QR per person</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{done.tickets.map((t) => <div key={t.id} className="rounded-xl border border-slate-200 p-3 text-center break-inside-avoid"><div className="text-xs font-semibold text-navy-950 mb-2">{t.label}</div><QR text={t.qr || t.id} size={110} /><div className="text-[10px] text-slate-400 mt-1 font-mono">{t.id}</div></div>)}</div>
          <div className="flex gap-2 mt-5 print:hidden"><Button icon="download" onClick={() => window.print()}>Print receipt</Button><Button variant="outline" onClick={reset}>New counter sale</Button></div>
        </div>
      )}
    </div>
  );
}
