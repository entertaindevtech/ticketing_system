# MGM Dizzee World Ticketing Prototype — Handover (for Mohan)

Date: 22 Nov 2026. Prepared for an upcoming management demonstration.

## 1. What this is

A conceptual demonstration prototype for MGM Dizzee World's proposed ticketing platform. It is **not** connected to any backend, payment gateway, or messaging service. All data lives in the browser (`localStorage`) and every transaction is simulated. Its purpose is to show the breadth of the proposed system — customer booking, counter sales, gate validation, and a full admin console — as one coherent, clickable experience.

## 2. Exact location of the final prototype

```
mgm-dizzee-ticketing/mgm-dizzee-ticketing/static-build/index.html
```

This is a **single, self-contained HTML file**. It has no dependency on Node, npm, or a build step.

Backups taken during development (do not demo from these):
- `static-build/index.backup-before-counter-sale.html` — before the Counter Sale module was added.
- `static-build/index.backup-before-feature-pass-2.html` — before this final feature pass (cancellation/refund/modification/entitlements/dashboard/history/notifications/audit).

## 3. How to open and demonstrate it

Double-click `static-build/index.html`, or open it with your browser's File → Open. It works offline. A top bar lets you switch between **Customer Booking**, **Admin Dashboard**, and **Staff Scanner** — these are three views of the same running application, sharing the same data.

## 4. Existing modules (already in the prototype before this pass)

- **Customer booking**: date selection → tickets/offers → add-ons → details → simulated payment → confirmation with real QR codes.
- **Staff Scanner** (gate): staff login, QR/manual ticket validation, duplicate/invalid detection.
- **Admin console**: Dashboard, Calendar, Tickets, Offers, Bookings, Payments, Customers, Entry, Reports, Staff, Settings. No login screen existed on Admin or Staff before — demo credentials only (below).
- **Counter Sale** (added in the previous pass): a walk-in sale screen inside Admin, reusing the customer booking screens with a Cash/UPI/Card simulated checkout and a printable receipt.

## 5. Newly implemented modules (this pass)

| Feature | Where to find it |
|---|---|
| **A. Customer cancellation request** | Open any confirmed customer booking's confirmation screen ("My Bookings" on the customer home screen finds past bookings by phone number) → "Cancellation & refund" card → "Request cancellation" |
| **B. Admin refund approval** | Admin → **Payments** tab → "Pending refund requests" table → Approve / Reject |
| **C. Booking modification** | Admin → **Bookings** → open a booking → "Modify booking" (change visit date, ticket quantities, add-ons; total recalculates live) |
| **D. Ticket entitlement configuration** | Admin → **Tickets** → Edit a category → new fields: Validity period, Same-day re-entry allowed, Restrictions/conditions |
| **E. Park operations / capacity** | Admin → **Dashboard** → new row: Admitted today, Expected today, Remaining to enter, Park capacity (demo value) |
| **F. Customer booking history** | Customer home screen → floating "My Bookings" button (bottom-right) → search by the phone number used at booking |
| **G. Notification centre** | Admin → **Notifications** (new tab, under "Oversight") |
| **H. Activity/audit log** | Admin → **Activity Log** (new tab, under "Oversight") — combines admin actions and gate scans |

## 6. Recommended demonstration sequence

1. **Book as a customer** (Customer Booking tab): pick a date, add tickets, pay (try it a couple of times to show the simulated success/decline/timeout states).
2. On the confirmation screen, show the QR tickets, then **request a cancellation** on that booking — point out the 10%-fee calculation and the "pending" status.
3. Switch to **Admin → Payments**: approve that refund request. Point out the status change.
4. **Admin → Bookings**: open a different booking and **modify it** (change the date or add a ticket) — show the recalculated total.
5. **Admin → Tickets**: edit a category and show the new validity/re-entry/restriction fields.
6. **Admin → Dashboard**: show the new admitted/remaining/capacity row.
7. **Admin → Notifications** and **Activity Log**: show that every action just performed left a trace.
8. **Counter Sale**: make a walk-in sale, then show it appears in Admin → Bookings immediately.
9. **Staff Scanner**: log in, scan one of today's tickets, then scan it again to show the duplicate-detection message.
10. Use **Admin → Settings → (reset control, see §11)** if you need to start the demo fresh.

## 7. Demo credentials (already present in the prototype — none invented)

Staff Scanner login (shared demo password for every account): **`mgm123`**
- STF1024 — Arun Kumar — Main Gate A (active)
- STF1031 — Priya Lakshmi — Main Gate B (active)
- STF1045 — Mohammed Riyaz — Water Park Gate (active)
- STF1052 — Deepa S — Fast Track Lane (**inactive** — useful for showing a login rejection)

