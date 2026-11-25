# Centralized Booking & Transaction Engine — Phase 1: Audit and Migration Plan

*Draft for review, 25 Nov 2026. Planning only: no code, schema, migration or environment file has been changed. Based on branch `feat/influencer-regional-intelligence` at `22756ff`.*

---

## 1. Current architecture assessment

**One application, two halves that barely touch.**

| Layer | What it is | Authority today |
|---|---|---|
| `src/` (React 19 + Vite) | Customer site, Admin console, Counter Sale, Staff Scanner, all in one bundle and switched by `#admin` / `#staff` | **Everything transactional**: pricing, booking creation, payment status, ticket IDs, QR signing, scans, refunds, modifications, catalog, staff and settings |
| `src/store.ts` | A pure-function business engine (`priceCart`, `buildBooking`, `evaluateScan`, `cancellationEligibility`, `approveRefund`, `modifyBooking` and others) | It runs entirely in the browser |
| `src/ui.tsx` `StoreProvider` | The whole database is one JSON blob in `localStorage["mgm-dizzee-proto-v3"]`, rewritten on every change | Each browser is its own database |
| `backend/` (FastAPI, SQLAlchemy 2, Alembic, PostgreSQL) | 7 tables: `influencers`, `visitor_sessions`, `referral_clicks`, `booking_attributions`, `influencer_commissions`, `commission_events`, `alembic_version` | Visitor sessions, geolocation, influencer attribution and commissions. Bookings are only **mirrored** from browser-sent events |
| Deployment | `Dockerfile` runs `alembic upgrade head` and then uvicorn; `railway.json`; the backend serves `dist/` | One Railway service plus Railway PostgreSQL. This stays the target |

**Backend conventions to keep:**
- Module layout: `api.py` (routers and Pydantic models), `services.py` (transactional logic), `models.py`, `analytics.py`, `config.py` (env-driven `Settings`), `db.py` (`normalize_url`, `get_db`).
- `require_admin` dependency on the `/api/admin` router.
- `IntegrityError` used as the idempotency guard: the `booking_ref` UNIQUE constraint, and `confirm_payment` recovering from a concurrent duplicate.
- Money as `Numeric(12,2)` (`MONEY`); `Timestamps` and `GeoSnapshot` mixins; `CheckConstraint` on status columns; audit rows (`commission_events`).
- Tests on SQLite by default and on PostgreSQL through `TEST_DATABASE_URL` (verified 64/64 on Neon).

**Consequences of today's split:**
- Two admins on two computers see different bookings.
- A customer's "My Bookings" shows only what that one browser created.
- A gate scanner can admit only tickets created in the scanner's own browser.
- Capacity is not enforced anywhere.
- The influencer and regional numbers depend on a browser telling the truth.

---

## 2. Booking lifecycle and data flow today

```
Customer site (customer.tsx)
 1. Date picker ── dateStatus(d, db.dateCfg) in the browser; TODAY is the browser clock, clamped to 2026-11-19 outside the demo window
 2. Tickets / offers / add-ons ── priceCart(cart, date, ctx): prices, GST, offer and coupon rules, all in JS
    (offer "Only N left" = maxRedemptions − redemptions, read from local JSON; capacity and dailyLimit never checked)
 3. Customer details ── name, 10-digit phone, email (validated in the form only)
 4. PaymentStep ── booking ref "MGM-xxxxxx" from Math.random
    setTimeout 1.8 s ⇒ "success" (or "Simulate a declined payment" ⇒ only an Activity Log entry)
 5. buildBooking() ── TKT-xxxxxxxx IDs from Math.random; payment.status = "paid"; txnId = "pay_"+random; gateway "Razorpay"
 6. update(): bookings.unshift(b); offer.redemptions += 1; logEvent()     → localStorage
 7. reportPaid(b) ── outbox (localStorage "mgm-booking-events") → POST /api/booking-events/paid
    → backend confirm_payment(): booking_attributions row (geo/source snapshot) + commission if an influencer applies
 8. Confirmation ── QR = "MGMDW1|ticket|booking|date|" + FNV-1a sig (public algorithm, no secret)

Customer "My Bookings" ── filter local bookings by phone digits (no verification)
  └ "Cancellation & refund" ── requestCancellation(): refund.status = pending, 10% fee (local only; nothing sent to the backend)

Admin (admin.tsx), local data only
  Booking Management ── list/filter local bookings
     ├ Cancel & refund ── adminCancel() + reportCancelled()   → commission reversed
     └ Modify booking ── dry-run on a JSON clone, modifyBooking() + reportModified() → commission re-priced
  Payment Management ── approveRefund() + reportCancelled() / rejectRefund() (local)
  Calendar, Tickets, Offers, Add-ons, Staff, Settings ── direct mutations of the local JSON
  Dashboard / Reports / Notifications / Activity Log ── computed from local JSON
  Counter Sale (counter.tsx) ── buildBooking(); counterSale = true; payment method Cash/UPI/Card (simulated)
                                deliberately NOT reported to the backend
  Influencers & Regions (influencers.tsx) ── the ONLY screen that reads the server (/api/admin/*, X-Admin-Token)

Staff Scanner (staff.tsx)
  Login ── compares id/password against db.staff in localStorage (plaintext "mgm123"); id kept in sessionStorage
  Scan ── evaluateScan(raw, local db): checks signature, ticket found locally, payment, cancelled, used, date == TODAY
          marks ticket used, appends to db.scans (local only)
```

### Every place the frontend acts as the authority

