# API reference

All endpoints are under `/api` and exchange JSON. The live, interactive schema is at `/docs` (FastAPI). Errors look like `{"detail": "…"}`:

| Status | Meaning |
|---|---|
| 401 | Not signed in |
| 403 | Wrong role, or missing CSRF header |
| 404 | Not found, or wrong access token |
| 409 | Conflict, e.g. sold out or not eligible |
| 410 | Retired endpoint |
| 422 | Invalid input |

**Authentication:**
- **Staff** sign in with `POST /api/auth/login`. This sets the HttpOnly `mgm_session` cookie. Every non-GET staff request must also send `X-Requested-With: mgm-app`.
- **Customers** use the per-booking token returned at creation, sent as `X-Booking-Token`.
- **Break-glass:** `X-Admin-Token: <ADMIN_API_TOKEN>` acts as admin.

**Idempotency:** `POST /api/bookings` and `POST /api/counter/sales` accept an `Idempotency-Key` header. Repeating the same key and body returns the original booking; reusing a key with a different body returns 409.

## Public (no authentication; never returns customer data)

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Liveness, plus whether the GeoLite database is loaded |
| `GET /api/catalog` | Ticket categories, add-ons, active non-coupon offers, per-date settings, park settings, and the park's `today` |
| `GET /api/availability?from&to` | Per date: open or closed with the reason, price adjustment, and remaining capacity (total and per category). Maximum range 92 days |
| `POST /api/quote` `{visit_date, cart}` | Server-priced lines and totals, validated coupon, date status |
| `POST /api/visits` | Anonymous visitor session and influencer click capture (influencer handover) |

## Customer booking (per-booking access token)

| Method & path | Purpose |
|---|---|
| `POST /api/bookings` `{visit_date, cart, customer{name, phone, email?, notes?}, session_token?}` | Prices the booking on the server, holds stock and offer redemptions, and creates a `pending_payment` booking. Returns `{booking, accessToken, accessUrl}` |
| `GET /api/bookings/{ref}` | The booking, with signed ticket QR payloads |
| `POST /api/bookings/{ref}/payments` `{method}` | Opens a payment (simulated provider while `SIMULATED_PAYMENTS=1`; 503 when payments are off) |
| `POST /api/bookings/{ref}/payments/{id}/simulate` `{outcome: success, decline}` | Demo provider only (404 when disabled). Captures through the same path a verified webhook will use |
| `POST /api/bookings/{ref}/cancellation-request` | Customer cancellation request (eligibility enforced) |

The booking object uses the front-end `Booking` shape (`src/store.ts`), plus:
- `state`, `channel`, `origin`, `holdExpiresAt`;
- `refunds[]`, `differences[]`;
- `tickets[].qr`.

## Staff sign-in

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/auth/login` `{code, password}` | anyone | Starts a session (lockout after 5 failures) |
| `POST /api/auth/logout` | signed in | Ends the session |
| `GET /api/auth/me` | signed in | Current staff member and roles |
| `POST /api/auth/password` `{current, new}` | signed in | Changes own password; signs out other sessions |

## Counter and gate

| Method & path | Roles | Purpose |
|---|---|---|
| `POST /api/counter/sales` `{visit_date, cart, customer, method: Cash, UPI or Card}` | counter, admin | Creates and pays a counter booking in one transaction (shared inventory, never attributed) |
| `POST /api/gate/scan` `{code, device_id?, client_scan_id?}` | gate, admin | Validates a QR payload or ticket code and admits it atomically. Returns `{kind: valid, duplicate or invalid, title, reason, ticket?, booking?, previous?}` |
| `GET /api/gate/scans?date&mine` | gate, admin | Scan history (defaults to your scans today) |

## Admin console

The `admin` role can call everything. The other roles can call only what this table lists.

| Method & path | Roles | Purpose |
|---|---|---|
| `GET /api/admin/state?days_back&days_ahead` | admin, finance | Everything the console renders: full catalog, bookings in the window, scans, staff, notifications, audit log |
| `GET /api/admin/bookings?from&to&q&limit` | admin, finance, counter | Search bookings |
| `GET /api/admin/bookings/{ref}` | admin, finance, counter | One booking, with QR payloads |
| `POST /api/admin/bookings/{ref}/cancellation/approve` | admin, finance | Approve: cancel, void tickets, release stock, refund, reverse commission |
| `POST /api/admin/bookings/{ref}/cancellation/reject` `{reason}` | admin, finance | Reject, with a reason the customer sees |
| `POST /api/admin/bookings/{ref}/cancel` | admin, finance | One-step admin cancel and refund (fee applies) |
| `POST /api/admin/bookings/{ref}/modify` `{visit_date, tickets, addons, dry_run?}` | admin, finance | Re-price and change a booking (keeps ticket codes). With `dry_run`, previews the difference |
| `POST /api/admin/refunds/{id}/process` | admin, finance | Mark a pending refund as processed (simulated, counter or legacy providers) |
| `POST /api/admin/payments/{id}/collect` `{method}` | admin, finance, counter | Record collection of a modification price difference |
| `PUT /api/admin/ticket-categories/{id}` | admin | Create or update a ticket category. Capacity is synced to inventory and refused below what is already sold |
| `PUT /api/admin/offers/{id}` · `DELETE /api/admin/offers/{id}` | admin | Create or update an offer; delete one only if it was never used |
| `PUT /api/admin/park-dates/{date}` | admin | Open or close the date, blackout, capacity, price adjustment, note |
| `PATCH /api/admin/settings` | admin | GST, capacity, cancellation fee and notice, sale window, hold minutes, park details |
| `POST /api/admin/notifications/{id}/read` · `/read-all` | admin, finance | Notifications inbox |
| `GET /api/admin/users` · `POST /api/admin/users` · `PATCH /api/admin/users/{code}` | admin | Staff accounts (roles, gate, password reset, deactivate) |
| `POST /api/admin/legacy-import` `{bookings: [...]}` | admin | Import bookings exported from the retired browser-only version (per-booking result) |
| `GET /api/admin/influencers…`, `/commissions…`, `/analytics`, `/regional` | admin, marketing | Influencer and regional intelligence (influencer handover §8). `/regional` now includes counter sales as the `counter` channel |

## Retired

`POST /api/booking-events/{paid, cancelled, modified}` returns **410 Gone**. The booking engine records these itself; browser reports are never trusted.
