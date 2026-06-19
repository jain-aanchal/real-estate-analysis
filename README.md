# Investment Analyzer

Standalone web app for analyzing real-estate investments. Four tabs:

1. **🏖️ Short-Term Rental (STR)** — vacation-rental underwriting with Low/Mid/High scenarios, AirDNA Rentalizer PDF import, AirROI / AirDNA / Airbnb comp pulls, target offer-price at 11% cap rate
2. **🏢 Multi-Family Long-Term Rental (LTR)** — residential/commercial loan logic (>4 units → prime+2% commercial), rent comps, full-history sales pulls, county-recorder deep-links, NOI / CoC / DSCR / 5-yr ROI / target buy price at 15% cap
3. **🏚️ Distressed Properties** — searches off-market and distressed inventory (pre-foreclosure / auction / tax-delinquent) across all 50 US states, with map view, full Insights drawer (Sale Comp / Lease Data / Record), inline underwriting card with live-edit assumptions, Hawaii zoning lookup, optional PropertyRadar feed, Google Drive saved searches
4. **💎 STR Opportunity Finder** *(new)* — find properties in any US market that pencil as STRs at a target cap rate. Uses RentCast for active listings + LTR market rent, converts to STR revenue via market-type-aware multipliers (vacation 2.5× / metro 1.8× / college 1.5× / suburban 1.4×), and auto-fires AirDNA Rentalizer for top picks (≥ 12% cap) to flip confidence from ⚪ Estimated → 🟢 AirDNA-verified

## 💎 STR Opportunity Finder — Quick Guide

**Search:**
1. Type a city, zip, or address (autocomplete shows suggestions; picking one auto-fires the search)
2. For address searches, the radius dropdown lets you widen/narrow (5/10/25/50/100 miles)
3. Filter by property type, BR/BA, price, year built
4. Drag the **Target cap rate** slider (default 11%) — re-filtering is instant, no refetch needed

**Market detection:**
The tab auto-detects market type from the city name (e.g. Lahaina → vacation 🌴 · 2.5× multiplier · 60% occupancy). Auto-detected values appear in the chip at the top of the filter row. Override via the "STR multiplier" and "Occupancy" inputs.

**Confidence badges:**
- ⚪ Estimated — derived from RentCast Rent Zestimate × multiplier × occupancy
- ⏳ Refining — AirDNA Rentalizer call in flight
- 🟢 AirDNA-verified — STR revenue replaced by AirDNA's market-trained estimate (only fires for properties scoring ≥ 12% cap rate)

**Click a row** to open the Insights drawer:
- **Underwriting card** with live-editable assumptions (multiplier, occupancy, down %, rate, term, vacancy, maintenance %, PM %)
- **STR Analysis** sub-tab — Low/Mid/High scenarios (Low = ADR×0.8, Occ−10pts · Mid = exact · High = ADR×1.2, Occ+10pts)
- **Comparable Sales** sub-tab — recent sold properties in same zip
- **Property Detail** sub-tab — owner, last sale, tax record
- **"Run AirDNA Rentalizer"** button — manual trigger for properties below the 12% auto-threshold

