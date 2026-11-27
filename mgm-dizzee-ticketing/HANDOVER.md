# MGM Dizzee World Ticketing — System Handover

*Centralized booking engine, 25 Nov 2026. This document supersedes `MGM-Ticketing-Prototype-Handover.md` (browser-only prototype). The influencer and regional module is still detailed in `INFLUENCER-MODULE-HANDOVER.md`.*

| Document | Contents |
|---|---|
| **HANDOVER.md** (this file) | Architecture, deployment, environment, staff setup, workflows, operations, backup, limitations, readiness checklist |
| [docs/DATABASE.md](docs/DATABASE.md) | Every table, its constraints, and the migration history |
| [docs/API.md](docs/API.md) | Every endpoint, who may call it, and what it does |
| [docs/TEST-REPORT.md](docs/TEST-REPORT.md) | What was tested, how, and the actual results |
| [CENTRALIZED-BOOKING-PLAN.md](CENTRALIZED-BOOKING-PLAN.md) | The approved architecture audit this implements |

---

## 1. System architecture

```
Browser (React 19 + Vite, src/)                    Railway: one service (Dockerfile)              Railway PostgreSQL
 Customer site ─┐                                   FastAPI (backend/app)                          ┌──────────────────────┐
 Admin console ─┼── HTTPS JSON /api/* ────────────▶  pricing.py  ── server pricing (TS parity)      │ catalog & settings   │
 Gate scanner  ─┘  (staff: session cookie;           bookings.py ── create / hold / capture / expire│ bookings, items,      │
                    customers: per-booking token)    lifecycle.py ─ cancel / refund / modify ──────▶│ tickets, inventory,   │
                                                     gate.py      ── QR verify + atomic admit       │ payments, refunds,    │
                                                     inventory.py ─ conditional-UPDATE holds        │ scans, audit log,     │
                                                     auth.py      ── Argon2id, sessions, roles       │ staff, sessions,      │
                                                     services.py / analytics.py ─ influencer & region│ influencer & regional │
                                                     serves the built front-end (dist/)             └──────────────────────┘
```

**The server is the only authority.** The browser previews prices while a cart is built, but the server re-prices every booking. Only the server:
- takes payment;
- issues and signs tickets;
- validates scans;
- changes a booking's state.

Nothing transactional is stored in the browser. Browser storage holds only:
- an anonymous visitor token;
- the list of booking links made on that device;
- a scanner device ID;
- read-only legacy data (§10).

**Principles that are enforced, and where.**

| Guarantee | Mechanism |
|---|---|
| No overselling (park-wide or per category) | Every reservation is one conditional `UPDATE … WHERE held + sold + n <= capacity` (`inventory.py`), plus a `CHECK` constraint. A concurrent test runs on PostgreSQL. |
| No browser-originated payment confirmation | One capture path, `bookings.capture_payment`. Simulated payments are behind `SIMULATED_PAYMENTS`, the amount comes from the server's own record, and the old `/api/booking-events/*` paths return 410. |
| No duplicate tickets or commissions | Provider events are unique on `(provider, event_id)` and on `(provider, provider_payment_id)`, and `booking_attributions.booking_ref` is unique. A concurrent capture test covers this. |
| No partial state | The API commits once per request. Any failure rolls back the whole booking, tickets, inventory, offer use and commission. A test injects such a failure. |
| No double admission | The admit is a conditional `UPDATE … WHERE status = 'issued' AND visit_date = today`. 8 concurrent scans of one ticket admit it exactly once. |
| Counter sales never earn commission | `channel = 'counter'`, `CHECK (channel = 'web' OR visitor_session_id IS NULL)`, and the engine skips attribution for them. |
| Auditable transitions | `audit_log` records the actor, action, reference and time for every booking, payment, refund, change, sign-in and admin edit. |

**Booking states.**
- `pending_payment` → `confirmed` (on payment capture) → `cancelled` (approved refund or admin cancel).
- `pending_payment` → `expired` when the hold runs out. The tickets are released and the offer redemptions returned.
- A pending cancellation request leaves the booking valid until an admin decides.

## 2. Repository layout

