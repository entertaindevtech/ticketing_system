# Test report — centralized booking engine

*Run on 25 Nov 2026, branch `feat/centralized-booking-engine`. Every result below is from an actual run.*

## Results

| Suite | Environment | Result |
|---|---|---|
| Backend (pytest), full | **PostgreSQL 18.7 (Neon, disposable test database)** at commit `e842ffe` | **552 passed, 0 skipped, 0 failed** (17 min; includes the 6 concurrency tests) |
| Backend (pytest), full | SQLite at `b8ee7e0` (final code) | **547 passed, 6 skipped** (the PostgreSQL-only concurrency tests), 0 failed |
| Front-end unit tests (`npm test`) | Node 24 | **5 passed** (price preview, eligibility hints, parity fixture up to date) |
| Type check (`tsc --noEmit`) | – | clean |
| Production build (`npm run build`) | Vite 7 | OK |
| End-to-end in a browser | Built-in browser; backend on SQLite after `alembic upgrade head` (0001→0007) + `seed-demo` | all flows below passed |

One test was added after the PostgreSQL run: `test_production_refuses_unsafe_settings`. It checks configuration only and touches no database. It passes on SQLite.

The single warning comes from a third-party library: Starlette's TestClient deprecation of `httpx`.

## What the backend suite covers

Counts are tests (parametrized cases expanded).

| Area | File | Key assertions |
|---|---|---|
| Pricing parity | `test_pricing_parity.py` (402) | The Python engine reproduces **400 carts priced by the TypeScript engine**: lines, savings, coupon discount, GST and totals, with offers, coupons, exhausted/scheduled offers, date overrides and half-rupee rounding. `npm test` fails if the fixture is stale |
| Catalog and quote | `test_catalog_api.py` (5) | Public catalog hides coupons and drafts; server quote; closed/past dates; quantity validation; offer counters stay server-owned |
| Booking engine | `test_bookings.py` (14) | Server pricing (client totals ignored); holds; capture issues signed tickets and the attribution; access tokens; **browser cannot confirm payment** (simulation off, retired events → nothing changes); **duplicate payment events → one set of tickets, one commission**; **injected failure mid-capture leaves no tickets, inventory or event**; declined payment; category and park limits; hold expiry and late payment; offer limit; idempotency keys; influencer commission on server amounts |
| Concurrency (PostgreSQL only) | `test_concurrency.py` (6) | 30 parallel bookings for 10 seats → exactly 10; 10 concurrent captures → 1 issue; last offer redemption → 1 winner; same idempotency key ×5 → 1 booking; 8 concurrent captures with mixed event IDs → 1 commission; **8 concurrent scans of one ticket → exactly 1 admitted** |
| Lifecycle | `test_lifecycle.py` (7) | Request → approve: cancelled, tickets void, stock released, refund processed, commission reversed, **every step in the audit log**; reject needs a reason; eligibility rules (48 h, offers, unpaid, used tickets); admin cancel; **modification keeps existing ticket codes**, moves inventory, records the difference and re-prices the commission; dry run changes nothing |
| Counter and gate | `test_counter_gate.py` (7) | **Counter sales share inventory and are never attributed**, even with influencer sessions present; idempotent sales; admit-once and duplicate with the previous gate; forged, tampered, outdated (after a date change), cancelled, wrong-day and expired scans rejected; scanner retry is not double-counted |
| Authentication | `test_auth.py` (11 + **one per staff route**) | Argon2id hashes; HttpOnly cookie; lockout; roles; CSRF header; logout and deactivation end sessions; user management; weak break-glass token disabled; **every `/api/admin`, `/api/counter` and `/api/gate` route returns 401 without credentials**; customer records unreachable without a token; unsafe production/staging settings refuse to start |
| Admin console and analytics | `test_admin_console.py` (6) | State endpoint is staff-only, with no secrets; capacity edits synced and refused below sold; settings and offers via API; **regional revenue equals the booking ledger**, counter as its own channel; influencer report stays influencer-only; legacy import is idempotent, never overwrites, and keeps tickets scannable; demo seed |
| Influencer regression | `test_influencer_module.py` (30), `test_visitor_sessions.py` (17) | All earlier influencer and regional behaviour (first-click, 30-day window, frozen rates, reversals, idempotency, geo, analytics), **now exercised through the real booking engine** instead of browser-reported events |
| Migrations | `test_migrations.py` (2) | Upgrade to head matches the models and downgrades cleanly; 0002 preserves and backfills influencer data. Run on SQLite and PostgreSQL |
| GeoLite updater | `test_geoip_update.py` (3) | Unchanged |

## End-to-end browser verification

Real UI, real server, fresh database:

1. Customer booking for today, 2 adults. The calendar disabled past dates using the server's date. The server created `MGM-QSYKZP`, held the tickets and showed the hold time.
2. "Simulate a declined payment" showed declined with the hold kept. A retry paid, and the server issued 2 tickets with signed QR codes.
3. Browser storage afterwards contained only the visitor token and the booking-link list. `GET /api/bookings/{ref}` without the token returned 404.
4. Gate scanner: the old `mgm123` password was rejected. The generated gate account signed in. Ticket admitted (VALID), then the same ticket returned ALREADY USED with the previous gate and time.
5. Admin console:
   - A gate-only account saw "no admin console access". A bug found here, where the empty dashboard still rendered, was fixed.
   - The admin account saw the server dashboard.
   - A counter sale (Family Package, ₹4,129, cash) was confirmed with 4 tickets.
   - `/api/admin/regional` revenue equalled the ledger's paid revenue (₹1,46,326), with counter sales as their own channel.
   - The audit log named the acting staff account.
   - The Influencers & Regions screens loaded on the staff session (no token prompt).
6. The private booking link opened the booking on a device with no saved bookings and showed the live gate state. Phone width (375 px) had no horizontal overflow.
7. Console errors were only the expected 401 from `/api/auth/me` while signed out, and the deliberate 404 from step 3.

## Not tested

- A real payment gateway (out of scope: separate Razorpay milestone).
- Camera QR scanning on physical gate devices. The scanner was exercised by typed codes in a desktop browser.
- Load and performance against Railway; multiple uvicorn replicas.
- A deployment to Railway (nothing was deployed).
- The full UI walk-through of every admin editor. They call the tested APIs; spot-checked: dashboard, counter sale, influencers, staff gating.
- Browsers other than the built-in Chromium-based pane.

## How to reproduce

```bash
cd backend && python -m pytest                       # SQLite
# PostgreSQL (disposable database only: the tests drop every table):
#   put TEST_DATABASE_URL=postgresql://… in backend/.env.test (git-ignored), then: python -m pytest
cd .. && npm test && npx tsc --noEmit && npm run build
```
