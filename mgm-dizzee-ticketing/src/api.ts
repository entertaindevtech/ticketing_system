// HTTP client for the ticketing server (backend/). Every transactional operation goes through here; the browser
// never decides prices, payment status, ticket validity or inventory.
export const API = String(import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Opts = { method?: string; body?: unknown; headers?: Record<string, string> };

export async function api<T = unknown>(path: string, { method = "GET", body, headers = {} }: Opts = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, {
      method, credentials: API ? "include" : "same-origin",
      // X-Requested-With proves the request comes from this app (CSRF protection for the staff session cookie).
      headers: { "X-Requested-With": "mgm-app", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Cannot reach the ticketing server. Check your connection and try again.");
  }
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = (data as { detail?: unknown }).detail;
    const msg = typeof d === "string" ? d : Array.isArray(d) ? d.map((x: { msg?: string }) => x.msg).join("; ") : `Request failed (${r.status})`;
    throw new ApiError(r.status, msg);
  }
  return data as T;
}

/** A fresh idempotency key: a retried request with the same key never creates a second booking or sale. */
export const idemKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ---------- customer booking access (per-booking links) ----------
// Only references + access tokens are kept on this device so "My Bookings" can list them; the bookings themselves
// always come from the server.
const MINE = "mgm-my-bookings";
export type Access = { ref: string; token: string };
export function myBookings(): Access[] { try { return JSON.parse(localStorage.getItem(MINE) || "[]"); } catch { return []; } }
export function rememberBooking(a: Access) {
  try { localStorage.setItem(MINE, JSON.stringify([a, ...myBookings().filter((x) => x.ref !== a.ref)].slice(0, 50))); } catch { /* storage unavailable */ }
}
export function parseAccessLink(text: string): Access | null {
  const m = text.trim().match(/(MGM-[A-Z0-9]{4,12})\/([A-Za-z0-9_-]{16,64})/);
  return m ? { ref: m[1], token: m[2] } : null;
}
export const bookingHeaders = (a: Access) => ({ "X-Booking-Token": a.token });

// ---------- legacy browser data (read-only) ----------
// Bookings made with the retired browser-only version live in this key. They are never deleted or written; admins
// export them for import (Admin > Settings) and customers see them as "saved on this device only".
export const LEGACY_KEY = "mgm-dizzee-proto-v3";
export function legacyBookings(): unknown[] {
  try { const d = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"); return Array.isArray(d?.bookings) ? d.bookings.filter((b: { live?: boolean }) => b.live) : []; } catch { return []; }
}

/** Uploads a file as the raw request body (used for offer images). */
export async function uploadFile<T = unknown>(path: string, file: Blob): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, { method: "PUT", credentials: API ? "include" : "same-origin", body: file,
      headers: { "X-Requested-With": "mgm-app", "Content-Type": file.type || "application/octet-stream" } });
  } catch {
    throw new ApiError(0, "Upload failed: cannot reach the ticketing server.");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, typeof (data as { detail?: unknown }).detail === "string" ? (data as { detail: string }).detail : `Upload failed (${r.status})`);
  return data as T;
}
