// RentCast — STR Opportunity Finder client
// =============================================================================
// Powers the search side of the STR Opportunity Finder tab.
//
// Endpoints used:
//   GET /v1/listings/sale            → for-sale listings by city/state/zip/geo
//   GET /v1/markets                  → median rent per zip (baseline LTR rent)
//   GET /v1/avm/rent/long-term       → precise per-address rent AVM
//
// Pricing context (RentCast Pro tier, May 2026): 5,000 requests/mo.
// Per-search cost: 1 listings call + 1 market call + ~30 rent-AVM calls for
// top picks = ~32 requests. ≈156 fresh searches/month.
//
// Existing code uses RENTCAST_API_KEY via X-Api-Key header — same here.
// =============================================================================

const BASE = 'https://api.rentcast.io/v1';

async function rentcastFetch(path, params, key) {
  if (!key) throw new Error('RENTCAST_API_KEY is not configured');
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  const r = await fetch(u.toString(), { headers: { 'X-Api-Key': key, 'Accept': 'application/json' } });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`RentCast HTTP ${r.status} on ${path}: ${txt.slice(0, 220)}`);
  }
  return r.json();
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

// For-sale listings — primary "find candidate properties" endpoint.
// Accepts EITHER zip OR city+state OR lat/lng+radius.
//   { city, state, zipCode, lat, lng, radius, status, propertyType, bedrooms, bathrooms, limit, offset }
// Returns an array of listings (RentCast returns a bare array, not a wrapped object).
export async function listingsSale(opts, key) {
  const params = {
    status: opts.status || 'Active',
    limit: opts.limit || 500,
    offset: opts.offset || 0
  };
  if (opts.zipCode) params.zipCode = opts.zipCode;
  if (opts.city && opts.state) {
    params.city = opts.city;
    params.state = opts.state;
  }
  if (opts.lat != null && opts.lng != null) {
    params.latitude = opts.lat;
    params.longitude = opts.lng;
    params.radius = opts.radius || 25;
  }
  if (opts.propertyType) params.propertyType = opts.propertyType;
  if (opts.bedrooms != null) params.bedrooms = opts.bedrooms;
  if (opts.bathrooms != null) params.bathrooms = opts.bathrooms;
  const data = await rentcastFetch('/listings/sale', params, key);
  // RentCast returns a plain array; sometimes a wrapped { data: [...] }
  return Array.isArray(data) ? data : (data?.data || []);
}

// Market-level rent data (median rent per zip — used as baseline LTR rent
// when we haven't yet fetched a per-address rent AVM).
//   marketByZip(zipCode)
//   marketByCity(city, state)
export async function marketByZip(zipCode, key) {
  return rentcastFetch('/markets', { zipCode, dataType: 'All' }, key);
}
export async function marketByCity(city, state, key) {
  return rentcastFetch('/markets', { city, state, dataType: 'All' }, key);
}

// Per-address rent AVM. Bedrooms+bathrooms improve accuracy.
export async function rentAvm({ address, bedrooms, bathrooms, propertyType }, key) {
  const params = { address };
  if (bedrooms != null) params.bedrooms = bedrooms;
  if (bathrooms != null) params.bathrooms = bathrooms;
  if (propertyType) params.propertyType = propertyType;
  return rentcastFetch('/avm/rent/long-term', params, key);
}

// Convenience: derive a per-bedroom-count rent table from a market response.
// RentCast market data sometimes returns { rentalData: { dataByBedrooms: [...] } }
// or { rental: { medianRent } } — we normalize to:
//   { medianRent, byBedrooms: { 1: ..., 2: ..., ..., 5: ... } }
export function normalizeMarket(market) {
  if (!market) return null;
  const out = { medianRent: 0, byBedrooms: {} };
  const r = market.rentalData || market.rental || market.rentData || market;
  out.medianRent = Number(r.medianRent || r.median || r.averageRent || r.average) || 0;
  // Per-bedroom breakdown
  const list = r.dataByBedrooms || r.byBedrooms || r.bedroomBreakdown || [];
  for (const entry of (Array.isArray(list) ? list : [])) {
    const beds = entry.bedrooms ?? entry.beds;
    const rent = entry.medianRent ?? entry.median ?? entry.averageRent;
    if (beds != null && rent != null) out.byBedrooms[beds] = Number(rent) || 0;
  }
  return out;
}

// Heuristic: if we don't have a per-bedroom median, scale from overall median.
// Industry rule-of-thumb scaling per BR count (vs 2BR baseline of 1.0):
const BEDROOM_RENT_FACTORS = { 0: 0.60, 1: 0.75, 2: 1.00, 3: 1.25, 4: 1.50, 5: 1.75, 6: 2.00 };

export function rentForBedrooms(market, bedrooms) {
  if (!market) return 0;
  if (market.byBedrooms?.[bedrooms]) return market.byBedrooms[bedrooms];
  if (!market.medianRent) return 0;
  const factor = BEDROOM_RENT_FACTORS[Math.min(6, Math.max(0, Math.round(bedrooms || 2)))];
  return Math.round(market.medianRent * factor);
}
