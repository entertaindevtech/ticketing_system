# Database schema and migrations

**Conventions:**
- PostgreSQL in every shared environment; SQLite for local development only.
- SQLAlchemy 2 models are in `backend/app/models.py`; Alembic migrations are in `backend/alembic/versions/`.
- Money is `NUMERIC(12,2)`. Timestamps are `timestamptz` and stored in UTC; the park's dates are `date` values in Asia/Kolkata.

## Migration history

All migrations are additive. Each `downgrade` is exercised by `tests/test_migrations.py` (upgrade to head, then downgrade to base), on SQLite and on PostgreSQL.

| Rev | Adds | Data |
|---|---|---|
| `0001` | `influencers`, `referral_sessions`, `referral_clicks`, `booking_attributions`, `influencer_commissions`, `commission_events` | – |
| `0002` | renames `referral_sessions` → `visitor_sessions`; acquisition source, UTM fields, attribution window; nullable influencer on bookings | backfills existing rows as influencer traffic (tested) |
| `0003` | `park_settings`, `ticket_categories`, `addons`, `offers`, `park_dates` | seeds the catalog from `app/catalog_seed.py` |
| `0004` | `customers`, `bookings`, `booking_items`, `tickets`, `date_inventory`, `category_inventory`, `payments`, `payment_events`, `audit_log`, `notifications`; `booking_attributions.booking_id`, `.channel` | – |
| `0005` | `cancellation_requests`, `booking_modifications`, `refunds` | – |
| `0006` | `gate_scans` | – |
| `0007` | `users`, `auth_sessions` | none (no default accounts or passwords) |

Run `python -m alembic upgrade head`; the Dockerfile does this on every deploy. `python -m alembic current` shows the revision.

## Tables

### Catalog and configuration

Catalog rows keep the front-end's own object shape in `data` (JSON). The columns that SQL must filter, lock or constrain are kept alongside and take precedence over `data`.

| Table | Key columns | Constraints |
|---|---|---|
| `park_settings` | `id`, `data` (gst, openTime/closeTime, defaultCapacity, saleStart/saleEnd, cancellationFeePct, cancelNoticeDays, holdMinutes, contact) | `CHECK id = 1` (single row) |
| `ticket_categories` | `id` (`ga`, `gc`, `fa`, `fc`), `active`, `daily_limit`, `data` (name, kind, audience, basePrice, entitlements) | `daily_limit >= 0` |
| `addons` | `id`, `active`, `data` | – |
| `offers` | `id`, `coupon` (UNIQUE, upper-case), `status`, `max_redemptions`, `redemptions`, `data` (rules) | status in draft/scheduled/active/paused/expired; counters ≥ 0. `redemptions` changes only through conditional UPDATE |
| `park_dates` | `visit_date` PK, `data` (enabled, blackout, capacity, priceAdj, note) | – |

### Booking ledger

| Table | Purpose | Important constraints |
|---|---|---|
| `customers` | One per mobile number | `phone` UNIQUE |
| `bookings` | One order. Holds the server-priced totals, a customer snapshot, `channel` (web/counter), `origin` (live, legacy_import or demo_seed), `status`, `hold_expires_at`, `units` (admissions to issue), `visitor_session_id`, `idempotency_key`, `version` | `ref` UNIQUE; `idempotency_key` UNIQUE; status in pending_payment/confirmed/cancelled/expired; `CHECK channel = 'web' OR visitor_session_id IS NULL` (counter sales can never be attributed); amounts ≥ 0 |
| `booking_items` | Priced lines (ticket, offer or add-on) | `qty > 0`; kind check |
| `tickets` | One per admission: `code` (`TKT-…`), `visit_date`, `status` (issued/used/void), used_at/gate/by | `code` UNIQUE; `CHECK status <> 'used' OR used_at IS NOT NULL`; index on (visit_date, status) |
| `date_inventory` | Park-wide admissions per date: `capacity`, `held`, `sold` | `CHECK held >= 0 AND sold >= 0 AND held + sold <= capacity` |
| `category_inventory` | The same, per (date, category) | Same check |
| `payments` | Charge attempts and price differences: provider (simulated, counter, legacy, later razorpay), `amount`, `status` | UNIQUE (provider, provider_payment_id); status check; amount ≥ 0 |
| `payment_events` | Every processed provider event | UNIQUE (provider, event_id), so replays are no-ops |
| `cancellation_requests` | Request and decision: fee, refund amount, reasons, decided_by | Partial UNIQUE index: one `pending` request per booking |
| `refunds` | Money back: amount, fee, status (pending/processing/succeeded/failed) | `amount > 0`; `provider_refund_id` UNIQUE; service check that refunds never exceed the amount paid |
| `booking_modifications` | Before/after snapshots, price change, settlement (none/collect/refund) | Append-only |
| `gate_scans` | Every scan attempt and its result | UNIQUE (device_id, client_scan_id), so retries are not double-counted |
| `audit_log` | Who did what, when, to which reference | Append-only by design (see HANDOVER §9 for role hardening) |
| `notifications` | Admin inbox derived from events | – |

### Staff

| Table | Purpose | Constraints |
|---|---|---|
| `users` | Staff accounts: `code`, name, gate, `roles` (comma-separated), Argon2id `password_hash`, lockout counters, `active` | `code` UNIQUE |
| `auth_sessions` | Server-side sessions; only the SHA-256 of the cookie value is stored | `token_hash` UNIQUE |

### Influencer and regional intelligence (unchanged in meaning)

`influencers`, `visitor_sessions`, `referral_clicks`, `booking_attributions`, `influencer_commissions`, `commission_events`. See `INFLUENCER-MODULE-HANDOVER.md`.

Since migration 0004, the booking engine writes `booking_attributions` in the same transaction as payment capture, cancellation and modification:
- one row per confirmed booking;
- `booking_id` links the row to its booking;
- `channel` is `web` or `counter`.

Rows with `booking_id IS NULL` come from the retired browser-reported events. Import links them when the matching legacy booking arrives.

## Relationships

```
customers 1─* bookings ─*1 visitor_sessions ─* referral_clicks *─1 influencers
              │  └─0..1 booking_attributions ─0..1 influencer_commissions ─* commission_events
              ├─* booking_items          ├─* payments ─* payment_events
              ├─* tickets ─* gate_scans   ├─* refunds
              ├─* cancellation_requests   └─* booking_modifications
date_inventory / category_inventory  (per visit date; category → ticket_categories)
users ─* auth_sessions
```