| Path | What |
|---|---|
| `src/` | Front-end: `customer.tsx`, `admin.tsx`, `counter.tsx`, `staff.tsx`, `influencers.tsx`, `api.ts` (HTTP client), `store.ts` (types, price preview, display rules), `ui.tsx` (server-backed store) |
| `backend/app/` | API routers (`api*.py`), engine modules (above), `models.py`, `config.py`, `cli.py` |
| `backend/alembic/versions/` | Migrations `0001`–`0007` |
| `backend/tests/` | pytest suite (SQLite by default; PostgreSQL via `TEST_DATABASE_URL`) |
| `tests/`, `scripts/pricing-fixture.ts` | Front-end tests and the TS→Python pricing parity fixture |
| `Dockerfile`, `railway.json` | The single deployable service |

The offline single-file demo (`static-build/`) was retired. There is one booking engine, and it is the server.

## 3. Local development

```bash
npm install && npm run build                # front-end into dist/ (the backend serves it)
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # (bin/ on macOS/Linux)
python -m alembic upgrade head              # creates tables + seeds the catalog
python -m app.cli seed-demo                 # optional: demo staff (passwords printed once) + sample bookings
python -m uvicorn app.main:app --port 8000  # http://localhost:8000
```

`npm run dev` (port 5173) works against a backend on another port if `VITE_API_URL` is set and that origin is listed in `CORS_ORIGINS`.

## 4. Deploying on Railway

1. **Services.** Use one service from this repository (Railway detects `railway.json` and builds the `Dockerfile`) plus one **PostgreSQL** service. In the app service, add the variable `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.
2. **Variables.** Set them as in §5. For a shared **staging** environment use `APP_ENV=staging`, a real `APP_SECRET`, and an https `PUBLIC_APP_URL`. The app refuses to start otherwise.
3. **Volume.** Mount a volume at `/data` for the GeoLite2 database, and set `MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` (see the influencer handover §10).
4. **Deploy.** Every deploy runs `alembic upgrade head` and then starts one uvicorn worker. The health check is `/api/health`.
5. **First admin.** In a Railway shell, run:
   ```
   python -m app.cli create-user ADM001 "Name" --roles admin
   ```
   The password is prompted, or read from `MGM_NEW_PASSWORD`. Create the other staff in Admin › Staff Management.
6. **Break-glass token.** Remove `ADMIN_API_TOKEN` once at least two admins can sign in.
7. **Never** run `seed-demo` against real data. It is refused when `APP_ENV=production`.

Scaling: the engine is safe with several workers or replicas, because all coordination happens in PostgreSQL (no in-process locks or caches). The GeoLite refresher runs in each process, which is harmless.

## 5. Environment variable reference

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `APP_ENV` | yes (shared envs) | `development` | `development`, `staging` or `production`. **staging and production refuse to start** without PostgreSQL, a real `APP_SECRET` (≥ 32 chars) and an https `PUBLIC_APP_URL`. **production** additionally refuses `DEMO_TODAY` and `SIMULATED_PAYMENTS=1`. |
| `DATABASE_URL` | yes | `sqlite:///./mgm_dev.db` | PostgreSQL in any shared environment (Railway provides it). SQLite is for local development only. |
| `PUBLIC_APP_URL` | yes | `http://localhost:8000` | Public base URL, used in customer booking links and influencer links. |
| `APP_SECRET` | yes (shared envs) | development value | HMAC key for ticket QR codes and customer booking links. **Rotating it invalidates every issued ticket QR and booking link.** Keep it in Railway variables and in the password manager. |
| `SIMULATED_PAYMENTS` | – | `1` | Enables the demo payment provider. No money moves. Must be `0` in production until a verified gateway is integrated. With `0`, online checkout returns "Online payment is not available yet". |
| `DEMO_TODAY` | – | unset | Pins the park's "today" (`YYYY-MM-DD`) for demos and tests. |
| `ADMIN_API_TOKEN` | – | unset | Break-glass credential acting as admin (header `X-Admin-Token`). A short or placeholder value disables it. |
| `ATTRIBUTION_MODEL`, `ATTRIBUTION_WINDOW_DAYS`, `MAX_BOOKINGS_PER_SESSION`, `VISITOR_SESSION_DAYS`, `COMMISSION_BASIS` | – | `last_click`, 30, 5, 30, `ticket_net_ex_gst` | Influencer attribution (influencer handover §9). |
| `GEOIP_DB_PATH`, `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` | – | `./data/GeoLite2-City.mmdb` | Approximate visitor region. Without them every region shows Unknown. |
| `TRUSTED_PROXY_HOPS` | – | `1` | `1` = behind Railway's edge: the visitor IP comes from `X-Real-IP` only. `0` = no proxy (local development): the socket peer address is used. |
| `CORS_ORIGINS` | – | unset | Only if the front-end is served from another origin. Credentials are allowed for the listed origins. |
| `FRONTEND_DIST` | – | `../dist` | Where the built front-end is (the Dockerfile sets `/app/dist`). |
| `TEST_DATABASE_URL` | tests only | unset | Disposable PostgreSQL for the test suite. **The tests drop every table.** Locally it is read from the git-ignored `backend/.env.test`. |

