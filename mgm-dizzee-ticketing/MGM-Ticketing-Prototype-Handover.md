# MGM Dizzee World Ticketing — Technical Handover

Last updated 25 Nov 2026 (source consolidation). This replaces the 22 Nov version, which described a hand-patched `static-build/index.html` that is no longer maintained by hand.

The influencer and regional-sales backend is documented separately in [INFLUENCER-MODULE-HANDOVER.md](INFLUENCER-MODULE-HANDOVER.md).

## 1. Architecture: one source of truth

```
src/                      React 19 + TypeScript + Vite + Tailwind v4   ← THE application (edit here)
  store.ts                data model, pricing, scan validation, booking business rules (pure, unit-tested)
  customer.tsx            customer booking site, My Bookings, cancellation request
  admin.tsx               admin console (all modules except the two below)
  counter.tsx             Admin › Counter Sale (reuses the customer booking steps)
  influencers.tsx         Admin › Influencers & Regions (talks to backend/)
  referral.ts             ?ref capture + booking-event outbox to backend/
  staff.tsx, ui.tsx, charts.tsx, qr.ts
backend/                  FastAPI + PostgreSQL — influencer attribution, commissions, analytics
tests/store.test.ts       booking business-rule regression tests (npm test)
scripts/build-static.mjs  produces static-build/index.html from src/
static-build/index.html   GENERATED single-file build (double-click to open). Never edit by hand.
```

**Decision: React/Vite `src/` is authoritative, and the single file is a build artefact.**

**What we found.**
- Until this change, `src/` and `static-build/index.html` had diverged.
- The static file was the original `src/` build plus ten hand-inserted patches written into minified code:
  - the eight features below;
  - Counter Sale;
  - the Skip Add-ons button.
- None of the ten existed in `src/`.
- `src/` alone had the influencer module.

**Why this direction.**
- Editing minified JavaScript cannot be reviewed, type-checked or tested.
- It had already introduced defects (§3).
- Two hand-maintained copies would drift again.

**How the single file is produced now.**
- `npm run build:static` builds `src/` and inlines the JS, the CSS and every image into `static-build/index.html`.
- The demo file still works offline by double-click, but it can no longer drift from the source.
- The previous hand-patched file is retained in git history (commit `c5cfe30`). The two local `index.backup-*.html` files were never committed and are not part of the repo.

## 2. Features migrated from the old static build into `src/`

| Feature | Where now | Business rules |
|---|---|---|
| A. Customer cancellation request | Booking page → "Cancellation & refund" (reached from confirmation or **My Bookings**) | Paid, regular (non-offer) bookings only; at least 48 h before the visit; no tickets used; 10% fee; booking stays valid until reviewed |
| B. Admin refund approve / reject | Admin › Payment Management › "Pending refund requests" | Approve cancels the booking and its unused tickets and marks the payment refunded. Reject asks for a reason, which the customer sees; the booking stays valid |
| C. Booking modification | Admin › Booking Management › booking › "Modify booking" | Change date, ticket quantities and add-ons with a live re-price; the difference to collect or refund is shown and recorded |
| D. Ticket entitlements | Admin › Ticket Management › Edit | Validity note, same-day re-entry, restrictions; now also **shown to customers** on the ticket card |
| E. Capacity KPIs | Admin › Dashboard (second row) | Admitted / Expected / Remaining / Capacity today |
| F. Customer booking history | Home page → "My Bookings" button | Lookup by mobile number |
| G. Notification centre | Admin › Oversight › Notifications | Unread badge in the nav; mark read / mark all read |
| H. Activity log | Admin › Oversight › Activity Log | Admin, customer and counter actions merged with gate scans; searchable |
| Counter Sale | Admin › Counter Sale | Walk-in sale (Cash/UPI/Card simulated), printable QR receipt. **Never** referral-attributed |
| Skip Add-ons | Customer booking, add-ons step | Goes straight to Customer Details without changing the cart |

All business rules live in `store.ts`:
- `cancellationEligibility`
- `requestCancellation`
- `approveRefund`
- `rejectRefund`
- `adminCancel`
- `modificationEligibility`
- `modifyBooking`
- `logEvent`

