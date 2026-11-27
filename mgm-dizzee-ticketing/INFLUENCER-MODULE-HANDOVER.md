# Influencer & Regional Sales Intelligence — Technical Handover

> **Channel rule (26 Nov 2026).** In Regions & channels a booking is in the *Influencer referral* channel exactly when it carries an influencer attribution (and so a commission), the same record Influencer Performance counts; otherwise it uses the visitor's first-touch source. A visitor who arrived directly and later followed an influencer link is therefore counted under Influencer referral, not Direct. Sessions follow the same rule. The stored first-touch `source` is unchanged. A booking from an influencer-link visit that earned no commission (per-session cap) is shown as *Influencer link · no commission*.

> **Update (centralized booking engine).** Bookings are no longer reported by the browser: `/api/booking-events/*` is retired (410). The booking engine records attribution, commissions, reversals and re-pricing in the same transaction as payment, cancellation and modification, so the tampering risk in §12 no longer applies to new bookings. Counter sales are included in regional reporting as the `counter` channel and are never attributed. The influencer screens now use staff sign-in (admin or marketing role) instead of a pasted token. See [HANDOVER.md](HANDOVER.md).

*Updated 25 Nov 2026: regional intelligence now covers all visitors and bookings (§0).*

Branch: `feat/influencer-regional-intelligence` · Date: 25 Nov 2026

This adds influencer management, referral attribution, approximate regional (IP-based) sales intelligence and commission management to the MGM ticketing app.

> **Read §12 first.** The rest of the app is still a browser-only prototype (bookings live in `localStorage`, payment is simulated). The new module is a real backend, but its booking and payment events still come from that prototype front-end. It is ready for review, **not** for production money flows.

---

## 0. Universal visitor sessions and regional intelligence (migration `0002`)

Geographic intelligence now covers **every website visitor and every website booking**, not only influencer traffic. This generalizes the existing referral-session design; it is not a second tracking system. Sections 1–12 below describe the influencer module and still apply. Where they say "referral session", read "visitor session".

**What changed in the session architecture.**
- `referral_sessions` was **renamed** (not rebuilt) to `visitor_sessions`.
- `influencer_id` is now optional.
- Each session now also records its **first-touch acquisition** (`source`, the five `utm_*` fields, and `referrer_host`, which is the host only).
- The influencer claim has its **own window** (`attributed_at` / `attribution_expires_at`).
- `POST /api/visits` replaces `POST /api/referrals/click`. On page load, `captureVisit()` (`src/referral.ts`) calls it only when the browser has no live session or the URL carries `?ref=`. A returning visitor causes no request.
- Admin (`#admin`) and staff (`#staff`) screens never create sessions.
- Simple user-agent bot hints are not tracked.

**Direct vs influencer visitors.**
- **Source** = how the session *first* arrived. It is classified once, at session creation, and never overwritten.
- **Influencer attribution** is a separate first-click claim:
  1. A visitor who arrives directly and later follows an influencer link keeps `source = direct` but gains the attribution, so the booking earns commission.
  2. A visitor who arrives through an influencer link and later returns directly, through search or another influencer's link keeps the **first influencer** for the full window (default 30 days).
  3. An unknown or inactive `?ref` is ignored: the visit is still tracked, and no click or attribution is recorded.
- Commission eligibility depends only on the attribution, never on `source`.

**Classification** (`backend/app/acquisition.py`, the only place these rules live). First match wins:

| Signal | Source |
|---|---|
| Valid influencer `?ref` | influencer |
| Ad click id (`gclid`, `msclkid`, `dclid`, `gbraid`, `wbraid`; names only, values are never sent) | paid |
| `utm_medium` in the paid group (cpc, ppc, display…) | paid |
| `utm_medium` in the social group | social |
| `utm_medium` in the organic group | organic |
| `utm_medium` = referral | referral |
| Any other UTM tag (email, sms, newsletter…) | paid (shown as "Paid / tagged campaign") |
| Search-engine referrer | organic |
| Social-site referrer | social |
| Other external referrer | referral (external) |
| No referrer, or our own host | direct |
| Booking with no visitor session at all | unknown |

The lists of search engines, social sites and medium groups are constants in that file.

**Universal geolocation.**
- The existing MaxMind lookup now runs **once per visitor session, for every visitor**: at session creation, never per page.
- The same trusted-proxy rule (`TRUSTED_PROXY_HOPS`) and validation apply, and raw IPs are still never stored.
- An invalid or untrusted IP header gives an Unknown region; it does not spoof one.
- A missing database or a failed lookup gives Unknown, and the visit and booking still succeed.
- Partial results (country only) are kept. Non-Indian visitors show as "Outside India".

**Booking-level snapshots.**
- `booking_attributions` now holds **one row per paid website booking from any source**:
  - `influencer_id` is null unless a live attribution existed at payment;
  - `session_id` is null if the browser had no session.
