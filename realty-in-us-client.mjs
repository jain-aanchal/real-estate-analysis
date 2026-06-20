// Realty-in-US (Realtor.com) client via RapidAPI
// =============================================================================
// Wraps the Realty-in-US API by apidojo on RapidAPI. Same Realtor.com data
// backend as Realtor16 but a different wrapper — used as a middle-tier
// fallback when Realtor16's monthly quota is exhausted.
//
// Endpoint: POST /properties/v3/list
// Pricing:  RapidAPI plans typically $0-$50/mo. Same key works.
// Docs:     https://rapidapi.com/apidojo/api/realty-in-us
//
// Bonus over Realtor16: server-side `keywords` filter supports specific
// view tags (water_view, ocean_view, hill_or_mountain_view, city_view,
// lake_view, river_view, waterfront, etc.) for richer filtering when
// the user has scenic-view pills checked.
// =============================================================================

const BASE = 'https://realty-in-us.p.rapidapi.com';

async function realtyFetch(path, body, key) {
  if (!key) throw new Error('REALTY_IN_US_RAPIDAPI_KEY (or REALTOR16_RAPIDAPI_KEY) not configured');
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': 'realty-in-us.p.rapidapi.com',
      'x-rapidapi-key': key,
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Realty-in-US HTTP ${r.status} on ${path}: ${txt.slice(0, 240)}`);
  }
  return r.json();
}

// Normalize a Realty-in-US property to the same shape as Realtor16's
// normalizeRt16 output (which the rest of the pipeline already understands).
export function normalizeRiu(p) {
  if (!p) return null;
  const loc = p.location?.address || {};
  const desc = p.description || {};
  const street = loc.line || `${loc.street_number || ''} ${loc.street_name || ''}`.trim();
  const city = loc.city || '';
  const state = loc.state_code || loc.state || '';
  const zip = loc.postal_code || '';
  const formatted = [street, city, state].filter(Boolean).join(', ') + (zip ? ` ${zip}` : '');

  const beds = Number(desc.beds || desc.beds_min || 0) || 0;
  const baths = parseFloat(desc.baths || desc.baths_consolidated || desc.baths_full || 0) || 0;
  const sqft = Number(desc.sqft || desc.living_area || 0) || 0;
  const lot = Number(desc.lot_sqft || 0) || 0;
  const yr = Number(desc.year_built || 0) || 0;
  const type = (desc.sub_type || desc.type || '').replace(/_/g, ' ');

  // Rich free-text fields for keyword + view filtering (mirrors Realtor16)
  const descText = String(
    desc.text || desc.description || desc.public_remarks || desc.marketing_remarks ||
    p.public_remarks || p.marketing_remarks || ''
  );
  const tags = Array.isArray(p.tags) ? p.tags.join(' ') : '';
  const community = p.community?.description || p.community?.name || '';
  const searchable = `${street} ${city} ${state} ${zip} ${type} ${descText} ${tags} ${community}`
    .toLowerCase().replace(/\s+/g, ' ').trim();

  // href IS the full Realtor.com URL in Realty-in-US responses (unlike
  // Realtor16 which returns a slug we have to construct).
  const permalink = p.href || (p.permalink ? `https://www.realtor.com/realestateandhomes-detail/${p.permalink}` : '');

  return {
    id: p.property_id || p.listing_id,
    source: 'realty-in-us',
    description: descText,
    tags,
    community,
    searchable,
    formattedAddress: formatted,
    address: formatted,
    streetAddress: street,
    city, state, zipCode: zip,
    latitude: Number(loc.coordinate?.lat) || 0,
    longitude: Number(loc.coordinate?.lon) || 0,
    bedrooms: beds,
    bathrooms: baths,
    squareFootage: sqft,
    lotSize: lot,
    yearBuilt: yr,
    propertyType: type,
    price: Number(p.list_price || p.price || 0) || 0,
    listPrice: Number(p.list_price || 0) || 0,
    lastSalePrice: Number(p.last_sold_price || 0) || 0,
    lastSaleDate: p.last_sold_date || '',
    listingType: 'For Sale',
    status: p.status || '',
    daysOnMarket: 0,
    listDate: p.list_date || '',
    photoUrl: p.primary_photo?.href || '',
    permalink,
    priceReduced: Number(p.price_reduced_amount || 0) || 0
  };
}

// Map our scenic-view pills → Realty-in-US's built-in keyword tags.
//
// IMPORTANT: Realty-in-US treats the `keywords` array as AND, not OR. Sending
// 5 water-related keywords would only return properties tagged with ALL 5
// (essentially zero). So we map each view to its single most-representative
// keyword. Users wanting more specific tags (e.g. only ocean_view) should
// use the client-side keyword filter to refine after the search.
//
// Full Realtor.com keyword list:
//   water_view, waterfront, ocean_view, lake_view, river_view, city_view,
//   hill_or_mountain_view, golf_course_view, community_park,
//   golf_course_lot_or_frontage, ...
export const VIEW_TO_RIU_KEYWORD = {
  water:    'water_view',           // broadest — also covers ocean/lake/river in many listings
  city:    'city_view',
  mountain: 'hill_or_mountain_view',
  park:    'community_park'
};

// Build a flat list of Realty-in-US keywords from the user's view selection.
// One keyword per checked view (because of AND semantics).
export function viewsToRiuKeywords(views = []) {
  if (!views.length) return null;
  const out = [];
  for (const v of views) {
    const k = VIEW_TO_RIU_KEYWORD[v];
    if (k) out.push(k);
  }
  return out.length ? out : null;
}

// Search for-sale listings.
// Accepts: { city, state, zipCode, searchAddress, lat, lng, radius, limit, views, keywords }
//
// Location precedence:
//   zipCode → postal_code filter
//   city + state → city + state_code filter
//   searchAddress → search_location with a real address string (Realtor.com
//                    geocodes it server-side; lat,lng coordinates DON'T work)
export async function forSale({
  city, state, zipCode,
  searchAddress,  // e.g. "475 Front St, Lahaina, HI" — Realty-in-US geocodes it
  lat, lng, radius = 25,
  limit = 200, offset = 0,
  views,
  keywords,
  sortField = 'list_date',
  sortDir = 'desc'
} = {}, key) {
  const body = {
    limit: Math.min(limit, 200),
    offset,
    status: ['for_sale', 'ready_to_build'],
    sort: { direction: sortDir, field: sortField }
  };

  if (zipCode) body.postal_code = String(zipCode);
  else if (city && state) {
    body.city = city;
    body.state_code = state.toUpperCase();
  } else if (searchAddress) {
    body.search_location = { radius, location: searchAddress };
  } else if (lat != null && lng != null) {
    // Coordinates as a fallback only — Realty-in-US does not consistently
    // geocode these. Prefer searchAddress when available.
    body.search_location = { radius, location: `${lat},${lng}` };
  }

  // Compose keyword filter
  const kw = keywords || (views ? viewsToRiuKeywords(views) : null);
  if (kw && kw.length) body.keywords = kw;

  const data = await realtyFetch('/properties/v3/list', body, key);
  const results = data?.data?.home_search?.results
              || data?.properties
              || [];
  const total = Number(data?.data?.home_search?.total || data?.total || results.length);
  return {
    listings: results.map(normalizeRiu).filter(Boolean),
    total,
    pageCount: results.length
  };
}