| # | Authority held by the browser | Where |
|---|---|---|
| A1 | Prices, discounts, coupon validity, GST, totals | `store.ts priceCart / validateCoupon / offerUnit / ticketPrice / priceAdj` |
| A2 | Whether a date is open, blackout or past; what "today" is | `dateStatus`, `TODAY` (browser clock, demo clamp) |
| A3 | Capacity and per-category daily limits: **not enforced at all** (shown in Calendar/Dashboard only) | `admin.tsx:180,200,217`; `TicketCat.dailyLimit` is never read when booking |
| A4 | Offer redemption limits (`redemptions += 1`, read-modify-write) | `customer.tsx:670`, `counter.tsx:38` |
| A5 | Booking reference generation | `PaymentStep` `ref` (`Math.random`) |
| A6 | **Payment success**: status set to `"paid"` after a `setTimeout` | `PaymentStep.pay`, `buildBooking` |
| A7 | Ticket ID issuance | `buildBooking`, `modifyBooking` |
| A8 | QR signing (FNV-1a, forgeable by anyone who reads the bundle) | `sig()`, `qrPayload()` |
| A9 | Gate validation and "used" marking | `evaluateScan`, `staff.tsx process()` |
| A10 | Staff authentication (plaintext passwords in the bundle and in localStorage) | `seedStaff`, `staff.tsx` |
| A11 | Cancellation eligibility, 10% fee, request state | `cancellationEligibility`, `requestCancellation` |
| A12 | Refund approve/reject, admin cancel | `approveRefund`, `rejectRefund`, `adminCancel` |
| A13 | Modification eligibility, re-pricing, ticket retention | `modificationEligibility`, `modifyBooking` |
| A14 | Counter sales | `counter.tsx complete()` |
| A15 | Catalog and configuration (tickets, offers, add-ons, calendar, settings, staff) | `admin.tsx` editors |
| A16 | Notifications and Activity Log | `logEvent` |
| A17 | Customer booking history (phone match, no verification) | `MyBookings` |
| A18 | What the backend believes was paid, and for how much | `reportPaid` → `/api/booking-events/paid` (open unless `BOOKING_EVENTS_TOKEN` is set, and that token cannot be kept secret in a browser) |
| A19 | "Reset demo data" wipes everything | `admin.tsx:783` |

---

## 3. Frontend storage dependencies (complete)

| Key | Store | Contents | Fate in the target |
|---|---|---|---|
| `mgm-dizzee-proto-v3` | localStorage | Whole `DB`: `tickets`, `offers`, `addons`, `dateCfg`, `bookings`, `scans`, `staff`, `settings`, `notifications`, `auditLog`, `version: 3` | Replaced by API reads. Kept **read-only** as a legacy source for export/import (§14). No longer written for transactional data |
| `mgm-visitor-session` | localStorage | `{token, expiresAt}` visitor session | **Keep** (anonymous analytics token; sent with booking creation) |
| `mgm-ref-session` | localStorage | Legacy referral token | Keep reading until it expires (≤ 30 days after cut-over), then remove the code |
| `mgm-booking-events` | localStorage | Outbox of paid/cancelled/modified events | Drained, then **removed**; the server records these itself |
| `mgm-staff` | sessionStorage | Logged-in staff ID | Replaced by a server session cookie |
| `mgm-admin-token` | sessionStorage | Shared `ADMIN_API_TOKEN` pasted by admins | Replaced by admin login (§13) |
| (React state) | memory | Cart, customer form and step | Stays client-side (UI state, not authority) |

---

## 4. Proposed PostgreSQL entity design

Conventions:
- Integer surrogate PKs (as today), plus human-facing unique references.
- `MONEY = Numeric(12,2)`; `timestamptz` everywhere; visit dates are `date` in **Asia/Kolkata**.
- `Timestamps` mixin; status columns carry `CheckConstraint`s.
- All new tables are additive. **Existing influencer tables are kept and linked, not replaced.**

### 4.1 Catalog and configuration (moved out of the localStorage `DB`)

| Entity | Responsibility | Key constraints |
|---|---|---|
| `park_settings` (single row) | GST %, open/close time, default daily capacity, sale window (replaces `MIN_DATE`/`MAX_DATE`), cancellation fee %, notice hours, hold minutes | `CHECK (id = 1)`; `gst BETWEEN 0 AND 100` |
| `ticket_categories` | `ga`, `gc`, `fa`, `fc`: name, kind, audience, base price, daily limit, entitlements (validity note, re-entry, restrictions), active | `code` UNIQUE; `base_price >= 0`; `daily_limit >= 0` |
| `addons` | Add-ons with price and active flag | `code` UNIQUE |
| `offers` | Today's `Offer` fields: type, windows, weekdays/dates (arrays or JSON), value, buy X/get Y, package contents (JSON), coupon, priority, status, `max_redemptions`, `redemptions_count` | `code` UNIQUE; `coupon` UNIQUE where not null (case-insensitive index on `upper(coupon)`); `redemptions_count <= max_redemptions` |
| `park_dates` | Per-date configuration: open, blackout, capacity override, price adjustment %, note | PK `visit_date` |
| `price_rules` *(optional, later)* | The holiday/weekend adjustments hard-coded in `priceAdj` (≥ 20 Dec → 15%, weekend → 10%) | Until then, they are ported as code constants |

### 4.2 Inventory

| Entity | Responsibility | Key constraints |
|---|---|---|
| `date_inventory` | One row per visit date: `capacity`, `held`, `sold` (park-wide tickets) | PK `visit_date`; `CHECK (held >= 0 AND sold >= 0 AND held + sold <= capacity)` |
| `category_inventory` | One row per (date, category): `limit`, `held`, `sold` | PK `(visit_date, category_id)`; the same CHECK |

Rows are created lazily, with `INSERT … ON CONFLICT DO NOTHING`, the first time a date or category is booked, taking capacity from `park_dates` or `park_settings` and the limit from `ticket_categories.daily_limit`. When an admin changes a capacity, the row is updated, and the change is refused if it would go below `held + sold`.

### 4.3 Customers and bookings