They are covered by `tests/store.test.ts`.

## 3. Defects in the old static implementation, fixed during migration

1. **Modification regenerated every ticket ID.** Customers' existing QR codes silently stopped working, and scan history was lost.
   - Fix: existing tickets are kept per category. Only added tickets get new IDs; removed tickets are dropped.
   - Modification is refused once any ticket has been used.
2. **Modification dropped offer and coupon lines** and re-priced the booking at full price.
   - Fix: bookings with offers or coupons cannot be modified, because offer pricing is tied to the original date. The reason is shown to the admin.
3. **Modification accepted any date**, including closed and blackout dates.
   - Fix: the date must be open (`dateStatus`).
4. **Cancellation could be requested on unpaid (pending/failed) bookings.**
   - Fix: only paid bookings are eligible.
5. **The "Refunded" KPI counted pending and rejected requests as refunded money**, and the payments table labelled them "processed".
   - Fix: only approved refunds count, and each row shows its real state.
6. **A cancelled booking opened from history still said "Payment successful"**, and its tickets showed "Valid".
   - Fix: a cancelled header is shown and each ticket shows its true status.
7. **The capacity KPIs mixed sources.** "Admitted" counted scan events while "Remaining" counted ticket statuses, so the numbers did not add up.
   - Fix: all four figures come from the same tickets (admitted + remaining = expected).
   - Capacity now honours a per-date capacity set in Calendar Management before falling back to the default.
8. **Rejecting a refund used a fixed reason.**
   - Fix: the admin enters the reason.
9. **Notifications and the log grew without bound in `localStorage`.**
   - Fix: capped at 500 notifications and 2,000 log entries.

**Correction to the 22 Nov handover.** It stated that checkout randomly simulated declines and timeouts. Neither version ever did; checkout always succeeded. A visible **"Simulate a declined payment"** link has now been added. A declined attempt creates no booking and nothing is sent for commission; the attempt is written to the Activity Log.

## 4. Integration with the influencer module

| Booking event | Effect on attribution and commission |
|---|---|
| Online payment succeeds | `reportPaid` records every website booking with its region and source; a commission is created only if a live influencer attribution exists (influencer handover §0) |
| Payment declined | Nothing is sent |
| Admin "Cancel & refund" | Commission reversed |
| Customer requests cancellation | No change. The booking is still valid; the commission stays pending |
| Admin approves refund | Commission reversed |
| Admin rejects refund | No change |
| Admin modifies booking | The same commission is re-priced at its original rate (if pending); never duplicated |
| Counter sale | Never sent, even if the staff browser holds a referral session |

Events go through a retrying `localStorage` outbox (`src/referral.ts`).

## 5. How to run

```bash
npm install
npm run dev            # http://localhost:5173 (influencer screens need the backend running)
npm test               # booking business-rule tests (Node ≥ 22.18)
npm run typecheck
npm run build          # dist/ (served by the backend in production)
npm run build:static   # regenerates static-build/index.html
```

- Backend: see the influencer handover §10–11.
- Staff Scanner demo login: `STF1024` … `STF1052`, password `mgm123`. `STF1052` is inactive.

## 6. Known limitations (prototype)

- **Bookings, payments, staff and the activity log live in each browser's `localStorage`.** There is no server-side booking database and no real authentication; Admin and Counter Sale are open to anyone who opens the app.
- **Payments are simulated.** Browser-generated "paid" events are **not** a payment confirmation (influencer handover §12 lists what must change before Razorpay).
- **My Bookings looks up bookings by mobile number alone.** Production must verify ownership with a one-time code.
- **A pending cancellation request does not block gate entry.** This is deliberate: the ticket stays valid until approved.
- **Refunds are recorded only; no money moves.** The modification price difference is shown but not collected or refunded.
- **The cancellation fee is 10%.** The prototype's customer-facing text has always said 10%, but MGM's published FAQ says **25%**. Confirm with MGM before production.
- **No partial cancellations.** This matches the policy text.
- **The Activity Log is a demonstration record**, not a tamper-proof audit trail.
- **The single-file build works offline except for the influencer screens**, which need the backend; they show "Cannot reach the ticketing API".