- At payment the row **copies** the session's region, `source`, `utm_source`, `utm_medium` and `utm_campaign`. Later session expiry, retention purges or a newer GeoLite database therefore never change historical reports.
- A booking with no session is recorded as `unknown`, with an unknown location. The booking itself always succeeds; it is client-side.
- `booking_ref` stays unique, so retried callbacks and modifications never create a second row or commission.
- **Counter (walk-in) sales are not website traffic and are not recorded here.**

**Acquisition-source and regional analytics** (`GET /api/admin/regional`, shown in Admin › Influencers & Regions › **Regions & channels**):

| Metric | Definition |
|---|---|
| Visitor sessions | Sessions created in the period. **One per browser per 30 days, not individual people:** the same person on two devices counts twice, and a cleared browser counts again. The dashboard labels this "≈ unique visitors" for that reason. |
| Bookings | Website bookings paid in the period, including those later cancelled |
| Paid bookings | Bookings still paid. Tickets and revenue (incl. GST) count only these |
| Unknown-location bookings | Paid bookings with no resolved country (no session, or an unresolved IP) |
| Conversion rate | paid bookings ÷ visitor sessions, for the same period and the same slice (source, country, state or city) |

Two limitations of the conversion rate:
- It is a **period ratio, not a cohort**. A booking whose session started before the period still counts, so short date ranges can over- or under-state it, and it can exceed 100%.
- Bookings without a session add to bookings but not to sessions.

Breakdowns are available by **source, country, state and city**. Indian reporting buckets states and cities, and "Outside India" and "Unknown" are kept as their own rows. The **Influencer performance** tab is unchanged in meaning; it still counts only influencer-attributed bookings and now adds **influencer × city** and **campaign × state** views. An influencer's "sessions" are now sessions that *received* its attribution, dated by attribution time.

**Migration `0002`** is non-destructive and reversible:
- It renames the table and alters columns to nullable.
- It adds the new columns and indexes: `visitor_sessions(created_at)`, `visitor_sessions(source)` and `booking_attributions(source)`.
- It backfills every existing session and booking as `source = influencer`, with `attributed_at = created_at` and `attribution_expires_at = expires_at`.
- A test seeds 0001-era data, upgrades it and checks that the data is preserved.
- Downgrading deletes non-influencer rows, because the old schema cannot hold them.

**New environment variable:** `VISITOR_SESSION_DAYS` (default 30). Nothing else changed in the Railway setup: no new service and no new storage. The GeoLite volume at `/data` matters more now, because it covers all visitors.

**Privacy.**
- Collected per session: a random opaque token, the first-visit time, approximate country/state/city, the first-touch source, UTM tags and the referrer **host**. Full referrer URLs are not kept, because they can contain search terms.
- Never collected: raw IPs, user agents, fingerprints or click-ID values.
- The token lives in `localStorage` (`mgm-visitor-session`). Anyone can clear it.
- The admin UI shows aggregates only. Booking rows link to bookings by reference, as before.
- Before launch:
  - name this analytics use in the privacy notice;
  - set a retention period for `visitor_sessions` and `referral_clicks` (suggested 13 months; booking snapshots keep their own copy);
  - decide whether to honour Global Privacy Control / Do-Not-Track. Skipping `captureVisit()` when `navigator.globalPrivacyControl` is set would make those visitors' bookings show as `unknown`, but commission attribution would then also be lost.

**Testing for this extension (25 Nov):**
- **Backend:** 64 passed on SQLite, comprising the 34 earlier tests plus 30 new ones:
  - 13 classification rules;
  - creating direct, influencer, organic, external-referral and paid sessions, and capturing UTM tags;
  - session persistence with no repeat lookup; session expiry; bot exclusion; a spoofed IP header giving Unknown;
  - a direct return visit keeping the influencer; direct-first then influencer link;
  - no commission for non-influencer bookings;
  - snapshot stability after the session's region changes;
  - a booking without a session recorded as unknown;
  - no duplicate record on modification;
  - aggregate accuracy by source, state, city and country, with cancelled bookings excluded;
  - the influencer report staying influencer-only;
  - the admin guard on the new endpoint;
  - the 0002 migration preserving and backfilling data.
- **Front-end:** `npm test` 10 passed; `tsc` clean; production and single-file builds succeed.
- **Browser (built-in, backend on SQLite after running 0001→0002 at startup):**
  1. A UTM `cpc` visit created a **paid** session and the URL was cleaned.
  2. A real UI booking by that visitor was recorded with source paid, region Unknown (a localhost IP with no GeoLite file) and **0 commissions**.
  3. The same browser then followed `?ref=REGN01`: same session, attribution added, source still paid, still one session.
  4. The Regions & channels tab rendered all KPIs, the channel table, revenue by channel and the regional funnel. A grid overflow found here was fixed.
  5. The Influencer performance tab showed the new breakdown selector. No console errors.
