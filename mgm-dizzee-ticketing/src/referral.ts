// Anonymous visitor sessions (all visitors), influencer referral capture and booking-lifecycle reporting
// to the backend (backend/app/api.py). Best-effort: if the API is unreachable, booking works exactly as before.
import type { Booking } from "./store";

export const API = String(import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const SESSION_KEY = "mgm-visitor-session";
const LEGACY_KEY = "mgm-ref-session"; // referral-only sessions saved before visitor sessions existed
const OUTBOX_KEY = "mgm-booking-events";
const TRACKING = ["ref", "campaign", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "msclkid", "dclid", "gbraid", "wbraid", "fbclid"];

type VisitorSession = { token: string; expiresAt: string };
type Event = { kind: "paid" | "cancelled" | "modified"; body: Record<string, unknown> };

const read = <T,>(k: string, fallback: T): T => { try { const s = localStorage.getItem(k); return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

/** Opaque token of this browser's live visitor session, if any. No fingerprinting: only this random token. */
export function visitorToken(): string | null {
  const s = read<VisitorSession | null>(SESSION_KEY, null) || read<VisitorSession | null>(LEGACY_KEY, null);
  return s && new Date(s.expiresAt) > new Date() ? s.token : null;
}

/** On page load: establishes the visitor session (first visit), or records an influencer click (?ref=). */
export async function captureVisit() {
  const url = new URL(window.location.href);
  const p = Object.fromEntries(TRACKING.map((k) => [k, url.searchParams.get(k)]));
  const token = visitorToken();
  if (token && !p.ref) return; // returning visitor: session, region and first-touch source already recorded
  if (/^#(admin|staff)/.test(window.location.hash)) return; // internal admin/gate screens are not website visitors
  if (TRACKING.some((k) => p[k] !== null)) { // clean URL so a refresh or a re-shared link isn't counted again
    TRACKING.forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  try {
    const r = await fetch(`${API}/api/visits`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_token: token, ref: p.ref, campaign: p.campaign, utm_source: p.utm_source, utm_medium: p.utm_medium,
        utm_campaign: p.utm_campaign, utm_content: p.utm_content, utm_term: p.utm_term,
        click_ids: ["gclid", "msclkid", "dclid", "gbraid", "wbraid"].filter((k) => p[k] !== null), // names only, never the ids
        referrer: document.referrer || null,
      }),
    });
    if (!r.ok) return;
    const d = await r.json();
    if (d.session_token) write(SESSION_KEY, { token: d.session_token, expiresAt: d.expires_at } satisfies VisitorSession);
  } catch { /* offline / API down */ }
}

const amounts = (b: Booking) => ({
  tickets: b.tickets.length, subtotal: b.totals.subtotal, discount: b.totals.discount, addons: b.totals.addons,
  tax: b.totals.tax, total: b.totals.total, visit_date: b.visitDate,
});

/** Call once an online payment is confirmed. Every website booking is reported (with or without a session) so
 * regional sales cover all visitors; the server decides whether an influencer commission applies. */
export function reportPaid(b: Booking) {
  const token = visitorToken();
  if (b.payment.status !== "paid") return;
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