| Entity | Responsibility | Key constraints |
|---|---|---|
| `customers` | Name, phone (E.164 `+91…`), email, `phone_verified_at` | `phone` UNIQUE. One customer per phone number; name and email on each booking are snapshots |
| `bookings` | The order: `booking_ref` (`MGM-XXXXXX`, server-generated), `customer_id`, `channel` (`web`/`counter`/`admin`), `visit_date`, `status` (§6), customer snapshot (name/phone/email/visitors/notes), totals snapshot (`subtotal`, `discount`, `addons`, `tax`, `total`, `complimentary`), `coupon_code`, `pricing_version`, `hold_expires_at`, `visitor_session_id` (nullable FK), `created_by_user_id` (counter/admin), `origin` (`live`/`legacy_import`/`demo_seed`), `version` (optimistic lock) | `booking_ref` UNIQUE; `channel='counter' ⇒ visitor_session_id IS NULL` (CHECK); `total >= 0` |
| `booking_items` | Priced lines exactly as `priceCart` `Line`: kind (`ticket`/`offer`/`addon`), ref (category/offer/add-on FK), label snapshot, qty, unit, original, amount | FK booking ON DELETE RESTRICT; `qty > 0` |
| `booking_offer_redemptions` | Which offers/coupons a booking consumed (replaces `offerIds`) | UNIQUE `(booking_id, offer_id)` |
| `tickets` | One row per admission: `ticket_code` (`TKT-XXXXXXXX`), `booking_id`, `booking_item_id`, `category_id`, `visit_date` (denormalized for the gate), `status` (`issued`/`used`/`void`), `complimentary`, `offer_id`, `used_at`, `used_gate`, `used_by_user_id`, `qr_version` | `ticket_code` UNIQUE; `status='used' ⇔ used_at IS NOT NULL`; index `(visit_date, status)` |

### 4.4 Money

| Entity | Responsibility | Key constraints |
|---|---|---|
| `payments` | One attempt to collect money for a booking: `provider` (`simulated`, `counter_cash`, `counter_upi`, `counter_card`, later `razorpay`), `provider_order_id`, `provider_payment_id`, amount, currency, method, `status` (`created`/`authorized`/`captured`/`failed`/`refunded`/`partially_refunded`), `captured_at`, `failure_reason` | UNIQUE `(provider, provider_order_id)`; UNIQUE `(provider, provider_payment_id)`; partial UNIQUE index: at most one `captured` payment per booking (with a separate "difference" payment kind for modifications) |
| `payment_events` | Raw verified provider/webhook events (simulated now, Razorpay later): `provider`, `event_id`, `type`, `payload_sha256`, `received_at`, `processed_at`, `signature_valid` | UNIQUE `(provider, event_id)`, which is the webhook idempotency key |
| `refunds` | Money going back: `booking_id`, `payment_id`, `cancellation_request_id` / `modification_id`, `amount`, `fee`, `status` (`pending`/`processing`/`succeeded`/`failed`), `provider_refund_id`, `reason` | UNIQUE `(provider, provider_refund_id)`; `amount > 0`; sum of non-failed refunds ≤ captured amount (enforced in the service under a row lock on the payment) |

### 4.5 Lifecycle records

| Entity | Responsibility | Key constraints |
|---|---|---|
| `cancellation_requests` | Customer- or admin-initiated: `requested_by` (customer/admin), `status` (`pending`/`approved`/`rejected`), `fee`, `refund_amount`, `reason`, `rejection_reason`, `decided_by_user_id`, `decided_at` | Partial UNIQUE index: one `pending` request per booking |
| `booking_modifications` | Before/after snapshot (date, items, totals as JSON), `price_difference`, `settlement` (`none`/`collect`/`refund`), `settlement_status`, `actor_user_id` | FK booking; append-only |
| `gate_scans` | Every scan attempt: `ticket_id` (nullable for unknown codes), `raw_code_hash` (not the raw code), `gate`, `device_id`, `user_id`, `result` (`valid`/`duplicate`/`invalid`), `reason`, `client_scan_id`, `scanned_at` | UNIQUE `(device_id, client_scan_id)`, so a retried scan is not counted twice |
| `audit_log` | Append-only: actor (user/customer/system), action, entity type and id, before/after JSON, request id, `at` | No UPDATE or DELETE by the application role; replaces `auditLog` |
| `notifications` | Admin inbox derived from audit events (replaces `notifications`) | `read_at` per user |
| `idempotency_keys` | `key`, `scope` (endpoint + actor), `request_sha256`, response status and body, `created_at` | UNIQUE `(scope, key)`; purge after 24 h |

### 4.6 Users (built in the authentication phase, §13)

| Entity | Responsibility |
|---|---|
| `users` | Admins, finance, counter staff, gate staff: `staff_code` (`STF1024`), name, phone, gate, `password_hash`, `active` |
| `user_roles` | Role grants: `admin`, `finance`, `counter`, `gate`, `marketing` |
| `auth_sessions` | Server-side sessions (hashed token, user, expiry, last seen, IP-derived nothing). Stored in Postgres; no Redis |
| `customer_otps` / `customer_access_tokens` | Hashed one-time codes and short-lived booking-access tokens |

### 4.7 Links to the existing influencer and regional tables

- `booking_attributions` **stays**. It gains a nullable `booking_id` FK (UNIQUE). It is written **in the same transaction** that captures payment, instead of by a browser event.
- `booking_attributions.booking_ref` stays UNIQUE, so the link to historical rows works by reference.
- `influencer_commissions` and `commission_events` are unchanged. Their service functions (`confirm_payment`, `cancel_booking`, `modify_booking`) are called from the new booking services rather than from `/api/booking-events/*`.
- `visitor_sessions` is unchanged; `bookings.visitor_session_id` points to it.

### 4.8 Relationship sketch

```
customers 1─* bookings *─1 visitor_sessions ─* referral_clicks
                 │  └─0..1 booking_attributions ─0..1 influencer_commissions ─* commission_events
                 ├─* booking_items ─* tickets ─* gate_scans
                 ├─* booking_offer_redemptions *─1 offers
                 ├─* payments ─* refunds
                 ├─* cancellation_requests ─0..1 refunds
                 └─* booking_modifications
date_inventory 1─* category_inventory *─1 ticket_categories
users ─* (gate_scans, bookings[counter], cancellation decisions, audit_log)
```