- **PostgreSQL (25 Nov): 64 passed on Neon PostgreSQL 18.7**, including both migration tests (which now use `TEST_DATABASE_URL` when it is a PostgreSQL URL). Migrations `0001→0002` were also run upgrade → downgrade → upgrade. To repeat: put a **disposable** database URL in `backend/.env.test` (git-ignored; loaded by `tests/conftest.py`) and run `pytest`. The tests drop tables and the migration tests wipe the `public` schema. On PostgreSQL the renamed table keeps its original constraint and sequence names (`referral_sessions_pkey`, `referral_sessions_id_seq`); this is cosmetic.

**Honest scope.** These numbers cover bookings that reach the server through the browser event outbox. Bookings are still stored only in each browser (`localStorage`), and booking events are still browser-generated (§12). Anyone can post fabricated "paid" events; that now pollutes **all** sales figures, not only commissions. Until bookings and payment confirmation move server-side, this is **website analytics with known gaps**, not a reconciled sales ledger. It must not be used for financial reporting.

## 1. Architecture and decisions

**What was there.** The repository had no backend. `src/` is a React 19 + Vite + Tailwind v4 app (customer booking, admin console, staff scanner) whose entire database is a JSON object in `localStorage` (`src/ui.tsx`, key `mgm-dizzee-proto-v3`). The payment is simulated in `PaymentStep` (`src/customer.tsx`) and always succeeds. Cancellation is the admin "Cancel & refund" button (`src/admin.tsx`). *(Update 25 Nov: the features that previously existed only in the hand-patched `static-build/index.html` have been migrated into `src/`, and that file is now generated from `src/`. See [MGM-Ticketing-Prototype-Handover.md](MGM-Ticketing-Prototype-Handover.md).)*

**What was added.** A modular-monolith backend (Python, FastAPI, SQLAlchemy 2, Alembic, PostgreSQL) in `backend/`. A single Railway service serves both the API (`/api/*`) and the built React app, so the browser talks to the same origin and production needs no CORS.

**Smallest sensible integration.** Moving the whole booking system to the server was out of scope ("do not rebuild the ticketing system"). Instead, the backend keeps one **booking attribution** row per *referred* booking, keyed by the booking reference (e.g. `MGM-7TXBFB`). The front-end reports three lifecycle events:

| Event | Where it fires | Endpoint |
|---|---|---|
| Payment confirmed | `PaymentStep` success, right after the booking is saved | `POST /api/booking-events/paid` |
| Cancelled / refunded | Admin › Bookings › "Cancel & refund", and Admin › Payments › approve a customer's refund request | `POST /api/booking-events/cancelled` |
| Modified | Admin › Bookings › "Modify booking" | `POST /api/booking-events/modified` |

These are **not** reported:
- declined payments, because no booking is created;
- customer cancellation *requests* and rejected requests, because the booking stays valid;
- counter sales, which are never referral-attributed.

Events go through a small `localStorage` outbox (`src/referral.ts`). It retries after network errors and 5xx responses, so a brief API outage does not lose a sale. If the API is down, booking still works exactly as before.

**Decisions**
- Last-click attribution with a 30-day window: every valid referral landing (same or another influencer) becomes the active referral for bookings created after it. Each booking keeps the referral that was active when it was created (from the logged clicks), so a later visit never re-assigns an existing booking. A direct visit leaves the active referral in place until its window ends. Both are configurable (`ATTRIBUTION_MODEL`, `ATTRIBUTION_WINDOW_DAYS`); `first_click` (keep the first live influencer) is available as an explicit setting.
- The referral session token is kept in `localStorage`, not a cookie, so attribution works even if the API is later moved to another origin.
- Campaigns are a validated tag (`campaign=` parameter, lower-cased, `[a-z0-9_-]`, max 64 characters), not a separate admin-managed table. Any tag an influencer uses is reported automatically, and invalid tags are dropped while the click still counts.
- Referral codes cannot be edited once created, because shared links must keep resolving. To retire a code, deactivate the influencer.
- Deactivating an influencer stops **new** clicks from being tracked. Visitors already attributed within their window still convert. This is deliberate: the click happened while the influencer was active.
- No Redis, queues, or extra services. GeoLite2 refresh is a daemon thread in the app (§5).

## 2. New and changed files

