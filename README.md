# STR Investment Analyzer

Standalone web app for analyzing short-term rental (STR) property investments. Mirrors the logic in `STR Investment Analysis.xlsx` with live calculations and an offer-price optimizer.

## Features

- **Live calculations** — edit any input and all metrics update instantly
- **3 revenue scenarios** — Low / Mid / High ADR and occupancy
- **Cap Rate, CoC Return, GRM, Cash Flow** calculated per scenario
- **Target offer price optimizer** — solves for the max purchase price that delivers a 20%+ cap rate in both Mid and High scenarios
- **🔍 Live AirDNA comps** — fetch real comparable listings for any address via the AirDNA Enterprise API (requires your API key, see setup below)
- **🕷️ Airbnb scraper fallback** — if no AirDNA key, scrape Airbnb listings via Playwright headless browser (personal research only, may violate ToS)
- **🏘️ Comparable Properties** — build a comp set from multiple sources:
  - **Fetch from AirDNA** — pulls live comps (ADR, occupancy, revenue, BR/BA, reviews) via backend proxy
  - Editable table: ADR, Occupancy, BR, BA, Sleeps, Days Available, Reviews, Annual Revenue
  - **Generate Sample** — synthesizes realistic demo comps (no API needed)
  - **CSV Import** — drop a CSV from AirDNA/Rabbu exports; auto-maps common column names
  - **Auto-compute averages** + **Revenue Potential Panel** showing suggested ADR, est. occupancy, annual revenue
  - **Apply to Scenarios** button — maps comp average to Low (80%) / Mid (100%) / High (120%) ADR
  - Comps persist in `localStorage` and export to Excel
- **🏛️ Auto property tax** — parses US state from address and applies the 2026 effective tax rate (Tax Foundation/WalletHub)
- **🛏️ Auto BR/BA lookup** — on address entry, tries a fallback chain of free property data sources:
  1. **RentCast API** (recommended — free 50 req/month, needs `RENTCAST_API_KEY`)
  2. **Redfin** (free, no key, uses public autocomplete + `aboveTheFold` endpoints)
  3. **Zillow** (Playwright scrape — often blocked by captcha)
  4. Manual entry fallback
- **💾 Save as Excel** — export a formatted `.xlsx` report with two destinations:
  - **Save to Disk** — native "Save As" dialog (Chrome/Edge File System Access API) with a fallback to a standard download
  - **Save to Google Drive** — direct upload via OAuth + Drive API v3
- **Pre-filled with April 2026 market rates**:
  - Investment property mortgage rate: **7.25%** (Bankrate, TheMortgageReports)
  - Property tax: **1.1%** national avg effective rate (Tax Foundation)
  - Landlord insurance: **$200/mo** (Bankrate, NerdWallet)
  - Utilities (water $50, gas $35, electric $140, wifi+cable $100) (Move.org, ApartmentList)
  - Down payment: 20% (no PMI)

## Run Locally

```bash
npm install
npm run dev
```

