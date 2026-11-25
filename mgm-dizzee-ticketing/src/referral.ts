// Influencer referral capture and booking-lifecycle reporting to the backend (backend/app/api.py).
// Everything here is best-effort: if the API is unreachable, booking continues exactly as before.
import type { Booking } from "./store";

export const API = String(import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const SESSION_KEY = "mgm-ref-session";
const OUTBOX_KEY = "mgm-booking-events";

type RefSession = { token: string; expiresAt: string; code: string };
type Event = { kind: "paid" | "cancelled" | "modified"; body: Record<string, unknown> };

const read = <T,>(k: string, fallback: T): T => { try { const s = localStorage.getItem(k); return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

export function referralToken(): string | null {
  const s = read<RefSession | null>(SESSION_KEY, null);
  return s && new Date(s.expiresAt) > new Date() ? s.token : null;
}

/** Reads ?ref=CODE&campaign=TAG once on page load, records the click and keeps the session token. */
export async function captureReferral() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("ref");
  if (!code) return;
  const campaign = url.searchParams.get("campaign");
  // Drop the parameters so a refresh or shared link doesn't count a second click.
  url.searchParams.delete("ref"); url.searchParams.delete("campaign");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  try {
    const r = await fetch(`${API}/api/referrals/click`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, campaign, session_token: referralToken() }) });
    if (!r.ok) return; // unknown/inactive code: ignore silently
    const d = await r.json();
    write(SESSION_KEY, { token: d.session_token, expiresAt: d.expires_at, code: d.attributed_code } satisfies RefSession);
  } catch { /* offline / API down */ }
}

const amounts = (b: Booking) => ({
  tickets: b.tickets.length, subtotal: b.totals.subtotal, discount: b.totals.discount, addons: b.totals.addons,
  tax: b.totals.tax, total: b.totals.total, visit_date: b.visitDate,
});

/** Call once the payment is confirmed. Bookings without a live referral session are not reported. */
export function reportPaid(b: Booking) {
  const token = referralToken();
  if (!token || b.payment.status !== "paid") return;
  enqueue({ kind: "paid", body: { ...amounts(b), booking_ref: b.id, session_token: token, payment_status: b.payment.status, payment_ref: b.payment.txnId, paid_at: new Date().toISOString() } });
}
export const reportCancelled = (bookingId: string, reason: string) => enqueue({ kind: "cancelled", body: { booking_ref: bookingId, reason } });
export const reportModified = (b: Booking) => enqueue({ kind: "modified", body: { ...amounts(b), booking_ref: b.id } });

function enqueue(e: Event) { write(OUTBOX_KEY, [...read<Event[]>(OUTBOX_KEY, []), e]); void flushOutbox(); }

let flushing = false;
/** Sends queued events in order. Network errors and 5xx keep the event for the next page load; 4xx drops it. */
export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    for (let q = read<Event[]>(OUTBOX_KEY, []); q.length; q = read<Event[]>(OUTBOX_KEY, [])) {
      const r = await fetch(`${API}/api/booking-events/${q[0].kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q[0].body) });
      if (r.status >= 500) break;
      write(OUTBOX_KEY, read<Event[]>(OUTBOX_KEY, []).slice(1));
    }
  } catch { /* offline: retry next load */ } finally { flushing = false; }
}