**New:**
```
Dockerfile, .dockerignore, railway.json           Railway build/deploy
backend/app/config.py                             settings from env vars
backend/app/db.py                                 engine/session; postgres:// URL normalisation
backend/app/models.py                             schema (§3)
backend/app/services.py                           attribution + commission engine (§4, §6)
backend/app/analytics.py                          aggregations (§7)
backend/app/geo.py                                client-IP extraction, GeoLite2 reader, region buckets
backend/app/geoip_update.py                       atomic GeoLite2 download/refresh
backend/app/api.py                                HTTP endpoints (§8)
backend/app/main.py                               app factory, health check, static front-end
backend/alembic/ (+ alembic.ini)                  migration 0001
backend/scripts/update_geoip.py                   manual GeoLite2 refresh
backend/tests/                                    31 tests
backend/requirements.txt, backend/.env.example
src/referral.ts                                   ?ref capture, session token, event outbox
src/influencers.tsx                               Admin › Influencers & Regions UI
```
*(The consolidation commit also added `src/counter.tsx`, `tests/store.test.ts` and `scripts/build-static.mjs`, and migrated the static-only features into `store.ts`, `admin.tsx` and `customer.tsx`. See [MGM-Ticketing-Prototype-Handover.md](MGM-Ticketing-Prototype-Handover.md) §1–3.)*

**Changed in the first influencer commit (minimal, additive):**
- `src/main.tsx`: one line that calls `captureReferral()` on load (now `captureVisit()`, §0).
- `src/customer.tsx`: one `reportPaid(b)` call after a successful payment.
- `src/admin.tsx`:
  - the new nav entry under a "Marketing" group;
  - one `reportCancelled()` call in "Cancel & refund";
  - `export` added to the existing `Card`, `Kpi`, `Th`, `Td` and `Empty` components so the new module reuses them.
- `.gitignore`.

**Now version-controlled for the first time:** the existing `src/`, `public/`, `index.html`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts` and `README.md`. Before this, only `static-build/index.html` was committed, and the backend change cannot work without its front-end.

**Not committed:**
- `vercel.json`: Vercel hosting is out of scope and superseded by Railway.
- The `static-build` backup files.
- `static-html-prototype/` and `documentation/`.

## 3. Database schema (migration `0001`)

| Table | Purpose | Key constraints |
|---|---|---|
| `influencers` | profile, platform, contact, `commission_rate` (%), `active` | `referral_code` UNIQUE; CHECK rate 0–100 |
| `visitor_sessions` (was `referral_sessions`, see §0) | anonymous session for every visitor; geo snapshot, first-touch source, optional influencer claim | `token` UNIQUE; FK influencer (nullable); `expires_at` |
| `referral_clicks` | every referral visit (including repeats); `kept_existing_attribution` flags clicks that did not change attribution | FK influencer, session; index (influencer_id, created_at) |
| `booking_attributions` | one per referred **paid** booking; amounts plus a frozen copy of the geo snapshot; `status` paid/cancelled | `booking_ref` UNIQUE (idempotency); CHECK status |
| `influencer_commissions` | rate snapshot, basis, amount, status, approval/payout/reversal timestamps | `booking_attribution_id` UNIQUE (one commission per booking); CHECK status |
| `commission_events` | append-only history of every status or amount change | FK commission |

Money is stored as `NUMERIC(12,2)` and timestamps as `TIMESTAMPTZ` (UTC). No existing data is touched, because the existing bookings are in browsers, not in this database.

Run migrations: `cd backend && alembic upgrade head`. The Docker start command runs this automatically on every deploy, and it is safe to repeat.

## 4. Referral attribution lifecycle

1. A visitor opens `https://<domain>/?ref=RAHUL01&campaign=summer2026`. The URL is generated from `PUBLIC_APP_URL` and the code.
2. `captureVisit()` removes the tracking parameters from the address bar, so a refresh or re-share doesn't count again. It then calls `POST /api/visits` with any token it already holds (§0).
3. The server validates the code format and that the influencer exists and is active (404 otherwise; the front-end ignores it). Then:
   - **Live session already held** (first-click model): the server keeps it and records the click for the clicked influencer with `kept_existing_attribution=true`. Influencer A stays attributed.
   - **No session, or it has expired**: the server creates a new session (30-day expiry), does the **one** GeoIP lookup (§5), and records the click.
4. The token is stored in `localStorage`, so it survives navigation, reloads and the whole booking flow.
5. On payment success, `reportPaid` sends the booking reference, token and amounts. The server attributes the booking only if the payment status is `paid` and the session exists and is unexpired at payment time. It then freezes influencer, campaign and geo snapshot onto the booking row.
6. `booking_ref` is unique, so repeats are ignored. A later call with a different token cannot re-attribute the booking.

Since §0, every website booking is sent; only bookings with a live influencer attribution create a commission.

## 5. GeoIP lookup lifecycle

