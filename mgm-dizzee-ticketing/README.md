# MGM Dizzee World – Ticketing Platform

One application with three front-ends and one server:

- **Customer booking.** Visit date → tickets and offers → add-ons → details → payment → QR e-tickets. Also My Bookings, private booking links and cancellation requests.
- **Admin console** (`/#admin`). Dashboard, calendar, tickets, offers, bookings, payments and refunds, customers, entry log, reports, staff accounts, counter sale, influencers and regions, notifications, activity log, settings.
- **Gate scanner** (`/#staff`). Staff sign-in, QR scan, valid, invalid or duplicate result.

The **server (`backend/`, FastAPI and PostgreSQL) is the source of truth.** It handles pricing, inventory, payments, tickets, gate validation, cancellations, refunds, modifications, staff authentication, and influencer and regional analytics. It is deployed as a single **Railway** service.

> Payments are currently a **simulated provider**: no money moves. Real payments require the separate, verified Razorpay milestone.

**Start here:** [HANDOVER.md](HANDOVER.md). It covers architecture, local setup, Railway deployment, environment variables, staff setup, workflows, backup and recovery, limitations, and the production checklist.

| | |
|---|---|
| Database & migrations | [docs/DATABASE.md](docs/DATABASE.md) |
| API reference | [docs/API.md](docs/API.md) |
| Test report | [docs/TEST-REPORT.md](docs/TEST-REPORT.md) |
| Influencer & regional module | [INFLUENCER-MODULE-HANDOVER.md](INFLUENCER-MODULE-HANDOVER.md) |

```bash
npm install && npm run build && npm test     # front-end build + tests
cd backend && python -m pytest               # backend tests (SQLite; set TEST_DATABASE_URL for PostgreSQL)
```