**Saved searches:** click 💾 Save to persist filters to `localStorage` (also syncs to Google Drive `appDataFolder` if you're signed in via the existing Save-Analysis OAuth).

**CSV export:** all filtered results with full underwriting columns.

**Cost:** ~32 RentCast requests per fresh search (1 listings + 1 market + ≤30 AirDNA refinements). 24-hour per-address cache means repeat searches in the same market cost ~0 marginal requests. RentCast Pro tier (5k/mo) supports ~156 fresh searches/month.

### Backend endpoints used by this tab

| Endpoint | Purpose |
|---|---|
| `GET /api/str-opportunity/search` | Pulls RentCast listings + market rent, applies STR multiplier × occupancy, runs `computeUnderwriting`, filters by target cap, sorts desc |
| `POST /api/str-opportunity/property` | Full Insights payload: RentCast property record, nearby sold comps, Low/Mid/High scenarios |
| `POST /api/str-opportunity/refine` | Calls AirROI/AirDNA Rentalizer for up to 30 addresses (24hr per-address cache) |

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

## 🏚️ Distressed Properties Tab

The Distressed tab aggregates off-market and distressed-property inventory across all 50 US states from public records and free data sources, with an optional paid PropertyRadar upgrade.

### What it does

- **Search by city / state / zip / address** — returns up to 1,000 results per query
- **Filter by**: property type (multi/single-family, land, mixed-use), distress status (auction, NOD, tax-delinquent, on-market, off-market, in-contract), price range, unit count, BR/BA, year built
- **Map view** — Google Maps (when `GOOGLE_MAPS_API_KEY` is set) with OpenStreetMap/Leaflet auto-fallback otherwise. Pins colored by distress status.
- **Insights drawer** (click any row) — three sub-tabs:
  - **Sale Comp** — last sale, full price history
  - **Lease Data** — median market rent, last known tenant rent (Dwellsy)
  - **Record** — owner name, mortgage details, distress filings (NOD/auction/tax), tax info, **Hawaii zoning + STR-legality flag**
- **📊 Underwriting card** — top of every Insights panel. Computes cap rate, NOI, OpEx, CoC, DSCR, 5-yr ROI, and target buy price @ 11% cap using the same math as the LTR tab. Live-edit assumptions (down %, rate, term, vacancy, maint, capex, PM, rent/unit) in-place.
- **CSV export** of selected or all results
- **Save Search** to Google Drive (uses the same OAuth flow as the existing Save-Analysis modal). Falls back to localStorage if not signed in.

### Data sources

| Source | Cost | Coverage | Method |
|---|---|---|---|
| **RentCast** `/properties` | existing key | All 50 states | REST — baseline parcel/owner/sale/tax |
| **County recorder scrape** via NETR Online + 10 priority state handlers (CA, TX, FL, NY, IL, GA, OH, MI, AZ, HI) | $0 | National (varies) | Playwright |
| **Auction.com / Hubzu / Xome** scrape | $0 | National | Playwright |
| **Dwellsy** scrape (rental comps) | $0 | Major metros | Playwright |
| **Hawaii GIS** — Maui / Honolulu / Kauai / Hawaii counties | $0 | HI only | Cached lookup table + GIS deep-links |
| **U.S. Census Geocoder** — address → county FIPS | $0 | National | REST |
| **Google Maps JS API** (optional) | $0 within 28k loads/mo | Global | JS SDK |
| **PropertyRadar** (optional, paid) | $89/mo | National, daily updates | REST — env-gated by `PROPERTYRADAR_API_KEY` |

### Backend endpoints

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/distressed/search?location=...&cap=500&filters=...` | Aggregates from all sources, 1-hr cache |
| `POST` | `/api/distressed/property` | Full Insights record + underwriting precompute, 24-hr cache |
| `POST` | `/api/distress/scrape` | Direct county-recorder invocation |
| `POST` | `/api/auction/scrape` | Auction.com / Hubzu / Xome aggregator |
| `POST` | `/api/zoning/hawaii` | HI zoning lookup (zone code + STR legality) |
| `GET`  | `/api/maps/config` | Returns active map provider + key (server-proxied) |

### Optional .env keys

```
# Paid distress data — flip this on when you're ready to upgrade beyond free scraping
PROPERTYRADAR_API_KEY=...

# Google Maps (free tier 28k loads/mo). Omit to use OpenStreetMap fallback.
GOOGLE_MAPS_API_KEY=...
```

### v2 (not yet shipped)

- Skip-trace / owner contact (phone + email) with Gmail integration for one-click outreach
- Opportunity-zone filter and overlay
- Zoning lookup for non-Hawaii states
- "Send to STR / LTR" tabs (whole building → LTR · per unit → STR)

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
| `index.html` | Single-page app (HTML + CSS + JS inline) — STR, LTR, Distressed tabs |
| `server.mjs` | Express proxy with all backend API endpoints |
| `package.json` | `npm run dev` starts the local server |
| `STR Investment Analysis.xlsx` | Original Excel model with same calculations |
| `lib/financial-calc.mjs` | Shared underwriting math (cap, NOI, CoC, DSCR, ROI, target price) used by both LTR and Distressed tabs |
| `airdna-pdf-parser.mjs` | Parses AirDNA Rentalizer PDFs (handles K/M suffix, comp tables) |
| `listing-scraper.mjs` | Pulls price + BR/BA + HOA + tax from Redfin/Zillow/Realtor listing URLs |
| `redfin-scraper.mjs` | Redfin property data + full sales history (Playwright) |
| `zillow-scraper.mjs` | Zillow BR/BA + price history fallback |
| `scraper.mjs` | Airbnb listing scraper (legacy STR comps) |
| `census-geocoder.mjs` | Address → county FIPS via free Census Bureau API |
| `county-recorder-scraper.mjs` | Generic distress-filings handler with NETR Online fallback |
| `state-handlers/{ca,tx,fl,ny,il,ga,oh,mi,az,hi}-recorder.mjs` | Per-state recorder portals (10 priority metros) |
| `auction-scraper.mjs` | Auction.com / Hubzu / Xome aggregator |
| `dwellsy-scraper.mjs` | Long-term rental comps for LTR/Distressed |
| `zoning-hawaii.mjs` | HI zoning lookup (Maui / Honolulu / Kauai / Hawaii counties) with STR-legality flag |
| `propertyradar-client.mjs` | Optional paid distress-data feed (env-gated by `PROPERTYRADAR_API_KEY`) |
| `saved-search-drive.mjs` | Server stub for Google Drive saved-search sync (R/W happens client-side) |

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