Admin and Counter Sale have **no login** — anyone opening the file reaches them directly. This was already true before this pass and was not changed.

## 8. What is simulated vs. not connected to anything real

Everything involving money, messaging, or authentication is simulated:
- **Payments** (customer checkout and Counter Sale): random success/decline/timeout, no real gateway call.
- **Refunds**: approving a refund only changes a status field; no money moves.
- **Notifications**: the Notifications tab is populated by in-app events only — no real email/SMS/WhatsApp is sent.
- **Staff/Admin login**: demo-only; there is no real authentication or access control. Any browser can reach any screen.
- **QR codes**: genuinely generated and scannable (a real QR encoder), but the signature is a short, non-cryptographic hash, not production-grade security.
- **Ticket printing** (Counter Sale): opens the browser's print dialog, not a real thermal printer.

## 9. Known limitations, inconsistencies, and issues

- **Policy conflict, deliberately preserved**: the prototype's own customer-facing text has always said *"cancelled up to 48 hours before the visit (10% fee)"* — this is what the new cancellation feature uses. MGM's **published** FAQ (checked separately during earlier research) states a **25% penalty**, not 10%. I did not change the prototype's number, per instruction to preserve the existing customer-facing policy rather than silently invent or correct it — **this discrepancy must be resolved with MGM before any production build.**
- **A pending cancellation does not block gate entry.** The gate scanner only refuses a ticket when the booking's status is literally `"cancelled"`; a booking with a cancellation merely *requested* (not yet approved) can still be scanned and admitted. This was a deliberate choice to avoid risking the existing scan-validation logic under time pressure — flagged here rather than silently left as a surprise.
- **Booking modification regenerates ticket IDs.** If a ticket had already been scanned at the gate, modifying that booking's quantities discards that scan history (the new tickets start "valid," unscanned). Acceptable for a demo; not acceptable for production without a real modification/versioning model.
- **The existing one-click "Cancel & refund" admin action (added before this pass) still exists on every booking** alongside the new request → approve/reject workflow. They are separate, non-conflicting paths — the old one instantly cancels and refunds (90%); the new one is the proper request/approval flow this pass added. Both are visible in the Bookings detail view.
- **"My Bookings" identifies customers by phone number only** (no login exists anywhere in the app) — anyone who knows a phone number used in a booking can view it. Fine for a demo; not acceptable for production.
- **Counter Sale was deliberately left untouched** this pass, with one exception: its existing "booking created" step now also writes one line to the new Activity Log/Notifications, so it shows up consistently alongside the other new features. No other change was made to it.
- **Park capacity is a configured demo number** (the existing `defaultCapacity` setting, 4,000), not a live measured capacity.

## 10. Testing performed and outstanding manual checks

**Automated / static checks actually performed:**
- The embedded JavaScript was extracted and run through `node --check` after every edit in this pass — confirmed syntactically valid, with zero errors, at the end of the pass.
- Every new function/variable reference was individually located and confirmed as a genuine existing declaration in the bundle before being used (not guessed).
- File-size and marker counts were checked after each change to confirm no accidental duplication.

**I have not been able to open the file in a real browser from this session** (no working browser automation was available here), so the following still need a human to verify before the demo:
- [ ] The file opens without a blank screen or console error.
- [ ] Customer booking → payment → confirmation still works exactly as before.
- [ ] QR codes on the confirmation screen are visible and scannable.
- [ ] Staff Scanner login and ticket validation (valid/duplicate/invalid) still work.
- [ ] Counter Sale still works end-to-end and the resulting booking shows up in Admin → Bookings.
- [ ] **New**: request a cancellation as a customer, then approve it in Admin → Payments, and confirm the status updates on both sides.
- [ ] **New**: reject a refund request and confirm the rejection reason displays.
- [ ] **New**: modify a booking in Admin → Bookings and confirm the new total and tickets are correct.
- [ ] **New**: edit a ticket category's new entitlement fields and confirm they save.
- [ ] **New**: confirm the Dashboard's new row shows sensible numbers.
- [ ] **New**: confirm Notifications and Activity Log populate after the actions above.
- [ ] **New**: use "My Bookings" on the customer home screen to find a booking by phone number.
- [ ] Close and reopen the browser (or refresh) and confirm everything persisted via `localStorage`.

**Please do not present this to management until the checklist above has been run at least once.**

## 11. Resetting demo data

The existing reset mechanism is unchanged. If a reset control is not visible on screen, the fastest way to reseed fresh demo data is to open the browser's developer tools on this page, run:
```js
localStorage.removeItem("mgm-dizzee-proto-v3"); location.reload();
```
This clears all bookings, cancellations, refunds, notifications and activity log entries made during a demo run and reseeds the original mock dataset.