- **When:** only when a visitor session is created, for any visitor (§0). It never runs on page views, and it never blocks booking.
- **IP source:** `X-Real-IP`, which Railway's edge sets to the visitor's address (Railway docs: public networking, request headers). `X-Forwarded-For` is never read: Railway doesn't document its layout, and its entries can be internal hops, edge nodes or client-forged values. With `TRUSTED_PROXY_HOPS=0` (local development, no proxy) the socket peer is used instead. Private, reserved, loopback, CGNAT and malformed addresses are not looked up. **Check after deploy:** open the site in a new incognito window from a known location and confirm the region of the newest `visitor_sessions` row.
- **Raw IPs are never stored and never shown.** Only country code and name, state/region and city are kept.
- **Database:** MaxMind **GeoLite2 City (global)** MMDB, read with `maxminddb`, at `GEOIP_DB_PATH`.
- **Provisioning and refresh:**
  - With `MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` set, the app checks the file at startup and then daily, and downloads a new copy when it is missing or older than 7 days. The GeoLite EULA requires using a release no more than 30 days old.
  - The download is written to `*.tmp`, validated, then swapped in with an atomic `os.replace()`. The reader notices the new modification time and reopens it, so lookups are never interrupted.
  - A failed download keeps the old file.
  - Manual refresh: `python scripts/update_geoip.py --force`.
- **Without the database** (no credentials yet, or a download failure), lookups return nothing and those sessions report as **Unknown**. The admin screen shows a warning banner.
- **Buckets:**
  - no country → `Unknown`;
  - country ≠ IN → `Outside India`;
  - India with no state or city → `Unknown`.

  Coordinates are not stored, and no map is drawn, to avoid false precision.
- **Licensing:** the attribution sentence is in the admin UI footer, the OpenAPI description and the code headers. The MMDB is git-ignored, Docker-ignored, and never served over HTTP, because the static route only serves the built `dist/` folder.

> **Accuracy:** IP geolocation estimates where the visitor's network is, not where they live. City-level results for Indian mobile networks are often the carrier's hub city or simply absent. State-level figures are more reliable than city-level ones. District-level accuracy is not claimed.

## 6. Commission rules

- A commission is created **only** when a payment is reported as `paid` for an attributed booking. Failed or pending payments create nothing.
- **Basis** (`COMMISSION_BASIS`):
  - default `ticket_net_ex_gst` = subtotal − discounts − add-ons, i.e. ticket revenue after offers and coupons, excluding GST and add-ons;
  - alternative `total_ex_gst` also includes add-ons.
- **Amount** = basis × rate ÷ 100, rounded half-up to the paisa.
- The rate is **copied onto the commission** at payment time, so changing an influencer's rate affects only future bookings.
- **Statuses:** `pending → approved → paid`, and any of these → `reversed`.
  - Approve accepts only `pending`.
  - Mark paid accepts only `approved` and requires a payout reference. It **only records** a settlement made outside the system; no money moves.
- **Cancellation or refund** marks the booking `cancelled` and the commission `reversed`. If it had already been paid out, the history note says the money must be recovered from the influencer.
- **Modification:**
  - a `pending` commission is recalculated with its original rate snapshot;
  - an approved or paid commission keeps its amount and gets a "review manually" history entry;
  - a second commission is never created.
- Every change is recorded in `commission_events`, which is visible in the admin commission detail view.

## 7. Analytics definitions

| Metric | Definition (filtered by date range) |
|---|---|
| Clicks | all referral visits recorded (by click date) |
| Unique referral sessions | sessions created (by date) |
| Attributed bookings | referred bookings paid in the period, including ones later cancelled |
| Paid bookings | attributed bookings still `paid` (not cancelled or refunded) |
| Conversion rate | paid bookings ÷ unique sessions |
| Tickets / Revenue | over paid bookings; revenue is the amount paid **including GST** |
| Commission earned | commissions that are not reversed |
| Commission owed | pending + approved |
| Commission paid | status `paid` |

Regional tables (state, city, influencer × state) count **paid** bookings only and always include an `Unknown` row when one applies. Campaign rows count clicks by the click's own tag. Sessions and bookings stay with the campaign of the session's first click.

## 8. API endpoints

The OpenAPI docs are at `/docs` and `/openapi.json`.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | health check (checks the DB; reports `geoip_available`) |
| `POST /api/visits` | – | get or create the visitor session; records an influencer click for a valid `ref` (§0) |
| `GET /api/admin/regional?from&to` | `X-Admin-Token` | all-traffic sessions, bookings and conversion by source, country, state and city (§0) |
| `POST /api/booking-events/paid` · `/cancelled` · `/modified` | optional `X-Booking-Events-Token` | booking lifecycle (§1) |
| `GET/POST /api/admin/influencers`, `PATCH /api/admin/influencers/{id}` | `X-Admin-Token` | influencer management |
| `GET /api/admin/commissions?influencer_id&status&from&to` | `X-Admin-Token` | list or filter commissions |
| `GET /api/admin/commissions/{id}` | `X-Admin-Token` | detail, calculation and history |
| `POST /api/admin/commissions/{id}/approve`, `/mark-paid` | `X-Admin-Token` | settlement workflow |
| `GET /api/admin/analytics?from&to&influencer_id` | `X-Admin-Token` | everything on the dashboard |