---

## 5. Proposed API structure

The existing routers are kept. All new write endpoints accept an **`Idempotency-Key`** header, and all money is computed server-side.

**Public catalog and pricing (no auth)**
- `GET /api/catalog`: categories, add-ons, active offers and settings needed by the UI.
- `GET /api/availability?from&to`: per date, whether it is open, the reason, the price tier, and remaining capacity per category. Coarse "few left" bands are an option, so exact stock is not exposed.
- `POST /api/quote` `{visit_date, cart}`: authoritative priced lines, totals and issues. It replaces `priceCart` as the source of truth; the UI calls it on cart changes (debounced).

**Customer booking**
- `POST /api/bookings` `{visit_date, cart, customer, session_token}` + `Idempotency-Key`: re-prices, takes holds, creates `pending_payment` and returns `booking_ref`, totals and `hold_expires_at`.
- `POST /api/bookings/{ref}/payments`: creates a payment order. Now: `provider=simulated`. Later: a Razorpay order.
- `POST /api/payments/simulated/{payment_id}/complete` `{outcome: success|decline}`: **demo-only**, enabled by `SIMULATED_PAYMENTS=1` and disabled in production. It goes through exactly the same `capture_payment()` service a real webhook will use.
- `POST /api/payments/razorpay/webhook`: *(Phase 7)* signature-verified.
- `GET /api/bookings/{ref}`: requires a booking-access token (from the confirmation link or OTP).
- `GET /api/bookings/{ref}/tickets`: QR payloads (server-signed).

**Customer self-service**
- `POST /api/customer/otp` / `POST /api/customer/otp/verify` → access token.
- `GET /api/customer/bookings`: the verified phone's bookings.
- `POST /api/bookings/{ref}/cancellation-requests`.

**Counter (role `counter`)**
- `POST /api/counter/sales`: same booking service, `channel=counter`, plus a counter payment captured in one transaction, with no visitor session.

**Gate (role `gate`)**
- `POST /api/gate/scan` `{code, gate, device_id, client_scan_id}` → result, ticket and booking summary.
- `GET /api/gate/scans?mine&date`.

**Admin (roles as noted)**
- `GET /api/admin/bookings` (filters, pagination); `GET /api/admin/bookings/{ref}`.
- `POST /api/admin/bookings/{ref}/cancel` (admin cancel and refund, `finance`).
- `POST /api/admin/bookings/{ref}/modify` with `dry_run=true` to preview the price difference.
- `GET /api/admin/cancellation-requests`; `POST …/{id}/approve`; `POST …/{id}/reject` (`finance`).
- `GET /api/admin/payments`, `GET /api/admin/refunds`.
- Catalog CRUD: `/api/admin/ticket-categories`, `/addons`, `/offers`, `/park-dates/{date}`, `/settings` (`admin`).
- `/api/admin/users` (`admin`).
- `GET /api/admin/dashboard`, `/api/admin/reports/*`, `/api/admin/audit-log`, `/api/admin/notifications`.
- Existing: `/api/admin/influencers…`, `/commissions…`, `/analytics`, `/regional` (unchanged contract; data source changes in §12).

**Legacy and transition**
- `POST /api/admin/legacy-import` (§14).
- `/api/booking-events/*`: kept during transition for old cached clients, then **disabled** (§12).

---

## 6. Booking lifecycle state machine

```
                 create (holds taken)
   (none) ───────────────────────────► PENDING_PAYMENT ──hold expires / abandoned──► EXPIRED   (holds released)
                                            │      └──payment failed (retry allowed until hold expiry)
                                            │ payment captured (one transaction: tickets issued,
                                            ▼   holds → sold, offer redemptions, attribution, audit)
                                        CONFIRMED ──admin modify──► CONFIRMED (new version; difference settled)
                                            │
                       customer requests ───┤ (CancellationRequest PENDING; booking stays CONFIRMED and valid)
                       admin approves  ─────┤
                       admin cancel    ─────┤
                                            ▼
                                        CANCELLED  (unused tickets → void; sold released; refund created; commission reversed)

   COMPLETED is derived for reporting, not stored: CONFIRMED and visit_date < today, or all tickets used.
   Counter sale: create + capture in one request ⇒ straight to CONFIRMED.
```

Guards, ported 1:1 from `store.ts` and implemented only in services:
- **Cancel request** (`cancellationEligibility`): status CONFIRMED; payment captured; no pending or decided request; no offer used; no ticket used; `visit_date ≥ today + 2 days` (IST).
- **Modify** (`modificationEligibility`): CONFIRMED; captured; no pending request; no offer or coupon; no ticket used; visit date not past; new date open; capacity available. Tickets in a category are kept (same codes), only added tickets get new codes, and removed tickets are voided.
- **Admin cancel** (`adminCancel`): CONFIRMED and captured; the fee applies (configurable, see the open question on 10% vs 25%).

Each transition:
- is one DB transaction;
- `SELECT … FOR UPDATE` locks the booking row (Postgres);
- bumps `bookings.version`;
- writes an `audit_log` row.

---

## 7. Inventory and capacity strategy

- **Two limits**, both currently ignored:
  - the park-wide daily capacity (`park_dates.capacity` ?? `defaultCapacity`, 4,000);
  - the per-category `daily_limit` (3,000 General, 400 Fast Track).
- Offer tickets count against their categories (e.g. "Buy 4 Get 2" = 6 × `ga`); complimentary tickets also consume capacity.
- **Atomic conditional update**, which is concurrency-safe on PostgreSQL without application locks:
  ```sql
  UPDATE category_inventory SET held = held + :n
   WHERE visit_date = :d AND category_id = :c AND held + sold + :n <= "limit"
  RETURNING held;          -- 0 rows ⇒ sold out ⇒ roll back the whole booking
  ```
  The same statement runs on `date_inventory` for the total.
  - Rows are always taken in a fixed order (date row first, then categories by id), which avoids deadlocks.
  - The CHECK constraints are the last line of defence.
