// Browser-side referral capture (src/referral.ts) with fake browser globals: every ?ref= landing is reported, a direct
// visit never clears a referral, and blocked storage still links a landing to a booking made without reloading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// referral.ts imports "./api" (Vite-style, extensionless) only for the API base URL; give node a same-origin stub.
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "./api" && c.parentURL?.endsWith("/src/referral.ts")) return { url: "data:text/javascript,export const API = ''", shortCircuit: true };
  return next(s, c); }`));

type Sent = { session_token: string | null; ref: string | null };
const sent: Sent[] = [];
let blocked = false;
const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.window = { location: { href: "", hash: "" }, history: { replaceState() {} } };
g.document = { referrer: "" };
g.localStorage = {
  getItem: (k: string) => { if (blocked) throw new Error("SecurityError"); return store.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (blocked) throw new Error("SecurityError"); store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
let n = 0;
g.fetch = async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as Sent;
  sent.push(body);
  return { ok: true, json: async () => ({ session_token: body.session_token ?? `tok${++n}`, expires_at: "2099-01-01T00:00:00" }) };
};
const { captureVisit, visitorToken } = await import("../src/referral.ts");
const land = async (url: string) => { (g.window as { location: { href: string } }).location.href = url; await captureVisit(); };

test("every referral landing is reported with the existing session; direct visits send nothing", async () => {
  sent.length = 0; store.clear(); blocked = false;
  await land("https://book.example/?ref=RAHUL01");
  await land("https://book.example/?ref=RAHUL01");
  await land("https://book.example/?ref=PRIYA01");
  await land("https://book.example/");
  assert.deepEqual(sent.map((s) => [s.ref, s.session_token]), [["RAHUL01", null], ["RAHUL01", "tok1"], ["PRIYA01", "tok1"]]);
  assert.equal(visitorToken(), "tok1");
});

test("cleared storage starts a new visitor session", async () => {
  store.clear(); sent.length = 0;
  await land("https://book.example/?ref=PRIYA01");
  assert.equal(sent[0].session_token, null);
  assert.equal(visitorToken(), sent.length ? "tok2" : null);
});

test("blocked storage keeps the session in memory for this page, so the booking still carries it", async () => {
  blocked = true; sent.length = 0;
  await land("https://book.example/?ref=RAHUL01");
  assert.equal(visitorToken(), "tok2"); // memory copy from the previous landing on this page
  await land("https://book.example/?ref=PRIYA01");
  assert.deepEqual(sent.map((s) => [s.ref, s.session_token]), [["RAHUL01", "tok2"], ["PRIYA01", "tok2"]]);
  blocked = false;
});
