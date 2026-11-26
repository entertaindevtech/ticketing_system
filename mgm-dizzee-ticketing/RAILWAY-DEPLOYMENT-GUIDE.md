# Railway staging deployment guide

Use this guide for a **staging** environment of the MGM ticketing system on branch `feat/centralized-booking-engine` (commit `6782072` or later). Follow the steps in order. No code changes are needed.

> Staging uses the **simulated payment provider**: no real money moves. Do not enter real customer data until MGM agrees it is staging-safe.

---

## 1. Before you start

- You need a Railway account with access to the GitHub repository `entertaindevtech/ticketing_system`.
- You need a password manager entry ready for two secrets: `APP_SECRET` and the first admin password.
- Generate `APP_SECRET` now, on any computer with Python:
  ```
  python -c "import secrets; print(secrets.token_urlsafe(36))"
  ```
  This prints 48 random characters. Save them in the password manager. **Never reuse this value anywhere else, and never change it after launch:** changing it invalidates every ticket QR code and booking link already issued.

## 2. Create the project and database

1. In Railway, choose **New Project → Deploy from GitHub repo → `entertaindevtech/ticketing_system`**.
2. Open the new service's **Settings**:
   - **Source → Branch:** `feat/centralized-booking-engine`
   - **Source → Root Directory:** `mgm-dizzee-ticketing`. This is required: the application lives in this sub-folder of the repository.
   - **Build:** Railway reads `railway.json` and builds with the `Dockerfile`. Leave the builder as it is.
   - **Deploy → Start command:** leave it **empty**. The Dockerfile already runs the migrations and then starts the server.
3. In the same project, choose **New → Database → PostgreSQL**. Railway creates a service named `Postgres`.

## 3. Set the environment variables

Open the app service, then **Variables**, and add these:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (type exactly this; Railway fills in the real address) |
| `APP_ENV` | `staging` |
| `APP_SECRET` | the 48-character value from step 1 |
| `PUBLIC_APP_URL` | `https://<your-domain>`, filled in at step 4 |
| `SIMULATED_PAYMENTS` | `1` |
| `TRUSTED_PROXY_HOPS` | `1` (visitor IP read from Railway's `X-Real-IP`; `0` would make every region Unknown) |

**Do not set:**
- `PORT` (Railway sets it);
- `ADMIN_API_TOKEN`;
- `DEMO_TODAY`;
- `FRONTEND_DIST` and `GEOIP_DB_PATH` (the Dockerfile sets both);
- `CORS_ORIGINS`.

**Optional: visitor regions.** Without these, every region shows "Unknown"; everything else works.
- Add a **Volume** to the app service, mounted at `/data`.
- Set `MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` (free MaxMind GeoLite account).

## 4. Public domain

1. In the app service, go to **Settings → Networking → Generate Domain**. You get, for example, `mgm-ticketing-staging.up.railway.app`.
2. Set `PUBLIC_APP_URL` to `https://` followed by that domain. It must start with `https://`, with no trailing slash.

## 5. Deploy

1. Click **Deploy**, or push to the branch.
2. The build installs and builds the website, then the Python server, which takes a few minutes.
3. In **Deploy Logs** you should see:
   ```
   Running upgrade  -> 0001 ...
   ...
   Running upgrade 0006 -> 0007, staff accounts and server-side sessions
   Uvicorn running on http://0.0.0.0:<port>
   ```
4. Open `https://<your-domain>/api/health`. It should return `{"status":"ok", ...}`. `geoip_available` is `false` unless you did the optional MaxMind step.
5. Open `https://<your-domain>/`. The customer booking site should load.

If the logs show **`Refusing to start with APP_ENV=staging: ...`**, the message names the variable to fix. The usual causes are:
- `APP_SECRET` is missing or shorter than 32 characters;
- `PUBLIC_APP_URL` is not `https://...`;
- `DATABASE_URL` is not set to `${{Postgres.DATABASE_URL}}`.

Fix the variable; Railway redeploys automatically.

## 6. Create the first administrator

You run this once, inside the running service, with the Railway CLI:

1. Install the CLI from https://docs.railway.com/guides/cli, then run `railway login`.
2. In any folder, run `railway link` and choose this project, environment and **app service** (not Postgres).
3. Run `railway ssh` to open a shell inside the running container (already in `/app/backend`).
4. Run:
   ```
   python -m app.cli create-user ADM001 "Your Name" --roles admin
   ```
   Type a password of at least 10 characters twice; nothing appears while you type. It prints `Created ADM001 (admin)`.
5. Sign in at `https://<your-domain>/#admin` with `ADM001` and that password.

Create everyone else in the browser: **Admin › Staff Management › Add staff**. Give each person a Staff ID, name, gate, role(s) and an initial password of at least 10 characters.

| Role | For |
|---|---|
| `admin` | everything |
| `finance` | bookings, payments and refunds, reports |
| `counter` | walk-in sales |
| `gate` | the scanner at `/#staff` |
| `marketing` | Regional Sales Analytics, Influencer Management |

Do **not** use `railway run ...` for these commands: it runs on your own computer, not in Railway.

## 7. Demonstration data (optional, staging only)

Still inside `railway ssh`, run:
```
python -m app.cli seed-demo
```

- It creates six demo staff accounts (`ADM001`, `FIN001`, `CNT001`, `MKT001`, `STF1024`, `STF1031`) and prints each password **once**. Copy them into the password manager immediately.
- An account that already exists (for example, the `ADM001` you created in step 6) is left unchanged and keeps its password.
- It also creates about 40 sample bookings for the next 14 days, made through the real booking engine (some web, some counter).
- Running it a second time does not add more bookings.
- Only use this on a staging database that will never hold real customers. It is refused when `APP_ENV=production`.

The catalog (tickets, prices, offers, calendar) is created automatically by the migrations. Review it under **Admin › Ticket Management / Offer Management / Calendar Management / Settings**.

## 8. Quick smoke test (5 minutes)

1. **Customer.** At `https://<your-domain>/`: **Book now**, pick today, add 2 General Adult, **Skip Add-ons**, enter a test name, phone `9876500011` and an email, **Continue to Payment**, enter UPI `test@okicici`, then **Pay**. You should see "Payment successful" with 2 QR tickets and a booking ID `MGM-…`.
2. **Gate.** At `/#staff`, sign in as a gate account. Type the first ticket's ID (`TKT-…`) in "Ticket ID or QR text" and click **Check**: you should see **VALID TICKET**. Check the same ID again: **THIS TICKET HAS ALREADY BEEN USED.**
3. **Admin.** At `/#admin`, sign in as `ADM001`:
   - the Dashboard shows the booking, and "Admitted today" shows 1;
   - **Booking Management** lists the booking;
   - **Counter Sale** completes a walk-in sale.
4. **Regional Sales Analytics** shows the website bookings, with counter sales as the "Counter (walk-in)" channel.

## 9. Known staging limitations

- Payments are simulated: no money moves, and refunds are recorded only.
- Customers open bookings with the private link shown after payment ("Copy my booking link"). There is no email, SMS or phone lookup.
- The scanner uses the camera only on browsers that support it. Otherwise, type the ticket ID or paste the QR text.
- The cancellation fee is a provisional 25%, until MGM confirms it.
- Back up before sharing the URL widely: **Postgres service → Backups**.

Full details: `HANDOVER.md` (§4 deployment, §5 variables, §10–11 limitations and production checklist).