- **Holds:**
  - `pending_payment` bookings hold stock for `HOLD_MINUTES` (default 15).
  - Capture moves the stock from `held` to `sold`. Cancel and void move it from `sold` back to available. Expiry releases it from `held`.
- **Hold expiry without Redis or workers:**
  - Expired holds are released lazily inside the next booking/availability transaction for that date (`… WHERE status='pending_payment' AND hold_expires_at < now() FOR UPDATE SKIP LOCKED`).
  - Optionally, a lightweight in-process periodic task can do the same, following the pattern of the existing GeoLite daemon thread. It must be safe with more than one replica, which `SKIP LOCKED` guarantees.
- **Offer redemptions:**
  ```sql
  UPDATE offers SET redemptions_count = redemptions_count + 1
   WHERE id = :o AND redemptions_count < max_redemptions
  ```
  - This runs at capture time.
  - A cancellation does **not** return a redemption, matching today's behaviour; this is to be confirmed.
- **Admin capacity changes:** refused below `held + sold`.
- **SQLite:**
  - The conditional UPDATE works, but SQLite serializes writers, so tests there prove the logic, not the concurrency.
  - Concurrency tests are **PostgreSQL-only** (§16).

---

## 8. Payment lifecycle

```
Payment: CREATED ──► CAPTURED ──► (PARTIALLY_)REFUNDED
            └──► FAILED            (AUTHORIZED is reserved for gateways with separate capture)
```

- `capture_payment(provider, provider_payment_id, amount, event_id)` is the **single** entry point that confirms a booking:
  - it is idempotent on `payment_events (provider, event_id)` and on `payments (provider, provider_payment_id)`;
  - it checks that the amount equals the booking total and the currency is INR;
  - in one transaction it:
    - locks the booking;
    - verifies `pending_payment` and an unexpired hold (a late capture on an expired hold re-takes stock if it is available; otherwise it is flagged for an automatic refund);
    - issues tickets, converts holds to sold, consumes offers;
    - writes `booking_attributions` (and the commission) through the existing `confirm_payment` logic;
    - writes the audit row.
- **Now:** the `simulated` provider. The demo payment screen calls `…/simulated/{id}/complete`, which builds a synthetic event and calls `capture_payment`. "Simulate a declined payment" marks the payment `FAILED` and the booking stays `PENDING_PAYMENT` until retry or expiry. This replaces today's "no booking at all" (a declined attempt is now auditable server-side).
- **Later (Razorpay):**
  - `POST /api/bookings/{ref}/payments` creates the Razorpay order server-side (amount from the DB) and stores `provider_order_id`.
  - Checkout returns `razorpay_payment_id` and `razorpay_signature` to the browser. The browser forwards them **only as a hint**; the server verifies the signature with the key secret and still treats the webhook (`payment.captured`, verified with `X-Razorpay-Signature` against the webhook secret) as authoritative.
  - Both paths call `capture_payment`; duplicates are no-ops.
  - Reconciliation job: list orders that are `CREATED` for more than N minutes and fetch their status from the gateway.
- **Browser-originated "paid" is never proof.**
  - `/api/booking-events/paid` stops creating attributions once the new flow is live.
  - The outbox code is removed from `referral.ts`.

---

## 9. Cancellation and refund lifecycle

```
CancellationRequest: PENDING ──approve──► APPROVED ──► Refund PENDING ─► PROCESSING ─► SUCCEEDED
                         └──reject (reason required)──► REJECTED          └────────► FAILED (retry / manual)
Admin cancel = request(admin) + approve in one transaction.
```

On approval, in one transaction:
1. booking → `CANCELLED`;
2. unused tickets → `void`;
3. inventory `sold` released;
4. a refund row (amount = total − fee, with the fee recorded);
5. the existing `cancel_booking()` reverses the commission and marks the attribution cancelled;
6. an audit row.

- **Refund processing:**
  - `simulated`: marked `SUCCEEDED` immediately.
  - Razorpay later: refund API call after commit, using an outbox row in Postgres; `refund.processed`/`refund.failed` webhooks update the status idempotently by `provider_refund_id`.