Then open [http://localhost:3200](http://localhost:3200).

The `npm run dev` command starts a small Express server (`server.mjs`) that:
1. Serves the static `index.html`
2. Proxies AirDNA API calls (keeping your API key server-side)

You can still double-click `index.html` to run without the backend — only the **Fetch from AirDNA** button will be disabled in that mode.

## AirDNA Live Comps Setup

The app can fetch real comparable listings from AirDNA's Enterprise API. You need an active AirDNA Enterprise subscription with API access.

### Steps

1. **Copy the env template:**
   ```bash
   cp .env.example .env
   ```

2. **Add your AirDNA bearer token** to `.env`:
   ```
   AIRDNA_API_KEY=your-actual-bearer-token-here
   ```
   (Get this from your AirDNA account manager — contact api@airdna.co if you don't have it.)

3. **Start the server:**
   ```bash
   npm run dev
   ```

4. **Test connectivity:**
   ```bash
   curl http://localhost:3200/api/health
   # Should show: {"status":"ok","airdna_configured":true,...}
   ```

5. **In the app**: enter a property address, set bedrooms, click **🔍 Fetch from AirDNA**. Live comps populate the table. Click **Apply to Scenarios** to use the averages.

### Backend API endpoints

The local proxy server exposes these routes:

| Method | Route | Purpose |
|--------|-------|---------|
| `GET`  | `/api/health` | Health check + AirDNA key status |
| `POST` | `/api/airdna/estimate` | Call AirDNA Rentalizer for a property |
| `POST` | `/api/airdna/comps` | Fetch comparable listings (calls Rentalizer + `/listing/{id}/comps`) |

Request body for comps:
```json
{ "address": "123 Main St, Austin, TX 78701", "bedrooms": 3 }
```

### Security

- Your `AIRDNA_API_KEY` is **never** sent to the browser — it lives only in `.env` on your machine
- `.env` is gitignored
- The backend runs locally (`localhost:3200`) — not exposed to the internet

## Property BR/BA Auto-Lookup

When you enter an address, the app automatically fills the Bedrooms and Bathrooms fields by trying a fallback chain of free data sources:

### 1. RentCast API (recommended) ⭐

- **Free tier**: 50 requests/month, no credit card
- Signup: https://app.rentcast.io/app/api
- Returns: `bedrooms`, `bathrooms`, `squareFootage`, `yearBuilt`, `propertyType`, `lastSalePrice`
- **Most reliable** — real API, no scraping, no bot detection

**Setup:**
```bash
# Add to .env
RENTCAST_API_KEY=your-rentcast-key-here
```

Endpoint: `POST /api/rentcast/property` with `{ "address": "..." }`

### 2. Redfin (free, no key)

- Uses public endpoints: `location-autocomplete` → `aboveTheFold`
- No API key required
- Less aggressive bot detection than Zillow
- Returns BR/BA/sqft/yearBuilt

Endpoint: `POST /api/redfin/property` with `{ "address": "..." }`

> **Note**: Redfin may rate-limit by IP. If you see consistent failures, wait 10 minutes or switch to RentCast.

### 3. Zillow (Playwright scrape)

- Requires `npm run install-scraper`
- Frequently blocked by Perimeter-X captcha
- Last-resort fallback

Endpoint: `POST /api/zillow/property` with `{ "address": "..." }`

### Fallback chain behavior

The client calls `/api/health` to see which sources are available, then tries them **in order** until one returns BR/BA. The source name is shown in the badge next to each field (e.g. `RentCast: 3 BR`, `Redfin: 2 BA`). If all sources fail, you can enter BR/BA manually.

## Airbnb Scraper Fallback (no API key required)

If you don't have an AirDNA subscription, you can scrape Airbnb search results via a headless Chromium browser.

> ⚠️ **Warning**: Scraping Airbnb may violate their Terms of Service. Use for personal research / market analysis only. Use at your own risk. Airbnb may rate-limit or block your IP.

### Setup (one-time)

```bash
npm run install-scraper
```

This runs `npm install playwright && npx playwright install chromium` (downloads Chromium, ~200MB).

### Usage

1. Start the server: `npm run dev`
2. Open http://localhost:3200
3. Enter a property address
4. Click **🕷️ Scrape** in the Comps card (or use the fallback panel if AirDNA is not configured)
5. Confirm the ToS warning (first time only, per session)
6. Wait 30–60 seconds while Playwright launches Chromium, navigates to Airbnb, and extracts ~12 listings
7. Results populate the comps table with: **title, URL, ADR, BR, BA, guests, reviews**

### Limitations

Airbnb's public search pages expose ADR and property characteristics, but **not** occupancy or revenue. The scraper sets:
- `Occupancy` = 0 (fill manually if you have data)
- `Annual Revenue` = 0 (will auto-compute if you set occupancy)

For full revenue projections, AirDNA's API is required.

### CLI usage (standalone)

You can also run the scraper directly without the backend:

```bash
node scraper.mjs --address "Austin, TX" --count 12
# Outputs a JSON array of listings to stdout
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| `AIRDNA_API_KEY not set` | Check `.env` exists and has the key; restart `npm run dev` |
| `AirDNA API error (401)` | Invalid or expired bearer token |
| `RENTCAST_API_KEY not set` | Sign up at https://app.rentcast.io/app/api, add `RENTCAST_API_KEY=...` to `.env`, restart |
| `RentCast error (429)` | Free tier exhausted (50/month) — wait or upgrade |
| `Redfin HTTP 429 / rate limited` | Redfin is throttling your IP. Wait 10 min or use RentCast |
| `All sources failed` | Check `/api/health` in the browser; enter BR/BA manually |
| `AirDNA API error (403)` | Your subscription doesn't include the Rentalizer or Comps endpoint |
| `returned no comps` | Address may be outside AirDNA coverage; try a more populated area |
| Response schema mismatch | AirDNA's exact field names vary by plan. Check browser console — the raw response is logged. Edit the `normalizeComps()` function in `server.mjs` to match your plan's field names |
| `Playwright not installed` | Run `npm run install-scraper` (one-time, ~200MB Chromium download) |
| Scraper returns 0 listings | Airbnb selectors may have changed. Check `stderr` logs — edit `scraper.mjs` selectors (`[data-testid="card-container"]`) |
| Scrape takes >60s / times out | Slow network or Airbnb rate-limiting. Retry or try a smaller `count`. The server has a 90s timeout guard |


## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-page app (HTML + CSS + JS inline) |
| `package.json` | `npm run dev` serves via `npx serve` |
| `STR Investment Analysis.xlsx` | Original Excel model with same calculations |

## Saving Analyses

Click **💾 Save Analysis** in the header to open the save modal:

### Save to Disk
- Works out of the box. No setup required.
- On **Chrome/Edge**: shows a native "Save As" dialog letting you pick the exact folder.
- On **Firefox/Safari**: falls back to a standard download (goes to your Downloads folder).

### Save to Google Drive
Requires a one-time OAuth setup:

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create a project (or pick an existing one)
3. Enable the **Google Drive API** in "Enabled APIs & services"
4. Click **Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins: add `http://localhost:3200` (and any other origin you serve from)
5. Copy the **Client ID**
6. In the save modal, expand **⚙️ Google Drive Settings** and paste the Client ID (stored in `localStorage`)
7. Click **Save Client ID** — now "Save to Google Drive" will work

The OAuth scope used is `drive.file` (the app can only access files it creates — it cannot read your other Drive files).

## How the Offer Price Optimizer Works

Cap Rate formula:
```
Cap Rate = (Annual Revenue × (1 − variable fees) − Fixed OpEx × 12 − Price × tax rate) / Price
```

Solving for Price when `Cap Rate = 20%`:
```
Price = (Annual Revenue × (1 − vfee) − Fixed OpEx × 12) / (0.20 + tax rate)
```

The app computes this for both Mid and High scenarios and suggests the **lower of the two** as the safe offer, ensuring both scenarios clear the 20% threshold.

## Data Sources

- [Bankrate — Investment Property Rates](https://www.bankrate.com/mortgages/investment-property-rates/)
- [TheMortgageReports — Investment Property Mortgage Rates Apr 2026](https://themortgagereports.com/27698/investment-property-mortgage-rates-how-much-more-will-you-pay)
- [Tax Foundation — Property Taxes by State 2026](https://taxfoundation.org/data/all/state/property-taxes-by-state-county/)
- [Bankrate — Homeowners Insurance Cost Apr 2026](https://www.bankrate.com/insurance/homeowners-insurance/homeowners-insurance-cost/)
- [Move.org — Average Utility Costs 2026](https://www.move.org/utility-bills-101/)
- [ApartmentList — Apartment Utilities 2026](https://www.apartmentlist.com/renter-life/estimating-apartment-utilities-cost)
>>>>>>> 297931b (Initial commit)
=======

>>>>>>> 957c3459a55706ef8540f1ed9c4f5998e3f7a903