Business settings live in the database, not in environment variables. Edit them in Admin › Settings (§10):
- the cancellation fee;
- the notice period;
- the sale window;
- capacity;
- GST;
- the hold time.

## 6. Administrator and staff setup

**Roles.** An account can hold several roles. The server checks the role on every request, and the console only shows the modules an account may use.

| Role | Can |
|---|---|
| `admin` | everything, including the catalog, calendar, settings, staff accounts and legacy import |
| `finance` | dashboard, reports, bookings, payments, cancellations and refunds, modifications, customers, entry log, notifications, activity log |
| `counter` | Counter Sale |
| `gate` | Staff Scanner |
| `marketing` | Regional Sales Analytics, Influencer Management |

**Accounts.**
- **Create:** Admin › Staff Management › Add staff (Staff ID, name, gate, roles, initial password of at least 10 characters).
- **Reset a password:** edit the account and set a new password. The person's existing sessions are signed out.
- **Leavers:** switch the account off. They are signed out everywhere immediately.
- **Changing your own password:** `POST /api/auth/password` (there is no UI page yet; see §11).
- Passwords are stored as Argon2id hashes and nobody can read them.
- After 5 wrong passwords an account is locked for 15 minutes.
- Sessions last 12 hours.
- **Recovery** if every admin is locked out: run `python -m app.cli reset-password ADM001` in a Railway shell.

**Initial catalog.** Migration `0003` seeds the prototype's catalog:
- 4 ticket categories;
- 6 add-ons;
- 9 offers;
- the date overrides.

Before launch, review prices, daily limits, capacity, offers and the sale window in the admin console. Offer redemption counters start at 0.

## 7. Customer workflows

**Booking**
1. Pick a date. The calendar shows the park's dates from the server; past and closed dates are disabled.
2. Choose tickets, offers and add-ons. The prices shown are the server's quote.
3. Enter customer details.
4. Payment: the server creates the booking and **holds the tickets for 15 minutes** (Admin › Settings).
   - The simulated provider takes no money.
   - A declined payment keeps the hold, so the customer can retry.
   - An unpaid hold expires and the tickets go back on sale.
5. Confirmation: the server issues one ticket per admission, each with a signed QR code. The page offers **Copy my booking link**, a private link that opens the booking on any device.

**My Bookings**
- Lists bookings made on this device, read live from the server, and accepts a pasted booking link.
- There is **no phone-number lookup**, because it would expose anyone's bookings. An OTP-verified lookup is listed in §10.

**Cancellation and refund**
1. On the booking page the customer can request cancellation if all of these hold:
   - the booking is paid;
   - it uses no offer;
   - no ticket has been used;
   - at least 48 hours remain before the visit.
2. The fee is 25% (provisional; see §10). The tickets **stay valid until an admin decides**.
3. **Approve** (Admin › Payment Management › Pending refund requests):
   - the booking is cancelled;
   - unused tickets are voided and their stock released;
   - the refund is recorded and processed;
   - any influencer commission is reversed.