**Admin authentication.** The app has no user login anywhere, so admin endpoints require a shared token (`ADMIN_API_TOKEN`). It is compared in constant time. An admin pastes it once into Admin › Influencers & Regions, where it is kept in `sessionStorage` for that tab only and never put in the JS bundle. The admin API fails closed: it returns 503 if the token is unset, shorter than 24 characters, or a known placeholder such as the `.env.example` value. A deployment can therefore never run with a guessable token.

**Integrity checks on booking events** (added in the security review):
- Amounts must be internally consistent: total = subtotal − discount + tax (±₹1), and discount and add-ons cannot exceed the subtotal.
- `booking_ref` must match `^[A-Z0-9][A-Z0-9-]{2,39}$`.
- One visitor session can earn commission on at most `MAX_BOOKINGS_PER_SESSION` bookings (default 5), which limits how far a leaked or replayed token can be abused. Later bookings stay attributed to the influencer (and appear in Influencer Performance), just without commission.
- Rejected events return 422. The front-end outbox drops 4xx responses and retries only network errors and 5xx.

## 9. Environment variables

See `backend/.env.example`.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Railway Postgres reference (`${{Postgres.DATABASE_URL}}`). `postgres://` URLs are converted automatically. |
| `ADMIN_API_TOKEN` | yes | long random secret |
| `PUBLIC_APP_URL` | yes | public origin used to build referral URLs, e.g. `https://book.mgmdizzeeworld.com` |
| `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` | for regions | free GeoLite account |
| `GEOIP_DB_PATH` | – | default `/data/GeoLite2-City.mmdb` in the Docker image (put the volume at `/data`) |
| `TRUSTED_PROXY_HOPS` | – | default `1`: behind Railway's edge, read the visitor IP from `X-Real-IP`. `0`: no proxy (local), use the socket peer |
| `ATTRIBUTION_MODEL` / `ATTRIBUTION_WINDOW_DAYS` | – | `last_click` / `30` |
| `COMMISSION_BASIS` | – | `ticket_net_ex_gst` (default) or `total_ex_gst` |
| `BOOKING_EVENTS_TOKEN` | – | set only once events come from a server (§12) |
| `MAX_BOOKINGS_PER_SESSION` | – | default `5`; commissioned bookings per visitor session; later bookings stay attributed, without commission |
| `VISITOR_SESSION_DAYS` | – | default `30`; lifetime of an anonymous visitor session |
| `CORS_ORIGINS` | – | only if the front-end is served from another origin |
| `VITE_API_URL` | – | front-end build-time; leave empty for same-origin (default) |

## 10. Railway deployment

The repository root is the outer folder, so the service's **Root Directory** must be `mgm-dizzee-ticketing`.

1. Create a Railway project and add a **PostgreSQL** service.
2. Add a service from this GitHub repo and set Root Directory to `mgm-dizzee-ticketing`. Railway picks up `railway.json`, which builds the `Dockerfile` and health-checks `/api/health`.
3. Under Variables, set the values from §9. Set `DATABASE_URL` as a reference to the Postgres service.
4. Add a **Volume** to the app service mounted at `/data`. The GeoLite2 database persists there across deploys.
5. Deploy. The start command runs `alembic upgrade head` and then `uvicorn` on `$PORT`.
6. Smoke test:
   1. `GET /api/health` shows `"status":"ok"`, plus `"geoip_available": true` once MaxMind credentials are set.
   2. In Admin › Influencers & Regions, enter the admin token and add an influencer.
   3. Open its link, book, and confirm the commission appears.
   4. Check the region (§5, `TRUSTED_PROXY_HOPS`).

**Notes**
- Build strategy: a multi-stage Dockerfile runs `npm ci && npm run build`. Python then serves `dist/` with a fallback to the single-page app, while `/api/*` stays the API.
- Runs **one** uvicorn worker. For more, increase `--workers`. The GeoLite refresh thread runs per worker but is safe because the swap is atomic.
- Nothing has been deployed. That needs Railway access and your go-ahead.

## 11. Testing performed

*Latest run (25 Nov, after source consolidation):*
- **backend: 34 passed** (`cd backend && pytest`, SQLite);
- **front-end business rules: 10 passed** (`npm test`);
- `tsc --noEmit` clean;
- `npm run build` and `npm run build:static` succeed.

The extra backend tests cover:
- a weak or placeholder admin token being refused;
- inconsistent or malformed booking events being rejected;
- the per-session attribution cap.

The full browser regression run for the consolidated app is in §11a.

