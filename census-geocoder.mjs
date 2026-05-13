// Census Geocoder — address → county FIPS, state code
// =============================================================================
// Free, no-key Census Bureau geocoder. Returns the county name, FIPS code, and
// state code for any US address. Used by the Distressed tab to route scraping
// to the correct county-recorder handler.
//
// Usage:
//   const r = await lookupCounty('475 Front St, Lahaina, HI 96761');
//   // → { state: 'HI', stateFIPS: '15', county: 'Maui', countyFIPS: '009', lat, lng }
// =============================================================================

const FIPS_TO_STATE = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY'
};

const _cache = new Map();

export async function lookupCounty(address) {
  if (!address) return null;
  const key = address.toLowerCase().trim();
  if (_cache.has(key)) return _cache.get(key);

  // Use the Census Geocoder "onelineaddress" endpoint with the Census 2020 vintage benchmarks.
  const url = `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress`
            + `?address=${encodeURIComponent(address)}`
            + `&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json`;
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'RealEstateAnalyzer/1.0' } });
    if (!r.ok) return null;
    const data = await r.json();
    const match = data?.result?.addressMatches?.[0];
    if (!match) return null;
    const county = match.geographies?.['Counties']?.[0];
    if (!county) return null;
    const stateFIPS = String(county.STATE).padStart(2, '0');
    const result = {
      state: FIPS_TO_STATE[stateFIPS] || '',
      stateFIPS,
      county: (county.BASENAME || county.NAME || '').replace(/\s+county$/i, ''),
      countyFIPS: String(county.COUNTY).padStart(3, '0'),
      lat: Number(match.coordinates?.y) || 0,
      lng: Number(match.coordinates?.x) || 0,
      matchedAddress: match.matchedAddress || address
    };
    _cache.set(key, result);
    return result;
  } catch (err) {
    console.warn('[census-geocoder]', err.message);
    return null;
  }
}