4. **Reject** requires a reason, which the customer sees. The booking stays valid.

**Modification** (admin, Booking Management › booking › Modify booking)
- Only regular bookings: no offer or coupon, no ticket used.
- The server re-prices the booking and moves inventory between dates.
- **Existing ticket codes are kept** per category; added tickets get new codes.
- If the date changes, the QR text changes, because it includes the date. The old QR is rejected as "outdated", and the customer opens the booking link for the new one.
- The price difference appears under Payment Management › Pending settlements: **collect** (cash, UPI or card) or **mark refunded**.

## 8. Counter sales and the gate scanner

**Counter sale** (role `counter`; Admin › Counter Sale)
1. Choose the date, tickets or offers, and add-ons.
2. Enter the customer's name and mobile number.
3. Choose Cash, UPI or Card, then **Complete sale**.

How it works:
- The server prices the sale, takes it from **the same inventory as the website**, and records the counter payment in one step.
- A double-click or a retry never sells twice, because each sale carries an idempotency key.
- The receipt shows the QR tickets. Print it.
- Counter sales appear in all sales reporting as the **Counter (walk-in)** channel and never earn influencer commission.
- Payment is recorded, not processed. No card or UPI terminal is integrated.

**Gate scanner** (role `gate`; `/#staff`)
1. Staff sign in with their own account. The gate shown is the one on their account.
2. **Scan QR** uses the camera where the browser supports it. Otherwise, type the ticket ID (`TKT-…`) or paste the QR text.

The server decides each result:

| Result | Meaning |
|---|---|
| VALID | Admitted now. The ticket is marked used, with gate, staff member and time. |
| ALREADY USED | Shows the previous scan's time and gate. |
| INVALID | A reason is shown: forged or altered QR, ticket not found, payment not completed, ticket cancelled, wrong date, expired, or outdated QR after a booking change. |

- Every attempt is logged (Admin › QR / Entry Management and Activity Log).
- A retried request from the same device is recognised and not counted twice.
- **The scanner needs network access**; there is no offline mode.

## 9. Backup and recovery

- **Railway PostgreSQL backups.** Enable them on the Postgres service (Railway › Postgres › Backups) and confirm a daily schedule and the retention period on MGM's plan. This is a decision for MGM's Railway account; it is not configured from this repository.
- **Logical backup.** Run it before every release, and keep at least one copy off Railway:
  ```bash
  pg_dump --format=custom --no-owner "$DATABASE_URL" > mgm-$(date +%F).dump
  ```
- **Restore into a new, empty database:**
  ```bash
  pg_restore --no-owner --dbname "$NEW_DATABASE_URL" mgm-YYYY-MM-DD.dump
  ```
  Point the service's `DATABASE_URL` at it and redeploy. `alembic upgrade head` is a no-op on a restored, up-to-date database.
- **Restore drill.** Restore the latest dump into a scratch database at least once before launch and run `python -m alembic current`. It must print `0007 (head)`.
- **Secrets.** Back up `APP_SECRET` in the password manager. Without it, existing QR codes and booking links cannot be verified, and the bookings themselves are safe in the database.
- **Migrations.** All migrations are additive, and each one has a tested `downgrade`. To roll back code, redeploy the previous image. Downgrade the schema only if the old code cannot run against the new one: going from 0007 down to 0003 removes the new booking tables and the `booking_id`/`channel` columns of `booking_attributions`, and with them all booking-engine data. Take a backup first. Migrations run online (`alembic upgrade head`); the offline `--sql` preview cannot render the JSON catalog seed in `0003`.
- **Audit trail.** `audit_log` is append-only by application design. To make it tamper-evident against database administrators, restrict `DELETE` and `UPDATE` on it with a separate PostgreSQL role (a recommended hardening step).

## 10. Known limitations and outstanding MGM decisions

**MGM business decisions, all configurable and needed before production:**