- **Rejection:** booking unchanged; the reason is visible to the customer.
- **A pending request does not block gate entry** (today's deliberate rule is kept).
- **Modification price differences** produce either a `payments` row of kind `difference` (collect) or a `refunds` row linked to the modification. Today the difference is only displayed.
- **Open question:** the cancellation fee is 10% in the app and 25% in MGM's FAQ. It becomes `park_settings.cancellation_fee_pct` so the decision is configuration, not code.

---

## 10. Counter Sale integration

- `POST /api/counter/sales` (role `counter`) reuses the **same** quote, hold and booking service with `channel='counter'`, `created_by_user_id`, and a `counter_cash|upi|card` payment captured in the same transaction.
- **It never receives influencer attribution:**
  - `visitor_session_id` is forced NULL (DB CHECK);
  - `capture_payment` skips the attribution step for `channel != 'web'`;
  - a test asserts that a counter sale made while the staff browser holds a referral session creates no attribution or commission.
- Counter sales consume the same inventory, so they cannot oversell the website, and vice versa.
- **Reporting:** counter sales appear in all sales totals as channel "Counter (walk-in)". Their location is "On-site", not "Unknown", so the "Unknown location" KPI stays meaningful for the web.

---

## 11. Gate scanning and duplicate-entry prevention

- **QR v2:** `MGMDW2|<ticket_code>|<booking_ref>|<visit_date>|<sig>`, where `sig` = base32 HMAC-SHA256 truncated to 10 characters with server secret `QR_SIGNING_SECRET`.
  - Forgery is impossible without the secret.
  - `MGMDW1` codes are accepted **only** for tickets that exist in the DB (legacy imports), because their signature proves nothing.
- `POST /api/gate/scan`:
  1. Verify the signature, then look up the ticket by `ticket_code`.
  2. Validate in this order (same as `evaluateScan`): payment captured → not void or cancelled → visit date = today (IST, server clock) → not used.
  3. **Atomic admit:**
     ```sql
     UPDATE tickets SET status='used', used_at=now(), used_gate=:g, used_by_user_id=:u
      WHERE id=:t AND status='issued' AND visit_date = :today
     ```
     1 row = VALID; 0 rows = re-read → DUPLICATE (with the previous time and gate) or INVALID.
  4. Always insert a `gate_scans` row. `client_scan_id` makes a scanner's network retry idempotent: the retry returns the original result instead of "duplicate".
- **Re-entry entitlement** (`reEntry`, today only displayed): if the category allows re-entry, a second scan the same day is VALID and logged, but the ticket stays `used` from the first admit. Optional, since today's rule simply rejects a second scan.
- **Network dependency:** the gate needs connectivity. An offline mode (a signed per-day manifest with conflict merging) is **out of scope** and listed as a risk.

---

## 12. Integration with the influencer and regional modules

**What does not change:**
- visitor sessions, source classification and geolocation;
- first-click attribution, the 30-day window and frozen rates;
- `max_bookings_per_session`;
- commission statuses, approvals, payouts, reversals and `commission_events`.

**What changes:**
1. The `confirm_payment` / `cancel_booking` / `modify_booking` services in `services.py` are refactored so they can run **inside the caller's transaction** (today each calls `db.commit()`). The booking services call them; the browser no longer does.
2. `POST /api/bookings` takes the visitor `session_token`. The session is resolved server-side and stored as `bookings.visitor_session_id`; the geo/source snapshot is still copied at capture, exactly as today.
3. `booking_attributions` gains `booking_id`. Amounts in it come from the server's own totals, so the tampering risk documented in handover §12 disappears for new bookings.
4. **Regional analytics (`compute_regional`)** is switched to read **sales** from `bookings` + `payments`, and **location and source** from `booking_attributions` (web), with counter as its own channel.
   - Sessions still come from `visitor_sessions`.
   - Paid/cancelled/revenue then match the booking ledger exactly.
   - The response shape and the dashboard are unchanged, with one additional "Counter (walk-in)" channel row.
5. `/api/booking-events/*`:
   - **Phase 3:** rejects events for refs that exist in `bookings`, because the server already knows them, and accepts only unknown legacy refs.
   - **Phase 6:** returns `410 Gone`.
   - `reportPaid`/`reportCancelled`/`reportModified` and the outbox are deleted from the frontend.

---

## 13. Authentication and authorization

**Current limitations:**
- Admin and Counter Sale are open to anyone who opens `#admin`.
- The only server protection is one shared `ADMIN_API_TOKEN`, pasted into sessionStorage and guarding just the influencer screens.
- Staff passwords are `mgm123`, in plaintext in the JS bundle and localStorage.
- Customer history is retrieved by phone number alone.
- `BOOKING_EVENTS_TOKEN` cannot protect a browser-called endpoint.

**Why this changes priority.** Today each browser can only leak its own data. **Once bookings are central, an unauthenticated admin API would expose every customer's name, phone and email to the internet.** Centralization therefore makes authentication a **go-live prerequisite**. It is not a prerequisite for starting development.

**Recommendation:**
- **Staff and admins:**
  - a `users` table with Argon2id password hashes;
  - server-side sessions in Postgres (`auth_sessions`), delivered as an `HttpOnly; Secure; SameSite=Lax` cookie;
  - CSRF protection via the SameSite cookie plus a double-submit token on state-changing requests;
  - rate-limited login (per account and per IP, counters in Postgres);
  - roles enforced by FastAPI dependencies (`require_role("finance")`).

  | Role | Can do |
  |---|---|
  | `admin` | catalog, settings, users |
  | `finance` | approve/reject refunds, admin cancel, modifications with money |
  | `counter` | counter sales |
  | `gate` | scan |
  | `marketing` | influencer module |

  - `ADMIN_API_TOKEN` stays only as a break-glass and bootstrap credential, used to create the first admin, and is then disabled.
  - Optional later: TOTP for `admin` and `finance`.
- **Customers:**
  - Phone OTP (SMS provider to be chosen, e.g. MSG91 or Twilio; hashed 6-digit code, 5-minute expiry, 5 attempts) yields a short-lived customer token scoped to that phone.
  - Each confirmation also carries a **per-booking signed access link** (random token, stored hashed), so a customer can open their tickets without an OTP.
  - Responses mask the phone and email.
- **New dependency:** Argon2 needs a package (`argon2-cffi`). This is flagged, not installed.

**Sequencing:**
- Development of Phases 1–3 can proceed behind the existing `require_admin` token, in non-production environments only.
- Phase 4 (auth) must be complete **before** production cut-over and before customer self-service goes live.
- OTP depends on an SMS-provider decision. Until then, customers use the per-booking link; no phone-only lookup goes to production.

---

## 14. Data migration strategy

**What exists and where:**

| Data | Location | Recoverable centrally? |
|---|---|---|
| Seeded demo bookings, scans, staff and catalog | Every browser; generated deterministically (`mulberry(20261119)`) | **Re-creatable**, not migratable. They are demo data and must not reach production |
| Bookings made live in a browser (`live: true`, including counter sales) | Only that browser's localStorage | Only if someone opens **that browser** and exports or imports |
| Paid website bookings reported via the outbox | `booking_attributions` in Postgres: ref, amounts, visit date, status, geo/source, **no customer details, no tickets** | Yes, but only as financial/attribution stubs |
| Scans, refunds, modifications, notifications, activity log | Per browser | Only via the same per-browser export |
| Catalog edits (prices, offers, calendar, settings) | Per browser | Only via export; otherwise reseeded from code |

**What cannot be reliably recovered:**
- bookings in browsers nobody opens again;
- cleared storage;
- counter sales (never reported);
- customer details for attribution-only refs;
- whether a browser-claimed payment was real (none were: all payments are simulated).

**Plan:**
1. **Catalog:**
   - The migration seeds `ticket_categories`, `addons`, `offers`, `park_dates` and `park_settings` from the current code constants (`seedTickets`, `seedAddons`, `seedOffers`, the `seedDB` `dateCfg`, `defaultSettings`).
   - This is configuration, so a data migration is appropriate.
   - The `redemptions` counters in the seed are fictional and start at 0 in production. A demo seed can set them.
2. **Demo data:**
   - A separate, explicit command (`python -m app.scripts.seed_demo`, refused when `ENV=production`) ports `seedBookings` server-side with `origin='demo_seed'`, for demo and staging environments.
   - Reports can filter on `origin`.
3. **Legacy import, never silent and never automatic:**
   - Admin › Settings gets "Export this browser's data" (JSON download of `mgm-dizzee-proto-v3`) and "Submit live bookings to server".
   - The latter posts **only** `live: true` bookings to `POST /api/admin/legacy-import`. The server inserts them with `origin='legacy_import'`, their original `booking_ref` and ticket codes (so printed QR codes still scan), the payment marked `simulated`, and flags them unverified.
4. **No duplicates:**
   - `bookings.booking_ref` is UNIQUE. A ref that already exists is reported as a conflict and **never overwritten**. The import returns a per-booking result (`imported` / `already_present` / `conflict` / `rejected`, with a reason).
   - Imports link to an existing `booking_attributions` row by `booking_ref`, setting `booking_id`, instead of creating a second one.
   - Imports consume inventory only for future dates, best-effort. Over-capacity imports are imported anyway and flagged, because the customer already has a ticket.
5. **Customers with legacy browser bookings:**
   - The frontend never deletes `mgm-dizzee-proto-v3`; it stops writing it.
   - My Bookings shows server bookings. If the device holds live local bookings whose refs the server does not know, it shows them in a separate "Saved on this device only, not confirmed by MGM" section with a "Send to MGM for verification" action (the same import endpoint, queued for admin review).
   - The local copy is kept until the server confirms the import.
6. Attribution-only refs with no booking stay as they are. Analytics label them "legacy (attribution only)" rather than inventing bookings.

---

## 15. Proposed Alembic migration sequence

All migrations are additive, reversible on empty tables, and tested on SQLite and PostgreSQL (Neon) through `TEST_DATABASE_URL`. None drops or rewrites existing influencer data.

| Rev | Content |
|---|---|
| `0003_catalog` | `park_settings`, `ticket_categories`, `addons`, `offers`, `park_dates`, plus a **data seed** of the current catalog constants |
| `0004_customers_bookings` | `customers`, `bookings`, `booking_items`, `booking_offer_redemptions`, `tickets`, `date_inventory`, `category_inventory`, `idempotency_keys` |
| `0005_payments` | `payments`, `payment_events`, `refunds` |
| `0006_lifecycle` | `cancellation_requests`, `booking_modifications`, `audit_log`, `notifications` |
| `0007_gate` | `gate_scans` (plus `users` minimal, if Phase 4 precedes the gate; otherwise `0008`) |
| `0008_auth` | `users`, `user_roles`, `auth_sessions`, `customer_otps`, `customer_access_tokens`; data seed: none (the bootstrap admin is created by a command, never with a default password) |
| `0009_link_attribution` | `booking_attributions.booking_id` (nullable, UNIQUE FK) and `channel`; a backfill links rows by `booking_ref` where a booking exists |

Partial unique indexes (pending request per booking, captured payment per booking) are PostgreSQL features. On SQLite they use `sqlite_where` (supported) or a service-level check with a test.

---

## 16. Testing strategy

- **Pricing parity (highest risk):**
  - Port `priceCart` to Python (`app/pricing.py`).
  - Generate a JSON fixture of about 200 carts × dates × coupons by running the **existing TS** engine, then assert the Python engine returns identical lines and totals.
  - Rounding must match JS `Math.round`, which is half-up for positives; Python's `round()` is banker's rounding, so use `Decimal.quantize(ROUND_HALF_UP)`.
  - Keep the fixture as a regression test.
- **Service unit tests:** every guard in §6, §9 and §11, ported from `tests/store.test.ts`, plus new ones (hold expiry, late capture, amount mismatch).
- **API tests:** the existing `TestClient` pattern, covering auth and role enforcement on every router (deny by default).
- **Transactional tests:** a failure injected mid-capture (e.g. the attribution write raises) leaves **no** tickets, no inventory change and no redemption.
- **Concurrency tests (PostgreSQL-only, skipped on SQLite):**
  - N=50 threads, each with its own session, book the last K seats → exactly K confirmed, the rest "sold out", and `sold == K`.
  - The same ticket scanned concurrently at 2 gates → exactly 1 VALID and 1 DUPLICATE.
  - A duplicate capture webhook × 10 concurrently → 1 capture, 1 set of tickets, 1 attribution, 1 commission.
  - Concurrent approve and reject of the same cancellation request → exactly one wins.
  - The same `Idempotency-Key` sent concurrently → one booking; the other request gets the stored response.
  - Offer at `max_redemptions − 1` with 5 concurrent captures → exactly 1 redemption.
- **Migration tests:** extend `test_migrations.py`. Upgrade from `0002` with seeded influencer data → head; verify the data is preserved, the catalog is seeded, the attribution backfill links, and downgrade works on empty tables.
- **Influencer regression:** all 64 existing backend tests must keep passing at every phase.
- **Frontend:** `npm test` (store logic shrinks as it moves server-side), `tsc`, and an end-to-end browser run of each phase's flows (built-in browser, backend on Neon).
- **Load smoke:** a short script of 200 concurrent bookings against a staging Railway deployment, to measure p95 latency and catch connection-pool limits (Neon pooled endpoint vs direct connections).

---

## 17. Risks and dependencies

| Risk | Impact | Mitigation |
|---|---|---|
| Pricing drift between the TS UI and the Python server | Wrong totals or customer disputes | The server is the only authority (`/api/quote`); parity fixture; the UI shows server totals before payment |
| Rounding and GST differences (JS `Math.round` vs Python) | Totals one rupee off | `ROUND_HALF_UP`; parity tests |
| Timezone: today's `TODAY` is the browser clock with a demo clamp to 19 Nov | Wrong-day admits; the 48 h rule broken | All date logic server-side in `Asia/Kolkata`; the demo clock override becomes an explicit `DEMO_TODAY` setting, refused in production |
| PII exposure once centralized | Data breach | Auth (Phase 4) before production; role checks; masked responses; audit log |
| Gate connectivity / Neon cold start | Queues at the gate | Neon "always on" (or Railway Postgres) for production; scanner timeouts with a clear retry UI; offline mode as a later project |
| Single-file offline demo (`static-build/index.html`) can no longer book | Loss of the double-click demo | **Decision needed:** keep the static build as an explicitly labelled offline demo on the old local engine, or retire it. Recommend retiring it once Railway staging exists, to avoid maintaining two engines |
| SQLite can't prove concurrency | False confidence | PostgreSQL-only concurrency suite run before each merge |
| Refactoring `confirm_payment` and others to the caller's transaction | Regressions in commissions | Keep their tests; add caller-transaction tests; refactor first, in isolation |
| Business rules unconfirmed: cancellation fee 10% vs 25%; whether cancelled offers return redemptions; re-entry rules | Rework | Configurable settings; MGM confirmation listed as a dependency |
| SMS provider for OTP not chosen | Customer self-service blocked | Per-booking access links first |
| Razorpay account and keys | Phase 7 blocked | Not needed until Phase 7 |
| New Python dependency (`argon2-cffi`) | Install approval | Requested at Phase 4 |

**Dependencies on MGM or the business:**
- the cancellation fee;
- the SMS provider;
- confirmation of real capacity and per-category limits (the seed values 4,000/3,000/400 are illustrative);
- GST treatment of add-ons;
- the Razorpay merchant account (later).

---

## 18. Phased implementation with acceptance criteria

Each phase: its own commits on the PR branch (or a stacked PR, by your choice), tests on SQLite and Neon, no production deploy.

| Phase | Scope | Acceptance criteria |
|---|---|---|
| **0. Foundations** | `0003_catalog`; IST date service and `DEMO_TODAY`; catalog read API; Python pricing engine plus the parity fixture; `/api/quote`; `/api/availability` | Parity test passes for every fixture case; the UI renders catalog and prices from the API (localStorage is no longer the catalog source); 64 existing tests still pass |
| **1. Bookings, inventory and simulated payments** | `0004`, `0005`; `POST /api/bookings`, payment create, simulated complete, `capture_payment`; holds and expiry; ticket issuance; QR v2; attribution written in-transaction; customer site switched to the API | The browser cannot mark anything paid (no client code path sets payment status); concurrent booking test: no oversell; duplicate capture: one booking and one commission; failure injection: no partial state; regional analytics show the same numbers for a booking as the booking ledger |
| **2. Lifecycle** | `0006`; cancellation requests, approve/reject, admin cancel, refunds (simulated), modifications with dry-run and difference settlement; admin booking and payment screens switched to the API | Every `store.test.ts` rule has a passing server-side equivalent; approve/reject race test; commission reversal and re-pricing verified through the new path; ticket codes preserved on modification |
| **3. Counter and gate** | `/api/counter/sales`; `0007` gate scans; scanner switched to the API; `/api/booking-events/*` restricted to legacy refs | Counter sale: no attribution even with a referral session present (test); double-scan race: exactly one VALID; scanner retry idempotent; counter sales appear in sales reporting as their own channel |
| **4. Authentication and authorization** | `0008`; staff/admin login, roles and cookies; bootstrap command; per-booking customer access links; OTP if the provider is chosen; remove `mgm123` and the client staff list | Every admin, counter and gate endpoint returns 401/403 without the right role (parametrized test over the route table); no credential in the JS bundle (build grep check); phone-only lookup is removed |
| **5. Admin read models and analytics cut-over** | Dashboard, reports, audit log and notifications from the server; `compute_regional` reads the booking ledger (`0009` link and backfill); catalog editors write via the API | Dashboard numbers equal SQL over `bookings`/`payments`; the regional and influencer tests are green; legacy attribution-only rows are labelled |
| **6. Legacy import and decommission** | Export/import UI and endpoint; "saved on this device only" section; outbox and `/api/booking-events/*` removed (410); `mgm-dizzee-proto-v3` becomes read-only; static-build decision applied; handovers updated | Import is idempotent (a re-import yields `already_present`) and conflicts are never overwritten; nothing in `src/` writes transactional data to localStorage (grep test); staging end-to-end on Railway |
| **7. Payment gateway** *(separate approval)* | Razorpay order creation, signature verification, webhook, refunds, reconciliation | Webhook signature test vectors; replayed webhook is a no-op; amount mismatch rejected; refund webhooks idempotent |

**Recommended order of the first concrete steps once approved:**
1. Phase 0 parity fixture (it de-risks everything else).
2. Refactor `confirm_payment`, `cancel_booking` and `modify_booking` to the caller's transaction, with the existing tests green.
3. Phase 1.

**Decisions needed before implementation:**
1. The static offline demo: keep it or retire it.
2. Whether to keep everything on PR #2 or open stacked PRs per phase. Recommendation: stacked PRs, because PR #2 is already large.
3. The cancellation fee: 10% or 25%.
4. SMS provider timing.
5. Whether auth (Phase 4) should move ahead of Phases 2–3 if a staging environment will be shared with MGM staff.
