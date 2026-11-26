// Anonymous visitor sessions (all visitors) and influencer referral capture (backend/app/api.py /api/visits).
// The session token is sent with each booking; the server records attribution itself when payment is captured.
import { API } from "./api";
const SESSION_KEY = "mgm-visitor-session";
const LEGACY_KEY = "mgm-ref-session"; // referral-only sessions saved before visitor sessions existed
const RETIRED_OUTBOX = "mgm-booking-events"; // browser-reported booking events: retired, the server records bookings itself
const TRACKING = ["ref", "campaign", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "msclkid", "dclid", "gbraid", "wbraid", "fbclid"];

type VisitorSession = { token: string; expiresAt: string };

// First-party localStorage only (no cookies, no third parties). Where it is blocked (some private modes, strict
// settings) the session lives in memory for this page, so a landing with ?ref= and a booking made without reloading
// are still linked; it is simply not remembered after the tab closes.
const memory = new Map<string, string>();
const read = <T,>(k: string, fallback: T): T => {
  let s: string | null | undefined;
  try { s = localStorage.getItem(k); } catch { s = memory.get(k); } // memory only when storage is blocked, never after a clear
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
};
const write = (k: string, v: unknown) => { const s = JSON.stringify(v); memory.set(k, s); try { localStorage.setItem(k, s); } catch { /* storage unavailable */ } };

/** Opaque token of this browser's live visitor session, if any. No fingerprinting: only this random token. */
export function visitorToken(): string | null {
  const s = read<VisitorSession | null>(SESSION_KEY, null) || read<VisitorSession | null>(LEGACY_KEY, null);
  return s && new Date(s.expiresAt) > new Date() ? s.token : null;
}

/** On page load: establishes the visitor session (first visit), or records an influencer click (?ref=). Every
 *  landing with ?ref= is sent, even with an existing session: the server makes it the active referral for bookings
 *  created after it. A direct visit (no ?ref=) sends nothing and so never clears an active referral; it lapses at
 *  the end of its attribution window. */
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

/** Old builds queued browser-reported payment events here; the server no longer accepts them. */
export function dropRetiredOutbox() { try { localStorage.removeItem(RETIRED_OUTBOX); } catch { /* ignore */ } }