| Decision | Current setting | Where to change |
|---|---|---|
| Cancellation fee | **25% (provisional, from MGM's published FAQ; the prototype used 10%). MGM must confirm.** | Admin › Settings |
| Cancellation notice period | 2 days (48 h) | Admin › Settings |
| Real daily capacity and per-category limits | 4,000 park-wide; 3,000 General and 400 Fast Track per category (illustrative) | Settings, Ticket Management, Calendar |
| Whether a cancelled booking returns its offer redemption | It does not (same as the prototype) | Code: `lifecycle._cancel` |
| Same-day re-entry | Shown to customers; the gate still admits each ticket once | Needs a rule from MGM |
| GST treatment of add-ons | 18% on the whole order, as in the prototype | Settings (single rate) |
| Sale window and peak pricing | 1 Nov to 31 Dec 2026; +10% weekend, +15% from 20 Dec, per-date overrides | Settings, Calendar; the peak rule is in `pricing.py` |
| SMS provider for customer OTP lookup | Not chosen; per-booking links are used instead | Decision needed |

**Known limitations:**
- **No real payment gateway.**
  - Online payment is a simulated provider and must be off in production (`SIMULATED_PAYMENTS=0`), so production cannot take online payments until the separate Razorpay milestone is done. The capture path is ready for it: unique provider events, server-side amounts, and one confirmation function.
  - Counter payments are recorded only.
  - Refunds are recorded as processed; no money moves.
- **Customers cannot look bookings up by phone number.** They use the private booking link (and My Bookings on the same device). Nothing emails or sends SMS yet; the customer must keep the link.
- **Booking links** are derived from `APP_SECRET`. They cannot be revoked one by one; rotating the secret revokes all of them, and every QR code.
- **There is no in-app password change page.** The API exists (`POST /api/auth/password`); admins reset passwords from Staff Management.
- **Rate limiting** is per account (lockout), not per IP. Add a Railway or edge rate limit on `/api/auth/login` and `/api/bookings`.
- **The admin console loads bookings with visit dates from 90 days back to 366 days ahead.** Older bookings stay in the database and in the API (`GET /api/admin/bookings?from=`).
  - The dashboard and reports are computed in the browser from that window.
  - Regional and influencer analytics are computed in the database.
- **Gate offline mode** is not implemented. The scanner needs connectivity.
- **Legacy browser data.** Bookings made with the earlier browser-only version exist only in the browser that made them.
  - An admin can export or import them from that browser (Admin › Settings).
  - Import keeps references and ticket codes, never overwrites, and is idempotent.
  - Bookings in browsers nobody opens cannot be recovered.
  - Customers see them as "saved on this device only, not confirmed".
- **The demo seed** creates illustrative bookings. Keep it out of any database that holds real customers.

## 11. Production readiness checklist

- [ ] MGM confirms the business decisions in §10 (fee, capacity and limits, offer and re-entry rules, GST).
- [ ] The Razorpay milestone is complete and verified:
  - server-side order creation;
  - signature-verified webhook through `capture_payment`;
  - refunds and reconciliation.
  Until then: `SIMULATED_PAYMENTS=0`, and do not take real money.
- [ ] Railway: PostgreSQL service, `APP_ENV=production`, a real `APP_SECRET` (stored in the password manager), an https `PUBLIC_APP_URL` on MGM's domain, the `/data` volume with MaxMind credentials, and `TRUSTED_PROXY_HOPS` verified (influencer handover §11).
- [ ] The app starts (the start-up check passes) and `/api/health` returns ok.
- [ ] The first admin is created with the CLI; staff accounts are created; `ADMIN_API_TOKEN` is removed.
- [ ] The catalog has been reviewed (prices, limits, offers, calendar, sale window). No demo seed was run.
- [ ] Backups are enabled, and a restore drill has been done (§9).
- [ ] An edge rate limit is in place on sign-in and booking creation.
- [ ] Privacy notice covers visitor analytics and booking data, with retention periods decided (influencer handover §0 and §12).
- [ ] Full test suite run against a disposable PostgreSQL database (`docs/TEST-REPORT.md`): all passing.
- [ ] Gate devices tested on site: camera scanning, network coverage at each gate.
- [ ] Legacy data imported from any browser that holds real bookings (Admin › Settings).

## 12. Test report

See [docs/TEST-REPORT.md](docs/TEST-REPORT.md).