**Original automated suite:** it covers:
- referral code validation and inactive influencers;
- click recording; first-click retention; expiry after 30 days; one GeoIP lookup per session;
- Unknown, partial and Outside-India buckets; spoofed / misleading `X-Forwarded-For` (ignored); private IPs; missing or corrupt MMDB;
- attribution on payment; commission basis with discounts; failed and pending payments;
- duplicate payment callbacks; attempts to re-attribute after booking; rate-change snapshots;
- cancellation reversal with history; modification before and after approval; the approve/pay transition rules;
- analytics aggregation including campaigns, regions and date filters;
- GeoLite refresh skip and failure safety; health check;
- the Alembic migration upgrading, matching the models and downgrading.

**Where they ran.** Tests ran on **SQLite** because no PostgreSQL server was available on the dev machine. The migration was rendered as PostgreSQL DDL with `alembic upgrade head --sql` and checked, but it was **not executed against a real Postgres**. To run the suite on Postgres: `TEST_DATABASE_URL=postgresql://… pytest`. *(Superseded 25 Nov: the full suite now also passes on PostgreSQL; see §0.)*

**Front-end:** `tsc --noEmit` is clean and `npm run build` succeeds.

**Browser end-to-end** (built-in browser; backend serving the built app on SQLite at `localhost:8765`):
1. Admin › Influencers & Regions: entered the token, added an influencer, and confirmed the referral link was generated.
2. Opened `/?ref=PRIYA01&campaign=Diwali2026`. The session token was stored with a 30-day expiry and the parameters were removed from the URL.
3. Completed a real booking through the customer flow (date → 1 General Adult → details → simulated UPI payment). The outbox drained.
4. The server showed a `pending` commission of ₹87.92 = ₹1,099 × 8% (GST excluded), campaign `diwali2026`, region `Unknown` (localhost, no MMDB). The dashboard KPIs, influencer table and region cards rendered these figures.
5. Approved the commission in the Commissions tab.
6. Admin › Bookings › Cancel & refund changed the commission to `reversed`, with history `pending → approved → reversed`. Analytics dropped it from paid bookings and revenue.
7. No console errors.

**Not verified:**
- PostgreSQL execution.
- The Docker image build (the Docker daemon was not running).
- Railway deployment and the real `X-Forwarded-For` layout behind Railway's edge.
- A real GeoLite2 download and lookup. No MaxMind credentials were available, so the lookup was tested with a fake reader.
- Mobile layout of the new screens.

**Local Windows note:** this machine's Application Control policy blocks SQLAlchemy's compiled extension and the `uvicorn.exe` / `alembic.exe` launchers. Set `DISABLE_SQLALCHEMY_CEXT_RUNTIME=1` and use `python -m uvicorn` / `python -m alembic`. Linux/Railway is unaffected.

### 11a. Browser regression run after consolidation (25 Nov)

Setup:
- Built-in browser.
- Backend serving the freshly built `src/` on SQLite at `localhost:8765`.
- Browser storage cleared first.
- The influencer `REG01` (10%) was created through the admin API. Influencer creation through the UI was covered in the earlier run.

Verified in the UI, with server state checked after each step:

1. **Referral capture.** `/?ref=REG01&campaign=xmas` stored the session token and removed the parameters from the URL.
2. **Customer booking.** 30 Nov, 2 General Adult, **Skip Add-ons** went straight to Customer Details.
3. **Payment failure.** "Simulate a declined payment":
   - the booking count stayed at 212 → 212;
   - nothing was queued for the backend;
   - an Activity Log entry was written.
4. **Payment success** (booking `MGM-ZR8XAG`, ₹2,594):
   - commission ₹2,198 × 10% = **₹219.80 pending**, campaign `xmas`;
   - a "New online booking" notification.
5. **Customer history and cancellation.**
   - My Bookings lookup by mobile found the booking; View → Request cancellation → Confirm.
   - Refund pending: fee ₹259, refund ₹2,335.
   - The booking and its tickets stayed valid.
6. **Refund approval** (Admin › Payments › Pending refund requests › Approve):
   - the booking was cancelled, payment refunded, and both tickets cancelled;
   - the commission was **reversed**;
   - analytics showed 0 paid bookings and ₹0 revenue, with 1 attributed booking kept.
7. **Modification** (second referral booking `MGM-TMVAQN`, Admin › Bookings › Modify, 1 → 2 adults):
   - the total went ₹1,427 → ₹2,853, with "collect ₹1,426" shown;
   - the **original ticket ID was kept** and one ticket added;
   - the **same single commission** was re-priced ₹120.90 → ₹241.80 at the frozen 10%, with the change in its history.
8. **Counter sale** for today (Cash, `MGM-AXTG4E`):
   - the booking was created with a notification;
   - **not attributed**, even though the browser still held the referral session.
9. **Gate (Staff Scanner, manual entry):**
   - counter-sale ticket → VALID; same ticket again → **already used**;
   - a ticket from the refunded booking → **INVALID · Ticket cancelled**.
