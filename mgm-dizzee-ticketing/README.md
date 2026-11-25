# MGM Dizzee World – Ticketing Platform (Prototype)

A clickable prototype with three apps in one:

- **Customer Booking** – landing page → visit date → tickets & offers → add-ons → details → payment (simulated) → QR e-tickets
- **Admin Dashboard** – dashboard, calendar, tickets, offers, bookings, payments, customers, entry, reports, staff, settings
- **Staff Scanner** – login, QR scan (camera where supported, otherwise simulated), valid / invalid / duplicate results

Use the black bar at the top of the page to switch between the three apps.
Direct links also work: `/#admin` and `/#staff`.

> All prices, offers, customers and bookings are **illustrative demo data**. No real payments are processed.
> Changes made in the prototype are saved in the visitor's own browser (localStorage). Admin → Settings → "Reset demo data" restores the original data.

> **Influencer & Regional Sales Intelligence** (Admin → Influencers & Regions) needs the FastAPI backend in `backend/` and is deployed on **Railway**, which supersedes the Vercel instructions below. See [INFLUENCER-MODULE-HANDOVER.md](INFLUENCER-MODULE-HANDOVER.md).

---

## Deploy to Vercel

### Option A – GitHub (recommended)

1. Create a new GitHub repository and upload all the files in this folder (keep the folder structure).
2. Go to **vercel.com → Add New → Project**, and import that repository.
3. Vercel detects **Vite** automatically. Leave the settings as they are:
   - Build command: `npm run build`
   - Output directory: `dist`
4. Click **Deploy**. You get a link like `https://mgm-dizzee-ticketing.vercel.app`.

Every time you push a change to GitHub, Vercel redeploys automatically.

### Option B – Vercel CLI (from your computer)

```bash
npm install -g vercel
cd mgm-dizzee-ticketing
vercel          # first time: answer the setup questions (defaults are fine)
vercel --prod   # publish to the live URL
```

### Option C – no build at all

The `static-build/` folder has the whole prototype already built into **one `index.html` file**.
Upload just that folder as a project in Vercel (Framework preset: "Other", no build command),
or drag it into any static host. Use this only if you don't want to build from source.

### Connect your own domain (optional)

Vercel → your project → **Settings → Domains** → add e.g. `book.mgmdizzeeworld.com`,
then add the DNS record Vercel shows you at your domain provider.
The main website's "Book Now" button can then simply link to that address.

---

## Run on your computer

Needs **Node.js 20.19 or newer**.

```bash
npm install
npm run dev       # opens at http://localhost:5173
npm run build     # production build into /dist
npm run preview   # preview the production build
```

## Project structure

```
index.html            page shell, fonts, favicon
vite.config.ts        Vite + React + Tailwind setup
vercel.json           Vercel build settings
src/
  main.tsx            app switcher (Customer / Admin / Staff)
  customer.tsx        customer booking site
  admin.tsx           admin dashboard (all modules)
  staff.tsx           staff QR scanner app
  store.ts            mock data, offer engine, pricing, scan validation
  ui.tsx              shared components, icons, dropdowns, date picker, motion helpers
  charts.tsx          lightweight SVG charts
  qr.ts               QR code generator (no external library)
  index.css           Tailwind v4 theme (MGM colours, fonts, animations)
  assets/             MGM logo and tiger mascot
public/favicon.png
static-build/         ready-made single-file build (Option C)
```

## Things to change before real use

- **Demo date:** `src/store.ts` → `TODAY` uses the real date during Nov–Dec 2026 and falls back to 19 Nov 2026 otherwise, so the demo always has dates on sale.
- **Real backend & payments:** this prototype has no server. A production version needs an API + database for bookings and offers, and the real Razorpay checkout.
- **Logo:** the logo file is small; replace `src/assets/logo.png` and `src/assets/mascot.png` with high-resolution versions from MGM for sharper display.
