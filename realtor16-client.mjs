// Realtor16 (Realtor.com) client via RapidAPI
// =============================================================================
// Better-quality listings than RentCast: photos, price-reduction tracking,
// list_date, exact lot_sqft, agent advertisers, full status (active /
// pending / sold). Coverage is also better in vacation markets where RentCast
// thins out (Lahaina, Oakhurst, Mariposa, etc.).
//
// Pricing: RapidAPI plans typically $0-$100/mo depending on call volume.
// Free tier (default) gives ~100 calls/mo.
//
// API docs:
//   https://rapidapi.com/s.mahmoud97/api/realtor16
// =============================================================================

const BASE = 'https://realtor16.p.rapidapi.com';

async function rt16Fetch(path, params, key) {
  if (!key) throw new Error('REALTOR16_RAPIDAPI_KEY not configured');
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  const r = await fetch(u.toString(), {
    headers: {
      'x-rapidapi-host': 'realtor16.p.rapidapi.com',
      'x-rapidapi-key': key,
      'Accept': 'application/json'
    }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Realtor16 HTTP ${r.status} on ${path}: ${txt.slice(0, 220)}`);
  }
  return r.json();
}

// Normalize a Realtor16 property into the shape downstream code expects
// (mirrors the RentCast /listings/sale field names so the rest of the
// pipeline doesn't care which source provided the listing).
export function normalizeRt16(p) {
  if (!p) return null;
  const loc = p.location?.address || {};
  const desc = p.description || {};
  const street = loc.line || '';
  const city = loc.city || '';
  const state = loc.state_code || loc.state || '';
  const zip = loc.postal_code || '';
  const formatted = [street, city, state].filter(Boolean).join(', ') + (zip ? ` ${zip}` : '');

  // baths_consolidated is a string like "2" or "2.5"; sometimes the only baths field
  const baths = parseFloat(desc.baths_consolidated || desc.baths || desc.baths_full || 0) || 0;
  const beds = Number(desc.beds || desc.beds_min || 0) || 0;
  const sqft = Number(desc.sqft || desc.living_area || 0) || 0;
  const lot = Number(desc.lot_sqft || 0) || 0;
  const yr = Number(desc.year_built || 0) || 0;
  const type = (desc.type || desc.sub_type || '').replace(/_/g, ' ');

  return {
    // Source / IDs
    id: p.property_id || p.listing_id,
    source: 'realtor16',

    // Address fields — same names as RentCast
    formattedAddress: formatted,
    address: formatted,
    streetAddress: street,
    city,
    state,
    zipCode: zip,
    latitude: Number(p.location?.address?.coordinate?.lat) || 0,
    longitude: Number(p.location?.address?.coordinate?.lon) || 0,

    // Property
    bedrooms: beds,
    bathrooms: baths,
    squareFootage: sqft,
    lotSize: lot,
    yearBuilt: yr,
    propertyType: type,

    // Listing
    price: Number(p.list_price || p.price || 0) || 0,
    listPrice: Number(p.list_price || 0) || 0,
    lastSalePrice: Number(p.last_sold_price || 0) || 0,
    lastSaleDate: p.last_sold_date || '',
    listingType: 'For Sale',
    status: p.status || '',
    daysOnMarket: 0,  // computed from list_date if needed
    listDate: p.list_date || '',

    // Extras only Realtor16 has — useful for richer display later
    photoUrl: p.primary_photo?.href || (p.photos?.[0]?.href) || '',
    permalink: p.permalink ? `https://www.realtor.com/realestateandhomes-detail/${p.permalink}` : '',
    priceReduced: Number(p.price_reduced_amount || 0) || 0
  };
}

// Search for-sale listings by location string ("San Mateo, CA" / "Oakhurst, CA" / "94401")
//   GET /search/forsale?location=...&limit=...&search_radius=...&sort=...
export async function forSaleByLocation({ location, limit = 50, sortBy, searchRadius = 0, page = 1 } = {}, key) {
  if (!location) throw new Error('location is required');
  const data = await rt16Fetch('/search/forsale', {
    location,
    limit: Math.min(limit, 200),
    page,
    search_radius: searchRadius,
    sort: sortBy
  }, key);
  const props = Array.isArray(data?.properties) ? data.properties : [];
  return {
    listings: props.map(normalizeRt16).filter(Boolean),
    total: Number(data?.total) || props.length,
    pageCount: Number(data?.count) || props.length
  };
}

// Search by lat/lng + radius (for "address + N miles" mode)
//   GET /search/forsale/coordinates?latitude=...&longitude=...&radius=...
export async function forSaleByCoords({ lat, lng, radius = 25, limit = 50, page = 1 } = {}, key) {
  if (lat == null || lng == null) throw new Error('lat/lng required');
  const data = await rt16Fetch('/search/forsale/coordinates', {
    latitude: lat,
    longitude: lng,
    radius,
    limit: Math.min(limit, 200),
    page
  }, key);
  const props = Array.isArray(data?.properties) ? data.properties : [];
  return {
    listings: props.map(normalizeRt16).filter(Boolean),
    total: Number(data?.total) || props.length
  };
}