10. **Dashboard capacity row:** admitted 7 + remaining 6 = expected 13; capacity 4,000.
11. **Notifications** listed all 7 events with an unread badge. The **Activity Log** merged admin, customer and counter actions with the gate scans.
12. **Ticket entitlements.** Re-entry and "Photo ID required at entry" were saved in Ticket Management, persisted, and shown on the customer ticket card.
13. **Regenerated `static-build/index.html`**, served on its own with no backend:
    - customer and admin screens rendered with every migrated module;
    - one inline script; the only external resource is Google Fonts, as before;
    - no console errors.

**Test-harness notes:**
- Approve uses a native `confirm()` dialog that the browser tool cannot click, so `window.confirm` was stubbed to accept for that step.
- One console error (HTTP 500) came from the first setup call, before the local migration had run. There were none after that.

**Not covered in this run:**
- rejecting a refund in the UI (it is covered by unit tests);
- the influencer dashboard visuals (unchanged since the earlier run);
- mobile layouts;
- PostgreSQL, Docker, Railway, and real GeoLite data.

## 12. Known limitations and next steps

1. **Booking events come from the browser.** Bookings and the simulated payment live in the customer's browser, so `/api/booking-events/*` is called by the front-end and is unauthenticated. A determined user could post a fake "paid" event for a referral session they hold, creating a pending commission. Admin approval is the control for now. **Before real money:**
   - Move bookings to the server.
   - Have the Razorpay webhook (with its signature verified) call `confirm_payment`, and the booking backend call cancel/modify.
   - Then set `BOOKING_EVENTS_TOKEN` so the browser can no longer call these endpoints.
2. **Admin bookings live in each browser's `localStorage`.** The prototype's admin and customer screens only share data within one browser. Cancellations made from another device still reach the server (the event carries the booking reference), but the influencer dashboard is the only cross-device view.
3. **Cross-device event order is not guaranteed.** If an admin cancels a booking on one device before the customer's own browser has delivered its "paid" event (for example, the customer went offline right after paying), the late "paid" event will still attribute the cancelled booking. This cannot happen once events come from the server (item 1).
4. **A pending customer cancellation request leaves the commission pending.** Admins should not approve that commission until the request is resolved; the UI does not block it.
5. **No partial refunds.** Any cancellation reverses the whole commission. The existing "Cancel & refund" keeps 10%, but the commission is reversed in full. Confirm this policy with MGM.
6. **Paid commission reversal does not claw money back automatically.** It is flagged in the history for finance to recover.
7. **IP location is approximate** (§5). VPN, corporate and mobile carrier IPs skew results.
8. **Privacy.**
   - Stored: an anonymous random session token, click timestamps, campaign tag, and approximate country/state/city.
   - Not stored: IP addresses, user agents, or any new personal data.
   - The booking reference links this to the booking, which itself holds the customer's contact details in the existing system.
   - Purpose: influencer attribution and commission only.
   - Before launch, add a line to the privacy notice ("we estimate your approximate region from your IP address to measure marketing performance") and set a retention period for `referral_clicks` and `visitor_sessions`, for example 13 months.
9. **Required before a real payment gateway (Razorpay).** None of these are done; the current flow is a prototype.
   1. **Persist bookings on the server.** Add a `bookings` table with ticket rows. The browser stops being the system of record, and the booking reference is created server-side.
   2. **Create the order on the server, not in the browser.** The server creates the Razorpay order (amount computed server-side from the cart, never trusted from the client) and stores `order_id ↔ booking_ref ↔ visitor session token`. The token is attached at order creation, so the browser can never choose it at payment time.
   3. **Make the signed webhook the only "paid" trigger.**
      - Verify `X-Razorpay-Signature` (HMAC-SHA256 with the webhook secret) on `payment.captured` / `order.paid`, then call `services.confirm_payment`.
      - Its idempotency by `booking_ref` already absorbs webhook retries. Also store the Razorpay `payment_id` with a unique constraint.
   4. **Drive refunds from the gateway.** Call `services.cancel_booking` on the Razorpay refund API result, or on `refund.processed` webhooks. Handle partial refunds explicitly; the commission policy for them is not yet defined.
   5. **Close the browser endpoints.** Set `BOOKING_EVENTS_TOKEN`, or remove the public `/api/booking-events/*` routes. Then delete `reportPaid` / `reportCancelled` / `reportModified` from the front-end.
   6. **Add real admin and staff authentication** (SSO or per-user accounts with roles) to replace the shared `ADMIN_API_TOKEN` and the demo staff passwords.
   7. **Reconcile daily** against Razorpay settlement reports before approving commissions.
10. **Future work:**
   - a Postgres CI job;
   - CSV export of commissions;
   - bulk approve;
   - a choropleth map of India once data volume justifies it;
   - per-influencer payout statements.

This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com.
