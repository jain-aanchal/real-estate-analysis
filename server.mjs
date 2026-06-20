// STR Investment Analyzer — AirDNA Proxy Server
// Serves static index.html and proxies AirDNA Enterprise API calls,
// keeping the API key server-side.

// ----------------------------------------------------------------------------
// Silence pdfjs-dist polyfill warnings BEFORE any module imports it.
// The legacy build emits these at module init by writing directly to stderr
// AND via console.{log,warn,error}. We never render PDFs (text-only extraction),
// so the polyfill noise is irrelevant. Install filters globally.
// ----------------------------------------------------------------------------
const _PDF_NOISE = /Cannot polyfill (?:`DOMMatrix`|`Path2D`)|Indexing all PDF objects/;
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function (chunk, ...rest) {
  if (_PDF_NOISE.test(String(chunk || ''))) return true;
  return _origStderrWrite(chunk, ...rest);
};
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...rest) {
  if (_PDF_NOISE.test(String(chunk || ''))) return true;
  return _origStdoutWrite(chunk, ...rest);
};
for (const m of ['log', 'warn', 'error', 'info']) {
  const orig = console[m].bind(console);
  console[m] = (...args) => {
    if (args.length && _PDF_NOISE.test(String(args[0] || ''))) return;
    orig(...args);
  };
}

import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load .env ---
if (existsSync(join(__dirname, '.env'))) {
  const envFile = readFileSync(join(__dirname, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
}

const PORT = parseInt(process.env.PORT) || 3200;
const AIRDNA_API_KEY = process.env.AIRDNA_API_KEY;
const AIRDNA_BASE = process.env.AIRDNA_BASE || 'https://api.airdna.co/api/enterprise/v2';
const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const RENTCAST_BASE = 'https://api.rentcast.io/v1';
const AIRROI_API_KEY = process.env.AIRROI_API_KEY;
const AIRROI_BASE = 'https://api.airroi.com';
const REALTOR16_RAPIDAPI_KEY = process.env.REALTOR16_RAPIDAPI_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PROPERTYRADAR_API_KEY = process.env.PROPERTYRADAR_API_KEY;
const PROPERTYRADAR_BASE = 'https://api.propertyradar.com/v1';

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Health check ---
app.get('/api/health', (req, res) => {
  const playwrightInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  res.json({
    status: 'ok',
    airdna_configured: !!AIRDNA_API_KEY,
    rentcast_configured: !!RENTCAST_API_KEY,
    airroi_configured: !!AIRROI_API_KEY,
    google_maps_configured: !!GOOGLE_MAPS_API_KEY,
    propertyradar_configured: !!PROPERTYRADAR_API_KEY,
    realtor16_configured: !!REALTOR16_RAPIDAPI_KEY,
    redfin_available: true,
    scraper_installed: playwrightInstalled,
    zillow_available: playwrightInstalled,
    base: AIRDNA_BASE
  });
});

// --- Maps config (which provider + key for the client to use) ---
app.get('/api/maps/config', (req, res) => {
  if (GOOGLE_MAPS_API_KEY) {
    return res.json({ provider: 'google', apiKey: GOOGLE_MAPS_API_KEY });
  }
  res.json({ provider: 'osm' });
});

// --- Scraper status: check if Playwright module + browser are available ---
app.get('/api/scrape/status', (req, res) => {
  const moduleInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  res.json({
    module_installed: moduleInstalled,
    ready: moduleInstalled
  });
});

// --- Scrape Airbnb via Playwright subprocess ---
app.post('/api/scrape/airbnb', async (req, res) => {
  const { address, count } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });

  const moduleInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  if (!moduleInstalled) {
    return res.status(501).json({
      error: 'Playwright not installed. Run: npm install playwright && npx playwright install chromium'
    });
  }

  console.log(`[scrape] Starting scrape for: ${address}`);

  const child = spawn(
    'node',
    ['scraper.mjs', '--address', address, '--count', String(count || 12)],
    { cwd: __dirname }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });

  // Timeout guard: 90 seconds
  const killTimer = setTimeout(() => {
    child.kill('SIGKILL');
  }, 90000);

  child.on('close', (code) => {
    clearTimeout(killTimer);
    if (code !== 0) {
      return res.status(500).json({
        error: 'Scraper failed',
        code,
        stderr: stderr.slice(0, 1000)
      });
    }
    try {
      const listings = JSON.parse(stdout);
      console.log(`[scrape] Got ${listings.length} listings`);
      res.json({ comps: listings, count: listings.length, source: 'airbnb-scraper' });
    } catch (e) {
      res.status(500).json({
        error: 'Invalid scraper output',
        detail: stdout.slice(0, 500),
        stderr: stderr.slice(0, 500)
      });
    }
  });
});

// --- AirROI: fetch comparable listings via /listings/comparables ---
// POST /api/airroi/comparables { address, bedrooms, bathrooms, guests, currency }
// Calls GET https://api.airroi.com/listings/comparables?address=...&bedrooms=...&baths=...&guests=...&currency=native
app.post('/api/airroi/comparables', async (req, res) => {
  const { address, bedrooms, bathrooms, guests, currency } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });
  if (!AIRROI_API_KEY) {
    return res.status(501).json({ error: 'AIRROI_API_KEY not set in .env. Activate at https://www.airroi.com/api/developer/activate' });
  }

  const br = parseInt(bedrooms) || 3;
  const ba = parseFloat(bathrooms) || 2;
  const gst = parseInt(guests) || br * 2;

  const params = new URLSearchParams({
    address,
    bedrooms: br,
    baths: ba.toFixed(1),
    guests: gst,
    currency: currency || 'native'
  });

  const url = `${AIRROI_BASE}/listings/comparables?${params}`;
  console.log(`[airroi] GET ${url}`);

  try {
    const r = await fetch(url, {
      headers: { 'x-api-key': AIRROI_API_KEY, 'Accept': 'application/json' }
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[airroi/comparables] non-200:', r.status, data);
      return res.status(r.status).json({ error: 'AirROI error', detail: data });
    }

    // Response is an array of listing objects (or wrapped in { data: [...] })
    const rawComps = Array.isArray(data) ? data : (data.data || data.listings || data.comparables || []);
    if (!rawComps.length) {
      return res.status(404).json({ error: 'No AirROI comparables found' });
    }

    const comps = rawComps.map(c => {
      const info = c.listing_info || {};
      const prop = c.property_details || {};
      const perf = c.performance_metrics || {};
      const rat = c.ratings || {};
      const occRaw = Number(perf.ttm_occupancy || perf.occupancy_rate || perf.occupancy) || 0;
      return {
        id: info.listing_id || c.id || '',
        title: info.listing_name || info.title || c.name || '',
        url: (info.listing_id || c.id) ? `https://www.airbnb.com/rooms/${info.listing_id || c.id}` : '',
        bedrooms: Number(prop.bedrooms || prop.beds || c.bedrooms) || 0,
        bathrooms: Number(prop.baths || prop.bathrooms || c.bathrooms) || 0,
        accommodates: Number(prop.guests || prop.accommodates || c.accommodates) || 0,
        adr: Math.round(Number(perf.ttm_avg_rate || perf.avg_daily_rate || perf.adr) || 0),
        occupancy: occRaw > 0 && occRaw <= 1 ? Math.round(occRaw * 100) : Math.round(occRaw),
        revenue: Math.round(Number(perf.ttm_revenue || perf.revenue || perf.annual_revenue) || 0),
        reviews: Number(rat.num_reviews || info.review_count || c.reviews) || 0,
        rating: Number(rat.rating_overall || info.rating || c.rating) || 0,
        days_available: Number(perf.ttm_available_days || perf.available_days) || 0
      };
    });

    console.log(`[airroi/comparables] returned ${comps.length} comps`);
    res.json({ comps, count: comps.length, source: 'airroi' });
  } catch (err) {
    console.error('[airroi/comparables] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- AirROI: estimate ADR, occupancy & revenue via /calculator/estimate ---
// POST /api/airroi/estimate { address, bedrooms, bathrooms, guests, currency }
// Calls GET https://api.airroi.com/calculator/estimate?address=...&bedrooms=...&baths=...&guests=...&currency=usd
app.post('/api/airroi/estimate', async (req, res) => {
  const { address, bedrooms, bathrooms, guests, currency } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });
  if (!AIRROI_API_KEY) {
    return res.status(501).json({ error: 'AIRROI_API_KEY not set in .env. Activate at https://www.airroi.com/api/developer/activate' });
  }

  const br = parseInt(bedrooms) || 3;
  const ba = parseFloat(bathrooms) || 2;
  const gst = parseInt(guests) || br * 2;

  const params = new URLSearchParams({
    address,
    bedrooms: br,
    baths: ba,
    guests: gst,
    currency: currency || 'usd'
  });

  const url = `${AIRROI_BASE}/calculator/estimate?${params}`;
  console.log(`[airroi] GET ${url}`);

  try {
    const r = await fetch(url, {
      headers: { 'x-api-key': AIRROI_API_KEY, 'Accept': 'application/json' }
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[airroi] non-200:', r.status, data);
      return res.status(r.status).json({ error: 'AirROI error', detail: data });
    }

    // AirROI /calculator/estimate returns:
    // { revenue, average_daily_rate, occupancy (0-1), percentiles, monthly_revenue_distributions, comparable_listings[] }
    const d = data.data || data;

    const rawOcc = Number(d.occupancy || d.occupancy_rate) || 0;
    const occPct = rawOcc > 0 && rawOcc <= 1 ? Math.round(rawOcc * 100) : Math.round(rawOcc);

    // Normalize comparable listings if present
    const rawComps = Array.isArray(d.comparable_listings) ? d.comparable_listings : [];
    const comps = rawComps.map(c => {
      const info = c.listing_info || {};
      const prop = c.property_details || {};
      const perf = c.performance_metrics || {};
      const rat = c.ratings || {};
      const occRaw = Number(perf.ttm_occupancy || perf.occupancy_rate || perf.occupancy) || 0;
      return {
        id: info.listing_id || c.id || '',
        title: info.listing_name || info.title || c.name || '',
        url: (info.listing_id || c.id) ? `https://www.airbnb.com/rooms/${info.listing_id || c.id}` : '',
        bedrooms: Number(prop.bedrooms || prop.beds || c.bedrooms) || 0,
        bathrooms: Number(prop.baths || prop.bathrooms || c.bathrooms) || 0,
        accommodates: Number(prop.guests || prop.accommodates || c.accommodates) || 0,
        adr: Math.round(Number(perf.ttm_avg_rate || perf.avg_daily_rate || perf.adr) || 0),
        occupancy: occRaw > 0 && occRaw <= 1 ? Math.round(occRaw * 100) : Math.round(occRaw),
        revenue: Math.round(Number(perf.ttm_revenue || perf.revenue || perf.annual_revenue) || 0),
        reviews: Number(rat.num_reviews || info.review_count || c.reviews) || 0,
        rating: Number(rat.rating_overall || info.rating || c.rating) || 0,
        days_available: Number(perf.ttm_available_days || perf.available_days) || 0
      };
    });

    const estimate = {
      adr: Math.round(Number(d.average_daily_rate || d.avg_daily_rate || d.adr) || 0),
      occupancy: occPct,
      revenue: Math.round(Number(d.revenue || d.annual_revenue) || 0),
      percentiles: d.percentiles || null,
      monthly_distribution: d.monthly_revenue_distributions || null,
      comp_count: comps.length,
      comps,
      source: 'airroi'
    };

    console.log('[airroi] estimate:', { adr: estimate.adr, occupancy: estimate.occupancy, revenue: estimate.revenue, comps: estimate.comp_count });
    res.json(estimate);
  } catch (err) {
    console.error('[airroi] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- RentCast property lookup: free API (50 req/month) returns BR/BA/sqft ---
// POST /api/rentcast/property { address: string }
// Requires RENTCAST_API_KEY in .env. Sign up at https://app.rentcast.io/app/api
app.post('/api/rentcast/property', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });
  if (!RENTCAST_API_KEY) {
    return res.status(501).json({ error: 'RENTCAST_API_KEY not set in .env' });
  }

  const url = `${RENTCAST_BASE}/properties?address=${encodeURIComponent(address)}`;
  console.log(`[rentcast] GET ${url}`);

  try {
    const r = await fetch(url, {
      headers: { 'X-Api-Key': RENTCAST_API_KEY, 'Accept': 'application/json' }
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[rentcast] non-200:', r.status, data);
      return res.status(r.status).json({ error: 'RentCast error', detail: data });
    }
    // RentCast returns either an array or a single property object
    const prop = Array.isArray(data) ? data[0] : data;
    if (!prop) return res.status(404).json({ error: 'No RentCast match' });

    const normalized = {
      bedrooms: Number(prop.bedrooms) || 0,
      bathrooms: Number(prop.bathrooms) || 0,
      sqft: Number(prop.squareFootage) || 0,
      yearBuilt: Number(prop.yearBuilt) || 0,
      propertyType: prop.propertyType || '',
      lastSalePrice: Number(prop.lastSalePrice) || 0,
      source: 'rentcast'
    };
    console.log('[rentcast] normalized:', normalized);
    res.json(normalized);
  } catch (err) {
    console.error('[rentcast] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Address autocomplete via Nominatim (OpenStreetMap) — free, no key ---
// GET /api/autocomplete?q=...
app.get('/api/autocomplete', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 3) return res.json([]);

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&countrycodes=us&limit=8`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'STRInvestmentAnalyzer/1.0 (property-analysis-tool)',
        'Accept': 'application/json'
      }
    });
    if (!resp.ok) return res.json([]);
    const data = await resp.json();

    const results = data
      .filter(item => item.display_name && item.address)
      .map(item => {
        const a = item.address;
        // Build a clean US address string. Now handles city, zip, state, and full addresses.
        const parts = [];
        if (a.house_number && a.road) parts.push(`${a.house_number} ${a.road}`);
        else if (a.road) parts.push(a.road);
        const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
        if (city) parts.push(city);
        if (a.state) parts.push(a.state);
        if (a.postcode) parts.push(a.postcode);
        const address = parts.length >= 2 ? parts.join(', ') : item.display_name.split(',').slice(0, 4).join(', ');
        return {
          address,
          fullDisplay: item.display_name,
          type: item.type || item.class || '',
          lat: parseFloat(item.lat) || 0,
          lng: parseFloat(item.lon) || 0,
          city, state: a.state, postcode: a.postcode
        };
      });

    res.json(results);
  } catch (err) {
    console.error('[autocomplete] error:', err.message);
    res.json([]);
  }
});

// --- Redfin property lookup: free, no API key, uses public autocomplete + details endpoints ---
// POST /api/redfin/property { address: string }
app.post('/api/redfin/property', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });

  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.redfin.com/'
  };

  // Redfin prefixes its JSON with `{}&&` to defeat JSON hijacking — strip it.
  const stripPrefix = (txt) => txt.replace(/^\{\}&&/, '');

  try {
    // 1) Autocomplete to find the property URL / ID
    const acUrl = `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(address)}&start=0&count=10&v=2&market=&al=1&iss=false&ooa=true&mrs=false`;
    console.log(`[redfin] autocomplete: ${acUrl}`);
    const acResp = await fetch(acUrl, { headers: commonHeaders, redirect: 'manual' });
    // Redfin redirects to ratelimited.redfin.com when throttled
    if (acResp.status >= 300 && acResp.status < 400) {
      const loc = acResp.headers.get('location') || '';
      console.error(`[redfin] redirected (rate-limited?): ${loc}`);
      return res.status(429).json({ error: 'Redfin rate-limited', redirect: loc });
    }
    if (!acResp.ok) {
      return res.status(acResp.status).json({ error: `Redfin autocomplete HTTP ${acResp.status}` });
    }
    const acRaw = await acResp.text();
    const acData = JSON.parse(stripPrefix(acRaw));

    // Dig for an address row with a url
    let propUrl = null;
    const sections = acData?.payload?.sections || acData?.payload?.exactMatch ? [acData.payload] : [];
    const rows = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.url && (node.type === 2 || node.rowType === 'addressRow' || /^\/[A-Z]{2}\//.test(node.url))) {
        rows.push(node);
      }
      Object.values(node).forEach(walk);
    };
    walk(acData);
    if (!rows.length) {
      return res.status(404).json({ error: 'No Redfin match for address', autocomplete: acData });
    }
    propUrl = rows[0].url;
    console.log(`[redfin] propUrl: ${propUrl}`);

    // 2) Fetch initialInfo for the property path
    const infoUrl = `https://www.redfin.com/stingray/api/home/details/initialInfo?path=${encodeURIComponent(propUrl)}`;
    const infoResp = await fetch(infoUrl, { headers: commonHeaders });
    if (!infoResp.ok) {
      return res.status(infoResp.status).json({ error: `Redfin initialInfo HTTP ${infoResp.status}` });
    }
    const infoRaw = await infoResp.text();
    const infoData = JSON.parse(stripPrefix(infoRaw));
    const propertyId = infoData?.payload?.propertyId;
    const listingId = infoData?.payload?.listingId;
    if (!propertyId) {
      return res.status(404).json({ error: 'No propertyId in Redfin response', payload: infoData?.payload });
    }

    // 3) Fetch aboveTheFold (contains BR/BA/sqft for both listed and off-market homes)
    const atfUrl = `https://www.redfin.com/stingray/api/home/details/aboveTheFold?propertyId=${propertyId}${listingId ? `&listingId=${listingId}` : ''}&accessLevel=1`;
    console.log(`[redfin] aboveTheFold: ${atfUrl}`);
    const atfResp = await fetch(atfUrl, { headers: commonHeaders });
    if (!atfResp.ok) {
      return res.status(atfResp.status).json({ error: `Redfin aboveTheFold HTTP ${atfResp.status}` });
    }
    const atfRaw = await atfResp.text();
    const atfData = JSON.parse(stripPrefix(atfRaw));
    const info = atfData?.payload?.addressSectionInfo || atfData?.payload?.publicRecordsInfo?.basicInfo || {};

    const normalized = {
      bedrooms: Number(info.beds || info.numBeds || info.bedrooms) || 0,
      bathrooms: Number(info.baths || info.numBaths || info.totalBaths) || 0,
      sqft: Number(info.sqFt?.value || info.sqFt || info.finishedSqFt) || 0,
      yearBuilt: Number(info.yearBuilt?.value || info.yearBuilt) || 0,
      propertyType: info.propertyType || '',
      url: `https://www.redfin.com${propUrl}`,
      source: 'redfin'
    };
    console.log('[redfin] normalized:', normalized);
    if (!normalized.bedrooms && !normalized.bathrooms) {
      return res.status(404).json({ error: 'No BR/BA in Redfin response', raw: atfData?.payload });
    }
    res.json(normalized);
  } catch (err) {
    console.error('[redfin] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Redfin Playwright scrape: more reliable than JSON endpoints (uses real browser) ---
// POST /api/redfin-scrape/property { address: string }
app.post('/api/redfin-scrape/property', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });

  const moduleInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  if (!moduleInstalled) {
    return res.status(501).json({ error: 'Playwright not installed. Run: npm run install-scraper' });
  }

  console.log(`[redfin-scrape] Looking up: ${address}`);

  const child = spawn(
    'node',
    ['redfin-scraper.mjs', '--address', address],
    { cwd: __dirname }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });

  const killTimer = setTimeout(() => child.kill('SIGKILL'), 60000);

  child.on('close', (code) => {
    clearTimeout(killTimer);
    if (code !== 0) {
      return res.status(500).json({
        error: 'Redfin scrape failed',
        code,
        stderr: stderr.slice(0, 1000)
      });
    }
    try {
      const data = JSON.parse(stdout);
      console.log(`[redfin-scrape] Got:`, data);
      res.json({ ...data, source: 'redfin' });
    } catch (e) {
      res.status(500).json({
        error: 'Invalid redfin-scraper output',
        detail: stdout.slice(0, 500),
        stderr: stderr.slice(0, 500)
      });
    }
  });
});

// --- Zillow property lookup: fetch BR/BA for an address via headless browser ---
// POST /api/zillow/property { address: string }
app.post('/api/zillow/property', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });

  const moduleInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  if (!moduleInstalled) {
    return res.status(501).json({
      error: 'Playwright not installed. Run: npm run install-scraper'
    });
  }

  console.log(`[zillow] Looking up: ${address}`);

  const child = spawn(
    'node',
    ['zillow-scraper.mjs', '--address', address],
    { cwd: __dirname }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });

  const killTimer = setTimeout(() => child.kill('SIGKILL'), 60000);

  child.on('close', (code) => {
    clearTimeout(killTimer);
    if (code !== 0) {
      return res.status(500).json({
        error: 'Zillow lookup failed',
        code,
        stderr: stderr.slice(0, 1000)
      });
    }
    try {
      const data = JSON.parse(stdout);
      console.log(`[zillow] Got:`, data);
      res.json({ ...data, source: 'zillow' });
    } catch (e) {
      res.status(500).json({
        error: 'Invalid zillow-scraper output',
        detail: stdout.slice(0, 500),
        stderr: stderr.slice(0, 500)
      });
    }
  });
});

// --- AirDNA Rentalizer: property revenue/ADR/occupancy estimate ---
// POST /api/airdna/estimate { address: string, latitude?: number, longitude?: number }
app.post('/api/airdna/estimate', async (req, res) => {
  if (!AIRDNA_API_KEY) {
    return res.status(500).json({
      error: 'AIRDNA_API_KEY not set. Copy .env.example → .env and add your key.'
    });
  }
  const { address, latitude, longitude, bedrooms, bathrooms, accommodates } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });

  try {
    const body = { address };
    if (latitude != null && longitude != null) {
      body.location = { latitude, longitude };
    }
    if (bedrooms != null) body.bedrooms = bedrooms;
    if (bathrooms != null) body.bathrooms = bathrooms;
    if (accommodates != null) body.accommodates = accommodates;

    const r = await fetch(`${AIRDNA_BASE}/rentalizer/estimate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRDNA_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      return res.status(r.status).json({ error: 'AirDNA API error', status: r.status, detail: data });
    }

    // Return a normalized shape + raw response so the frontend can fall back
    const normalized = normalizeRentalizer(data);
    res.json({ normalized, raw: data });
  } catch (err) {
    console.error('[airdna/estimate]', err);
    res.status(500).json({ error: err.message });
  }
});

// --- AirDNA Comps: comparable listings for a property ---
// POST /api/airdna/comps { address, latitude?, longitude?, bedrooms?, bathrooms?, accommodates? }
// Flow: 1) call rentalizer/estimate to get listing context 2) call /listing/{id}/comps
app.post('/api/airdna/comps', async (req, res) => {
  if (!AIRDNA_API_KEY) {
    return res.status(500).json({
      error: 'AIRDNA_API_KEY not set. Copy .env.example → .env and add your key.'
    });
  }
  const { address, latitude, longitude, bedrooms, bathrooms, accommodates } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });

  try {
    // Step 1: Get the subject property estimate (includes listing_id + comps array in most responses)
    const estimateBody = { address };
    if (latitude != null && longitude != null) estimateBody.location = { latitude, longitude };
    if (bedrooms != null) estimateBody.bedrooms = bedrooms;
    if (bathrooms != null) estimateBody.bathrooms = bathrooms;
    if (accommodates != null) estimateBody.accommodates = accommodates;

    const estResp = await fetch(`${AIRDNA_BASE}/rentalizer/estimate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRDNA_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(estimateBody)
    });

    const estText = await estResp.text();
    let estimate;
    try { estimate = JSON.parse(estText); } catch { estimate = { raw: estText }; }

    if (!estResp.ok) {
      return res.status(estResp.status).json({
        error: 'AirDNA Rentalizer error',
        status: estResp.status,
        detail: estimate
      });
    }

    // Step 2: Extract comps from the estimate response (most Rentalizer responses include them)
    // If not present, try the /listing/{id}/comps endpoint
    let compsRaw = estimate?.comps || estimate?.data?.comps || [];

    const listingId = estimate?.listing_id || estimate?.property_id || estimate?.data?.listing_id;
    if (!compsRaw.length && listingId) {
      const filters = [];
      if (bedrooms) filters.push({ field: 'bedrooms', type: 'equals', value: bedrooms });
      const compsResp = await fetch(`${AIRDNA_BASE}/listing/${encodeURIComponent(listingId)}/comps`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AIRDNA_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ filters })
      });
      const compsText = await compsResp.text();
      let compsData;
      try { compsData = JSON.parse(compsText); } catch { compsData = { raw: compsText }; }
      if (compsResp.ok) {
        compsRaw = compsData?.listings || compsData?.comps || compsData?.data || [];
      }
    }

    // Step 3: Normalize comps into our app's format
    const normalized = normalizeComps(compsRaw);
    const subjectEstimate = normalizeRentalizer(estimate);

    res.json({
      comps: normalized,
      subject: subjectEstimate,
      count: normalized.length,
      raw: { estimate, compsRaw }
    });
  } catch (err) {
    console.error('[airdna/comps]', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------- Normalizers -------------
// AirDNA responses vary slightly by plan. These adapt common field-name variants.

function pick(obj, ...paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = obj;
    let ok = true;
    for (const k of parts) {
      if (cur == null || typeof cur !== 'object') { ok = false; break; }
      cur = cur[k];
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

function normalizeRentalizer(data) {
  if (!data || typeof data !== 'object') return null;
  const d = data.property_stats || data.data || data;
  return {
    adr: pick(d, 'adr', 'average_daily_rate', 'avg_daily_rate', 'rate'),
    occupancy: pick(d, 'occupancy', 'occupancy_rate', 'occ'),
    revenue: pick(d, 'revenue', 'annual_revenue', 'projected_revenue', 'revenue_potential'),
    bedrooms: pick(d, 'bedrooms', 'br'),
    bathrooms: pick(d, 'bathrooms', 'ba'),
    accommodates: pick(d, 'accommodates', 'max_guests', 'sleeps'),
    market: pick(d, 'market', 'market_name', 'city')
  };
}

function normalizeComps(list) {
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const i = item || {};
    const occ = pick(i, 'occupancy', 'occupancy_rate', 'occ');
    // AirDNA occupancy is often a 0..1 fraction — convert to percentage
    const occPct = occ != null ? (occ <= 1 ? occ * 100 : occ) : 0;
    return {
      source: pick(i, 'title', 'name', 'listing_url', 'url', 'platform_listing_url', 'listing_id') || '',
      adr: Math.round(pick(i, 'adr', 'average_daily_rate', 'avg_daily_rate', 'rate') || 0),
      occ: Math.round(occPct || 0),
      br: pick(i, 'bedrooms', 'br') || 0,
      ba: pick(i, 'bathrooms', 'ba') || 0,
      sleeps: pick(i, 'accommodates', 'max_guests', 'sleeps') || 0,
      daysAvail: pick(i, 'days_available', 'available_days', 'nights_available') || 0,
      reviews: pick(i, 'review_count', 'reviews', 'num_reviews') || 0,
      revenue: Math.round(pick(i, 'revenue', 'annual_revenue', 'projected_revenue') || 0)
    };
  }).filter(c => c.adr > 0 || c.revenue > 0);
}

// ============================================================================
// AirDNA Rentalizer PDF upload + parse
// POST /api/airdna/upload-pdf  (raw body, Content-Type: application/pdf)
// Returns: { adr, occupancy, revenue, noi, opex, comps[], pageCount }
// ============================================================================
import { parseAirDNAPdf } from './airdna-pdf-parser.mjs';

app.post('/api/airdna/upload-pdf',
  express.raw({ type: 'application/pdf', limit: '25mb' }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No PDF body received. Send raw bytes with Content-Type: application/pdf' });
    }
    if (req.body.slice(0, 4).toString('utf8') !== '%PDF') {
      return res.status(400).json({ error: 'Body is not a valid PDF (missing %PDF header)' });
    }
    try {
      console.log(`[airdna-pdf] received ${req.body.length} bytes`);
      const parsed = await parseAirDNAPdf(req.body);
      console.log('[airdna-pdf] parsed:', {
        adr: parsed.adr, occ: parsed.occupancy, rev: parsed.revenue,
        noi: parsed.noi, opex: parsed.opex, comps: parsed.comps.length
      });
      res.json(parsed);
    } catch (err) {
      console.error('[airdna-pdf] error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================================
// Listing parser — extract price + details from a Redfin/Zillow/realtor URL
// POST /api/listing/parse { url }
// ============================================================================
app.post('/api/listing/parse', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url must start with http(s)://' });

  // Fast path: Realtor.com URLs → Realtor16 API (no Playwright).
  // Parses much faster (~500ms vs ~5s) and gives richer data (photos, list date).
  if (/realtor\.com/i.test(url) && REALTOR16_RAPIDAPI_KEY) {
    try {
      const propIdMatch = url.match(/_M(\d+)-?(\d+)?/);
      const propertyId = propIdMatch ? (propIdMatch[1] + (propIdMatch[2] || '')) : null;
      const rt16Url = propertyId
        ? `https://realtor16.p.rapidapi.com/property/details?property_id=${propertyId}`
        : `https://realtor16.p.rapidapi.com/property/details?url=${encodeURIComponent(url)}`;
      const r = await fetch(rt16Url, {
        headers: {
          'x-rapidapi-host': 'realtor16.p.rapidapi.com',
          'x-rapidapi-key': REALTOR16_RAPIDAPI_KEY,
          'Accept': 'application/json'
        }
      });
      if (r.ok) {
        const data = await r.json();
        const p = data?.data || data?.properties?.[0] || data;
        if (p) {
          const loc = p.location?.address || {};
          const desc = p.description || {};
          const street = loc.line || '';
          const city = loc.city || '';
          const state = loc.state_code || loc.state || '';
          const zip = loc.postal_code || '';
          const out = {
            price: Number(p.list_price || p.price || 0) || 0,
            address: [street, city, state].filter(Boolean).join(', ') + (zip ? ` ${zip}` : ''),
            bedrooms: Number(desc.beds || desc.beds_min || 0) || 0,
            bathrooms: parseFloat(desc.baths_consolidated || desc.baths || 0) || 0,
            sqft: Number(desc.sqft || desc.living_area || 0) || 0,
            yearBuilt: Number(desc.year_built || 0) || 0,
            lotSize: Number(desc.lot_sqft || 0) || 0,
            hoaMonthly: Number(p.hoa?.fee || desc.hoa_fee || 0) || 0,
            taxAnnual: Number(p.tax_history?.[0]?.tax || 0) || 0,
            taxRate: 0,
            photoUrl: p.primary_photo?.href || (p.photos?.[0]?.href) || '',
            permalink: p.permalink ? `https://www.realtor.com/realestateandhomes-detail/${p.permalink}` : url,
            source: 'realtor16',
            url
          };
          if (out.taxAnnual && out.price) {
            out.taxRate = +((out.taxAnnual / out.price) * 100).toFixed(3);
          }
          if (out.price > 0 || out.bedrooms > 0) {
            console.log('[listing/parse] realtor16 OK:', { price: out.price, br: out.bedrooms, ba: out.bathrooms });
            return res.json(out);
          }
        }
      }
      console.warn('[listing/parse] realtor16 returned no data, falling back to Playwright');
    } catch (e) {
      console.warn('[listing/parse] realtor16 failed, falling back:', e.message);
    }
  }

  const playwrightInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  if (!playwrightInstalled) {
    return res.status(501).json({ error: 'Playwright not installed. Run: npm run install-scraper' });
  }

  console.log(`[listing/parse] ${url} (Playwright fallback)`);
  const child = spawn('node', ['listing-scraper.mjs', '--url', url], { cwd: __dirname });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => stdout += c.toString());
  child.stderr.on('data', c => { stderr += c.toString(); process.stderr.write(c); });

  const killTimer = setTimeout(() => child.kill('SIGKILL'), 75000);
  child.on('close', (code) => {
    clearTimeout(killTimer);
    if (code !== 0) {
      return res.status(500).json({
        error: 'Listing scrape failed',
        code,
        detail: stderr.slice(-500)
      });
    }
    try {
      const data = JSON.parse(stdout);
      console.log('[listing/parse] OK:', { price: data.price, br: data.bedrooms, ba: data.bathrooms, addr: data.address });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'Invalid scraper output', detail: stdout.slice(0, 500) });
    }
  });
});

// ============================================================================
// LTR (Long-Term Rental / Multi-Family) Endpoints
// ============================================================================

// --- Prime rate from FRED (free, no key) — DPRIME series ---
// GET /api/ltr/prime-rate  →  { rate: 8.50, asOf: '2026-04-18', source: 'FRED' }
let _primeCache = { rate: null, asOf: null, ts: 0 };
app.get('/api/ltr/prime-rate', async (req, res) => {
  // 6-hour cache
  if (_primeCache.rate != null && Date.now() - _primeCache.ts < 6 * 3600 * 1000) {
    return res.json({ rate: _primeCache.rate, asOf: _primeCache.asOf, source: 'FRED (cached)' });
  }
  try {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DPRIME';
    const r = await fetch(url, { headers: { 'User-Agent': 'STRAnalyzer/1.0' } });
    if (!r.ok) throw new Error(`FRED HTTP ${r.status}`);
    const csv = await r.text();
    const lines = csv.trim().split('\n');
    // last non-"." row is the most recent observation
    let lastDate = null, lastRate = null;
    for (let i = lines.length - 1; i >= 1; i--) {
      const [d, v] = lines[i].split(',');
      if (v && v !== '.' && !isNaN(parseFloat(v))) {
        lastDate = d;
        lastRate = parseFloat(v);
        break;
      }
    }
    if (lastRate == null) throw new Error('No FRED data');
    _primeCache = { rate: lastRate, asOf: lastDate, ts: Date.now() };
    console.log(`[prime-rate] ${lastRate}% as of ${lastDate}`);
    res.json({ rate: lastRate, asOf: lastDate, source: 'FRED' });
  } catch (err) {
    console.error('[prime-rate] error:', err.message);
    // Fallback to a reasonable default
    res.json({ rate: 8.50, asOf: null, source: 'fallback', error: err.message });
  }
});

// --- LTR Rent estimate: RentCast AVM + Dwellsy scrape ---
// POST /api/ltr/rent-estimate { address, bedrooms, bathrooms, units }
app.post('/api/ltr/rent-estimate', async (req, res) => {
  const { address, bedrooms, bathrooms, units } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });

  const results = { sources: [], rentEstimates: [] };

  // Source 1: RentCast AVM (/avm/rent/long-term)
  if (RENTCAST_API_KEY) {
    try {
      const params = new URLSearchParams({ address });
      if (bedrooms) params.set('bedrooms', bedrooms);
      if (bathrooms) params.set('bathrooms', bathrooms);
      const rcUrl = `${RENTCAST_BASE}/avm/rent/long-term?${params}`;
      console.log(`[ltr/rent] RentCast: ${rcUrl}`);
      const r = await fetch(rcUrl, { headers: { 'X-Api-Key': RENTCAST_API_KEY, 'Accept': 'application/json' } });
      const d = await r.json();
      if (r.ok && d.rent) {
        results.sources.push('rentcast');
        results.rentEstimates.push({
          source: 'RentCast AVM',
          perUnit: Number(d.rent) || 0,
          low: Number(d.rentRangeLow) || 0,
          high: Number(d.rentRangeHigh) || 0,
          comparables: (d.comparables || []).slice(0, 10).map(c => ({
            address: c.formattedAddress || c.address || '',
            rent: Number(c.price) || 0,
            bedrooms: Number(c.bedrooms) || 0,
            bathrooms: Number(c.bathrooms) || 0,
            sqft: Number(c.squareFootage) || 0,
            distance: Number(c.distance) || 0,
            daysOld: Number(c.daysOld) || 0
          }))
        });
      } else {
        console.warn('[ltr/rent] RentCast non-ok:', r.status, d);
      }
    } catch (e) {
      console.error('[ltr/rent] RentCast error:', e.message);
    }
  }

  // Source 2: Dwellsy scrape (Playwright subprocess, best-effort)
  const playwrightInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  if (playwrightInstalled && existsSync(join(__dirname, 'dwellsy-scraper.mjs'))) {
    try {
      const dwellsy = await new Promise((resolve) => {
        const child = spawn('node', ['dwellsy-scraper.mjs', '--address', address, '--bedrooms', String(bedrooms || '')], { cwd: __dirname });
        let out = '', err = '';
        child.stdout.on('data', c => out += c.toString());
        child.stderr.on('data', c => err += c.toString());
        const t = setTimeout(() => child.kill('SIGKILL'), 45000);
        child.on('close', (code) => {
          clearTimeout(t);
          if (code === 0) { try { resolve(JSON.parse(out)); } catch { resolve(null); } }
          else resolve(null);
        });
      });
      if (dwellsy && dwellsy.medianRent) {
        results.sources.push('dwellsy');
        results.rentEstimates.push({
          source: 'Dwellsy',
          perUnit: dwellsy.medianRent,
          low: dwellsy.low || 0,
          high: dwellsy.high || 0,
          comparables: dwellsy.listings || []
        });
      }
    } catch (e) {
      console.error('[ltr/rent] Dwellsy error:', e.message);
    }
  }

  if (!results.rentEstimates.length) {
    return res.status(404).json({ error: 'No rent estimates available. Check RentCast key or Dwellsy availability.' });
  }

  // Blend: simple average of perUnit from all sources
  const perUnitAvg = Math.round(results.rentEstimates.reduce((s, e) => s + e.perUnit, 0) / results.rentEstimates.length);
  const unitCount = parseInt(units) || 1;
  res.json({
    perUnit: perUnitAvg,
    units: unitCount,
    totalMonthly: perUnitAvg * unitCount,
    totalAnnual: perUnitAvg * unitCount * 12,
    sources: results.sources,
    estimates: results.rentEstimates
  });
});

// --- LTR Sales history via RentCast + Redfin ---
// POST /api/ltr/sales-history { address }
app.post('/api/ltr/sales-history', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });

  const out = { sales: [], sources: [] };

  // RentCast /properties returns lastSalePrice + lastSaleDate + (on some plans) salesHistory[]
  if (RENTCAST_API_KEY) {
    try {
      const url = `${RENTCAST_BASE}/properties?address=${encodeURIComponent(address)}`;
      const r = await fetch(url, { headers: { 'X-Api-Key': RENTCAST_API_KEY, 'Accept': 'application/json' } });
      const data = await r.json();
      const prop = (r.ok && (Array.isArray(data) ? data[0] : data.id ? data : null)) || null;
      if (!r.ok) console.warn('[ltr/sales] RentCast non-ok:', r.status, data?.error || '');
      if (prop) {
        out.sources.push('rentcast');
        if (prop.history && typeof prop.history === 'object') {
          for (const [date, ev] of Object.entries(prop.history)) {
            if (ev.event === 'Sale' || ev.price) {
              out.sales.push({
                date: ev.date || date,
                price: Number(ev.price) || 0,
                event: ev.event || 'Sale',
                source: 'RentCast'
              });
            }
          }
        }
        if (prop.lastSalePrice && !out.sales.some(s => s.price === prop.lastSalePrice)) {
          out.sales.push({
            date: prop.lastSaleDate || '',
            price: Number(prop.lastSalePrice) || 0,
            event: 'Last sale',
            source: 'RentCast'
          });
        }
        out.propertyType = prop.propertyType || '';
        out.bedrooms = Number(prop.bedrooms) || 0;
        out.bathrooms = Number(prop.bathrooms) || 0;
        out.sqft = Number(prop.squareFootage) || 0;
        out.yearBuilt = Number(prop.yearBuilt) || 0;
        out.units = Number(prop.unitCount || prop.numUnits) || 0;
      }
    } catch (e) {
      console.error('[ltr/sales] RentCast error:', e.message);
    }
  }

  // Fallback: if RentCast gave us no sales, scrape Zillow's priceHistory
  const playwrightInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  if (!out.sales.length && playwrightInstalled) {
    try {
      const zillow = await new Promise((resolve) => {
        const child = spawn('node', ['zillow-scraper.mjs', '--address', address], { cwd: __dirname });
        let so = '', se = '';
        child.stdout.on('data', c => so += c.toString());
        child.stderr.on('data', c => se += c.toString());
        const t = setTimeout(() => child.kill('SIGKILL'), 60000);
        child.on('close', (code) => {
          clearTimeout(t);
          if (code === 0) { try { resolve(JSON.parse(so)); } catch { resolve(null); } }
          else { console.error('[ltr/sales] Zillow scraper failed:', se.slice(0, 300)); resolve(null); }
        });
      });
      if (zillow) {
        if (Array.isArray(zillow.priceHistory) && zillow.priceHistory.length) {
          out.sources.push('zillow');
          zillow.priceHistory.forEach(ev => {
            out.sales.push({
              date: ev.date || '',
              price: Number(ev.price) || 0,
              event: ev.event || 'Event',
              pricePerSqFt: ev.pricePerSqFt || 0,
              source: 'Zillow'
            });
          });
        }
        if (!out.bedrooms && zillow.bedrooms) out.bedrooms = zillow.bedrooms;
        if (!out.bathrooms && zillow.bathrooms) out.bathrooms = zillow.bathrooms;
        if (!out.sqft && zillow.sqft) out.sqft = zillow.sqft;
        if (!out.yearBuilt && zillow.yearBuilt) out.yearBuilt = zillow.yearBuilt;
      }
    } catch (e) {
      console.error('[ltr/sales] Zillow fallback error:', e.message);
    }
  }

  // Fallback 2: if still no sales, try the Redfin scraper (often works when Zillow captchas)
  if (!out.sales.length && playwrightInstalled) {
    console.log('[ltr/sales] Trying Redfin scraper fallback...');
    try {
      const redfin = await new Promise((resolve) => {
        const child = spawn('node', ['redfin-scraper.mjs', '--address', address], { cwd: __dirname });
        let so = '', se = '';
        child.stdout.on('data', c => so += c.toString());
        child.stderr.on('data', c => se += c.toString());
        const t = setTimeout(() => { console.error('[ltr/sales] Redfin TIMEOUT'); child.kill('SIGKILL'); }, 90000);
        child.on('close', (code) => {
          clearTimeout(t);
          console.log(`[ltr/sales] Redfin exit code=${code}, stdoutLen=${so.length}, stderrTail=${se.slice(-300)}`);
          if (code === 0) { try { resolve(JSON.parse(so)); } catch (e) { console.error('[ltr/sales] Redfin parse failed:', e.message); resolve(null); } }
          else { resolve(null); }
        });
      });
      console.log('[ltr/sales] Redfin result:', redfin ? { br: redfin.bedrooms, ba: redfin.bathrooms, histLen: redfin.priceHistory?.length } : 'null');
      if (redfin) {
        if (Array.isArray(redfin.priceHistory) && redfin.priceHistory.length) {
          out.sources.push('redfin');
          redfin.priceHistory.forEach(ev => {
            out.sales.push({
              date: ev.date || '',
              price: Number(ev.price) || 0,
              event: ev.event || 'Event',
              pricePerSqFt: ev.pricePerSqFt || 0,
              source: 'Redfin'
            });
          });
        }
        if (!out.bedrooms && redfin.bedrooms) out.bedrooms = redfin.bedrooms;
        if (!out.bathrooms && redfin.bathrooms) out.bathrooms = redfin.bathrooms;
        if (!out.sqft && redfin.sqft) out.sqft = redfin.sqft;
        if (!out.yearBuilt && redfin.yearBuilt) out.yearBuilt = redfin.yearBuilt;
      }
    } catch (e) {
      console.error('[ltr/sales] Redfin fallback error:', e.message);
    }
  }

  // Sort by date desc
  out.sales.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(out);
});

// --- LTR Mortgage / public records helper ---
// POST /api/ltr/mortgage-record { address }
// Public county recorder sites vary wildly — we return curated deep-links + best-effort info.
app.post('/api/ltr/mortgage-record', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });

  // Parse state & county hint from address for deep-linking to known recorder portals
  const stateMatch = (address.match(/,\s*([A-Z]{2})\b/) || [])[1] || '';
  const links = [];

  // Free public-records deep-links (user can click to look up the doc)
  links.push({
    name: 'NETR Online — Public Records Search',
    url: `https://publicrecords.netronline.com/`,
    note: 'Nation-wide index of county recorder / assessor portals'
  });
  if (stateMatch) {
    links.push({
      name: `${stateMatch} County Recorder (NETR)`,
      url: `https://publicrecords.netronline.com/state/${stateMatch}`
    });
  }
  links.push({
    name: 'PropertyShark (free tier)',
    url: `https://www.propertyshark.com/mason/Search?q=${encodeURIComponent(address)}`
  });
  links.push({
    name: 'County-Office.org',
    url: `https://www.county-office.org/search/?q=${encodeURIComponent(address)}`
  });
  links.push({
    name: 'Zillow listing (for loan estimate)',
    url: `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/`
  });

  // Also surface RentCast's data if the plan exposes loan info
  let rcData = null;
  if (RENTCAST_API_KEY) {
    try {
      const url = `${RENTCAST_BASE}/properties?address=${encodeURIComponent(address)}`;
      const r = await fetch(url, { headers: { 'X-Api-Key': RENTCAST_API_KEY, 'Accept': 'application/json' } });
      const d = await r.json();
      const prop = Array.isArray(d) ? d[0] : d;
      if (prop) {
        rcData = {
          lastSalePrice: Number(prop.lastSalePrice) || 0,
          lastSaleDate: prop.lastSaleDate || '',
          assessedValue: Number(prop.taxAssessments?.[Object.keys(prop.taxAssessments || {}).slice(-1)[0]]?.value) || 0,
          ownerOccupied: !!prop.ownerOccupied,
          owner: prop.owner || null
        };
      }
    } catch (e) {
      console.error('[ltr/mortgage] RentCast error:', e.message);
    }
  }

  res.json({ state: stateMatch, links, rentcast: rcData });
});

// --- Static files ---
// ============================================================================
// Distressed Properties — aggregation + Insights endpoints
// ============================================================================
import { computeUnderwriting, DEFAULT_ASSUMPTIONS } from './lib/financial-calc.mjs';
import { lookupCounty } from './census-geocoder.mjs';
import { scrapeRecorder } from './county-recorder-scraper.mjs';
import { scrapeAuctions } from './auction-scraper.mjs';
import { scrapeDwellsy } from './dwellsy-scraper.mjs';
import { lookupZoningHI } from './zoning-hawaii.mjs';
import { saveSearch as drvSaveSearch, listSearches as drvListSearches, deleteSearch as drvDeleteSearch } from './saved-search-drive.mjs';
import { propertyRadarSearch, propertyRadarProperty } from './propertyradar-client.mjs';

import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync as fsReadFileSync, statSync, readdirSync } from 'fs';

const CACHE_DIR = join(__dirname, 'tmp', 'cache');
try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

function cacheGet(key, maxAgeSec) {
  try {
    const p = join(CACHE_DIR, key + '.json');
    const st = statSync(p);
    if ((Date.now() - st.mtimeMs) / 1000 > maxAgeSec) return null;
    return JSON.parse(fsReadFileSync(p, 'utf8'));
  } catch { return null; }
}
function cacheSet(key, value) {
  try { writeFileSync(join(CACHE_DIR, key + '.json'), JSON.stringify(value)); } catch {}
}
function hashKey(o) {
  return createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 24);
}

// Sample data generator — drives Phase 1 UI before scrapers come online.
// Also used as a graceful fallback when RentCast + scrapers all fail.
async function sampleDistressed(location, cap = 10) {
  // 1) Geocode via Nominatim (handles city, state, zip, AND full addresses).
  //    Census geocoder only handles full street addresses, so it's not a fit
  //    for the common "city, state" search query.
  let loc = null;
  try {
    const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&addressdetails=1&countrycodes=us&limit=1`;
    const r = await fetch(u, { headers: { 'User-Agent': 'RealEstateAnalyzer/1.0', 'Accept': 'application/json' } });
    if (r.ok) {
      const arr = await r.json();
      const it = arr?.[0];
      if (it) {
        const a = it.address || {};
        loc = {
          city: a.city || a.town || a.village || a.county || (location.split(',')[0] || '').trim(),
          state: a.state || '',
          stateCode: (a['ISO3166-2-lvl4'] || '').replace(/^US-/, ''),
          lat: parseFloat(it.lat) || 0,
          lng: parseFloat(it.lon) || 0
        };
      }
    }
  } catch { /* tolerated */ }
  // 2) Fallback parse if geocoder unavailable.
  if (!loc || !loc.lat) {
    const m = (location || '').match(/^\s*([\w\s.'-]+?)\s*,\s*([A-Z]{2})/i);
    if (m) {
      loc = { city: m[1].trim(), state: '', stateCode: m[2].toUpperCase(), lat: 39.5, lng: -98.35 };
    } else {
      loc = { city: location || 'Sample City', state: '', stateCode: 'US', lat: 39.5, lng: -98.35 };
    }
  }
  // Normalize display state code (2-letter)
  const stateForDisplay = loc.stateCode || loc.state || '';
  const statuses = ['nod', 'auction', 'tax_delinquent', 'nod', 'on_market', 'off_market'];
  const flagsForStatus = {
    nod: ['NOD'], auction: ['Auction'], tax_delinquent: ['Tax lien'],
    on_market: [], off_market: ['Off-market']
  };

  const out = [];
  for (let i = 0; i < cap; i++) {
    const units = 1 + Math.floor(Math.random() * 6);
    const bedrooms = units * (2 + Math.floor(Math.random() * 2));
    const bathrooms = units * (1 + Math.floor(Math.random() * 2));
    const yearBuilt = 1900 + Math.floor(Math.random() * 110);
    const price = 80_000 + Math.floor(Math.random() * 900_000);
    const status = statuses[i % statuses.length];
    const rent = 800 + Math.floor(Math.random() * 1200);

    const uw = computeUnderwriting(
      { price, units, rentPerUnit: rent },
      { ...DEFAULT_ASSUMPTIONS }
    );

    out.push({
      id: `sample-${loc.city.replace(/\s/g, '')}-${i}`,
      address: `${1000 + i * 23} ${['Oak', 'Main', 'Elm', 'Maple'][i % 4]} St, ${loc.city}, ${stateForDisplay}`,
      lat: loc.lat + (Math.random() - 0.5) * 0.08,
      lng: loc.lng + (Math.random() - 0.5) * 0.08,
      propertyType: units > 1 ? 'multi-family' : 'single-family',
      units, bedrooms, bathrooms, yearBuilt,
      lastSalePrice: Math.round(price * (0.5 + Math.random() * 0.3)),
      lastSaleDate: `${2005 + Math.floor(Math.random() * 18)}-0${1 + Math.floor(Math.random() * 9)}-15`,
      estimatedValue: price,
      ownerName: ['Smith Family Trust', 'John Doe', 'Jane Doe LLC', 'Acme Holdings LP'][i % 4],
      ownerOccupied: i % 5 === 0,
      status,
      flags: [...flagsForStatus[status]],
      capRate: uw.capRate,
      noi: uw.noi,
      _isSample: true
    });
  }
  return out;
}

// Aggregator: tries PropertyRadar → RentCast → sample fallback
async function aggregateDistressedSearch({ location, filters, cap }) {
  // PropertyRadar (env-gated, paid)
  if (PROPERTYRADAR_API_KEY) {
    try {
      const r = await propertyRadarSearch({ apiKey: PROPERTYRADAR_API_KEY, base: PROPERTYRADAR_BASE, location, filters, cap });
      if (r && r.length) return { results: r, source: 'propertyradar' };
    } catch (e) {
      console.warn('[distressed] PropertyRadar failed:', e.message);
    }
  }
  // RentCast: pull properties in zip / city, then filter
  // (Free tier is restrictive; if we don't have a hit, fall back to sample.)
  if (RENTCAST_API_KEY) {
    try {
      const url = `${RENTCAST_BASE}/properties?address=${encodeURIComponent(location)}&limit=${cap}`;
      const r = await fetch(url, { headers: { 'X-Api-Key': RENTCAST_API_KEY, 'Accept': 'application/json' } });
      const data = await r.json();
      if (r.ok && Array.isArray(data) && data.length) {
        const results = data.slice(0, cap).map((p, idx) => ({
          id: p.id || `rc-${idx}`,
          address: p.formattedAddress || p.address || '',
          lat: Number(p.latitude) || 0,
          lng: Number(p.longitude) || 0,
          propertyType: (p.propertyType || '').toLowerCase().includes('multi') ? 'multi-family' : 'single-family',
          units: Number(p.unitCount || p.numUnits) || 1,
          bedrooms: Number(p.bedrooms) || 0,
          bathrooms: Number(p.bathrooms) || 0,
          yearBuilt: Number(p.yearBuilt) || 0,
          lastSalePrice: Number(p.lastSalePrice) || 0,
          lastSaleDate: p.lastSaleDate || '',
          estimatedValue: Number(p.lastSalePrice) || 0,
          ownerName: p.owner?.names?.[0] || p.owner?.name || '',
          ownerOccupied: !!p.ownerOccupied,
          status: 'off_market',
          flags: [],
          capRate: 0, noi: 0,
          _isSample: false
        }));
        return { results, source: 'rentcast' };
      }
    } catch (e) {
      console.warn('[distressed] RentCast failed:', e.message);
    }
  }
  // Auction.com — REAL distressed data via Playwright scrape of public listings.
  // This is the primary free source for live distressed inventory by city/state.
  const playwrightInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  if (playwrightInstalled) {
    try {
      // Parse city/state/zip from location
      const m = (location || '').match(/^\s*([\w\s.'-]+?)\s*,\s*([A-Z]{2}|[A-Za-z ]+)/i);
      const zipMatch = (location || '').match(/^\s*(\d{5})\s*$/);
      const auc = await scrapeAuctions({
        city: m ? m[1].trim() : null,
        state: m ? m[2].trim() : (!zipMatch ? location : null),
        zip: zipMatch ? zipMatch[1] : null,
        cap
      });
      if (auc.listings && auc.listings.length) {
        // Geocode each in parallel (limited concurrency) for map pins
        const results = auc.listings.map((L, idx) => ({
          id: `ac-${idx}-${L.address.replace(/\s/g, '').slice(0, 20)}`,
          address: L.address,
          lat: 0, lng: 0,  // Will be geocoded lazily client-side or by /property endpoint
          propertyType: L.bedrooms > 4 ? 'multi-family' : 'single-family',
          units: 1,
          bedrooms: L.bedrooms || 0,
          bathrooms: L.bathrooms || 0,
          yearBuilt: 0,
          lastSalePrice: 0,
          lastSaleDate: '',
          estimatedValue: L.price || 0,
          ownerName: '',
          ownerOccupied: false,
          status: L.status || 'auction',
          flags: L.flags || [],
          endsIn: L.endsIn,
          detailUrl: L.detailUrl,
          sqft: L.sqft || 0,
          capRate: 0, noi: 0,
          _isSample: false
        }));
        // Light geocoding pass — use Nominatim for the first N listings to populate map pins
        await geocodeResultsLazy(results, Math.min(30, results.length));
        return { results, source: 'auction.com', totalAvailable: auc.totalAvailable };
      }
    } catch (e) {
      console.warn('[distressed] Auction.com scrape failed:', e.message);
    }
  }

  // Sample fallback (only reached when scrapers can't help)
  return { results: await sampleDistressed(location, cap), source: 'sample' };
}

// Geocode N results in parallel (Nominatim, free, no key).
// Respects Nominatim's 1 req/sec policy by chunking with small delays.
async function geocodeResultsLazy(results, n) {
  for (let i = 0; i < n; i++) {
    const r = results[i];
    if (r.lat && r.lng) continue;
    try {
      const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(r.address)}&format=json&countrycodes=us&limit=1`;
      const resp = await fetch(u, { headers: { 'User-Agent': 'RealEstateAnalyzer/1.0' } });
      if (resp.ok) {
        const arr = await resp.json();
        if (arr?.[0]) {
          r.lat = parseFloat(arr[0].lat) || 0;
          r.lng = parseFloat(arr[0].lon) || 0;
        }
      }
    } catch { /* tolerated */ }
    // Nominatim usage policy: ≤ 1 req/sec
    await new Promise(res => setTimeout(res, 80));
  }
}

// GET /api/distressed/search?location=...&cap=...
app.get('/api/distressed/search', async (req, res) => {
  const location = (req.query.location || '').trim();
  if (!location) return res.status(400).json({ error: 'location is required' });
  const cap = Math.min(parseInt(req.query.cap) || 500, 1000);

  // Parse filters
  let filters = {};
  try { filters = JSON.parse(req.query.filters || '{}'); } catch {}

  const cacheKey = `ds-search-${hashKey({ location, filters, cap })}`;
  const cached = cacheGet(cacheKey, 60 * 60); // 1hr
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  console.log(`[distressed/search] "${location}" cap=${cap}`);
  const { results, source } = await aggregateDistressedSearch({ location, filters, cap });

  // Apply client-style filters server-side
  let filtered = results;
  if (filters.types && filters.types.length) {
    filtered = filtered.filter(r => filters.types.includes(r.propertyType));
  }
  if (filters.statuses && filters.statuses.length) {
    filtered = filtered.filter(r => filters.statuses.includes(r.status));
  }
  if (filters.priceMin) filtered = filtered.filter(r => r.estimatedValue >= filters.priceMin);
  if (filters.priceMax) filtered = filtered.filter(r => r.estimatedValue <= filters.priceMax);
  if (filters.unitsMin) filtered = filtered.filter(r => r.units >= filters.unitsMin);
  if (filters.unitsMax) filtered = filtered.filter(r => r.units <= filters.unitsMax);
  if (filters.brMin) filtered = filtered.filter(r => r.bedrooms >= filters.brMin);
  if (filters.baMin) filtered = filtered.filter(r => r.bathrooms >= filters.baMin);
  if (filters.yearBefore) filtered = filtered.filter(r => r.yearBuilt > 0 && r.yearBuilt <= filters.yearBefore);

  // Sort by distress severity then ascending price
  const sevRank = { auction: 0, nod: 1, tax_delinquent: 2, in_contract: 3, on_market: 4, off_market: 5 };
  filtered.sort((a, b) => (sevRank[a.status] ?? 9) - (sevRank[b.status] ?? 9) || a.estimatedValue - b.estimatedValue);

  const payload = { source, results: filtered, count: filtered.length, totalSeen: results.length };
  cacheSet(cacheKey, payload);
  res.json(payload);
});

// POST /api/distressed/property — full Insights record + underwriting precompute
app.post('/api/distressed/property', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address is required' });
  const cacheKey = `ds-prop-${hashKey({ address })}`;
  const cached = cacheGet(cacheKey, 24 * 60 * 60); // 24hr
  if (cached) return res.json({ ...cached, cached: true });

  const out = {
    address,
    saleComp: { lastSalePrice: 0, lastSaleDate: '', priceHistory: [], nearbyComps: [] },
    leaseData: { marketMedianRent: 0, lastLeasedDate: '', lastKnownRent: 0 },
    record: { owner: {}, mortgage: {}, distress: { status: 'NONE' }, tax: {} },
    sources: []
  };

  // PropertyRadar (paid) first
  if (PROPERTYRADAR_API_KEY) {
    try {
      const pr = await propertyRadarProperty({ apiKey: PROPERTYRADAR_API_KEY, base: PROPERTYRADAR_BASE, address });
      if (pr) Object.assign(out, pr);
      out.sources.push('propertyradar');
    } catch (e) {
      console.warn('[distressed/property] PropertyRadar failed:', e.message);
    }
  }

  // RentCast for owner / sale / tax baseline
  if (RENTCAST_API_KEY && !out.record.owner.name) {
    try {
      const url = `${RENTCAST_BASE}/properties?address=${encodeURIComponent(address)}`;
      const r = await fetch(url, { headers: { 'X-Api-Key': RENTCAST_API_KEY, 'Accept': 'application/json' } });
      const data = await r.json();
      const p = Array.isArray(data) ? data[0] : data;
      if (r.ok && p) {
        out.lat = Number(p.latitude) || 0;
        out.lng = Number(p.longitude) || 0;
        out.propertyType = (p.propertyType || '').toLowerCase().includes('multi') ? 'multi-family' : 'single-family';
        out.units = Number(p.unitCount || p.numUnits) || 1;
        out.bedrooms = Number(p.bedrooms) || 0;
        out.bathrooms = Number(p.bathrooms) || 0;
        out.yearBuilt = Number(p.yearBuilt) || 0;
        out.sqft = Number(p.squareFootage) || 0;
        out.saleComp.lastSalePrice = Number(p.lastSalePrice) || 0;
        out.saleComp.lastSaleDate = p.lastSaleDate || '';
        out.record.owner = {
          name: p.owner?.names?.[0] || p.owner?.name || '',
          mailingAddress: p.owner?.mailingAddress || '',
          ownerOccupied: !!p.ownerOccupied
        };
        out.record.tax = {
          assessedValue: Number(p.taxAssessments?.[Object.keys(p.taxAssessments || {}).slice(-1)[0]]?.value) || 0,
          annualTax: 0,
          taxRate: 0,
          delinquentYears: 0
        };
        out.sources.push('rentcast');
      }
    } catch (e) {
      console.warn('[distressed/property] RentCast failed:', e.message);
    }
  }

  // County / state for distress filings
  let stateCode = '';
  let countyName = '';
  try {
    const geo = await lookupCounty(address);
    if (geo) {
      out.county = geo.county;
      out.stateFIPS = geo.stateFIPS;
      stateCode = geo.state;
      countyName = geo.county;
      out.sources.push('census');
    }
  } catch (e) { /* tolerated */ }

  // Distress filings via county recorder (best-effort)
  const playwrightInstalled = existsSync(join(__dirname, 'node_modules', 'playwright'));
  if (playwrightInstalled && stateCode) {
    try {
      const fil = await scrapeRecorder({ address, county: countyName, state: stateCode });
      if (fil && fil.distress) {
        out.record.distress = fil.distress;
        if (fil.mortgage) out.record.mortgage = fil.mortgage;
        out.sources.push('county-recorder');
      }
    } catch (e) {
      console.warn('[distressed/property] recorder scrape failed:', e.message);
    }
  }

  // HI zoning
  if (stateCode === 'HI') {
    try {
      const z = await lookupZoningHI({ address, lat: out.lat, lng: out.lng });
      if (z) {
        out.record.zoning = z;
        out.sources.push('maui-gis');
      }
    } catch (e) { /* tolerated */ }
  }

  // Compute underwriting from whatever we have
  const price = out.estimatedValue || out.saleComp.lastSalePrice || 0;
  if (price > 0) {
    const rentPerUnit = out.leaseData.marketMedianRent
      || Math.round(price * 0.008 / Math.max(1, out.units || 1));   // 0.8% rule fallback
    out.underwriting = computeUnderwriting(
      { price, units: out.units || 1, rentPerUnit },
      { ...DEFAULT_ASSUMPTIONS }
    );
  }

  cacheSet(cacheKey, out);
  res.json(out);
});

// POST /api/distress/scrape — direct scraper invocation
app.post('/api/distress/scrape', async (req, res) => {
  const { address, county, state } = req.body || {};
  if (!address || !state) return res.status(400).json({ error: 'address and state required' });
  try {
    const r = await scrapeRecorder({ address, county, state });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auction/scrape
app.post('/api/auction/scrape', async (req, res) => {
  const { city, state, zip } = req.body || {};
  try {
    const r = await scrapeAuctions({ city, state, zip });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/zoning/hawaii
app.post('/api/zoning/hawaii', async (req, res) => {
  const { address, lat, lng } = req.body || {};
  if (!address) return res.status(400).json({ error: 'address required' });
  try {
    const z = await lookupZoningHI({ address, lat, lng });
    res.json(z || { error: 'no zoning found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Saved-search endpoints — wrap Drive client (works without token via localStorage fallback in client)
app.post('/api/saved-search/save', async (req, res) => {
  // The actual Drive call is client-side (the user owns the OAuth token).
  // This endpoint exists for the localStorage-only fallback path.
  const { name, filters, location } = req.body || {};
  if (!name || !filters) return res.status(400).json({ error: 'name + filters required' });
  // No-op server side for v1; client persists. Reserved for future server-stored option.
  res.json({ ok: true, name });
});

// ============================================================================
// STR Opportunity Finder — search endpoint (CTO-130)
// Returns top N candidates whose underwriting meets a target cap rate.
// ============================================================================
import {
  listingsSale as rcListingsSale,
  marketByZip as rcMarketByZip,
  marketByCity as rcMarketByCity,
  rentAvm as rcRentAvm,
  normalizeMarket,
  rentForBedrooms
} from './rentcast-opportunity.mjs';
import { detectMarketType, strDefaults, strAnnualRevenue } from './lib/str-multiplier.mjs';
import { computeScenarios } from './lib/str-scenarios.mjs';
import {
  forSaleByLocation as rt16ForSaleByLocation,
  forSaleByCoords as rt16ForSaleByCoords
} from './realtor16-client.mjs';

// Map UI property-type keys (UI uses kebab-case) to RentCast labels.
const PROPERTY_TYPE_TO_RC = {
  'single-family': 'Single Family',
  'condo':         'Condo',
  'townhome':      'Townhouse',
  'multi-family':  'Multi-Family'
};

// Parse "Cleveland, OH" / "94401" / "475 Front St, Lahaina, HI" into the
// fields RentCast's /listings/sale endpoint accepts.
function parseSearchLocation(location) {
  const trimmed = String(location || '').trim();
  // Zip code (5 digits)
  if (/^\d{5}$/.test(trimmed)) return { kind: 'zip', zipCode: trimmed };
  // "City, ST" (state can be 2-letter or full name — we accept 2-letter)
  const cityState = trimmed.match(/^(.+?),\s*([A-Z]{2})\s*(\d{5})?\s*$/i);
  if (cityState) {
    return {
      kind: 'city',
      city: cityState[1].trim(),
      state: cityState[2].toUpperCase(),
      zipCode: cityState[3] || null
    };
  }
  // Full address — caller may provide lat/lng + radius separately
  return { kind: 'address', raw: trimmed };
}

// ============================================================================
// AirROI area baseline — fetches up to ~25 STR comparables for the search area
// and aggregates them into median revenue + occupancy + ADR per bedroom count.
// This is the primary STR data source for the Opportunity Finder; we use it
// before falling back to RentCast LTR × multiplier × occupancy heuristic.
// ============================================================================
async function fetchAirroiAreaBaseline({ address, bedrooms = 3, bathrooms = 2, guests }) {
  if (!AIRROI_API_KEY || !address) return null;
  const cacheKey = `sopp-airroi-area-${hashKey({ a: address })}`;
  const cached = cacheGet(cacheKey, 60 * 60); // 1hr cache per search area
  if (cached) return cached;

  const params = new URLSearchParams({
    address,
    bedrooms: parseInt(bedrooms) || 3,
    baths: (parseFloat(bathrooms) || 2).toFixed(1),
    guests: parseInt(guests) || bedrooms * 2,
    currency: 'usd'
  });
  const url = `${AIRROI_BASE}/listings/comparables?${params}`;
  try {
    const r = await fetch(url, { headers: { 'x-api-key': AIRROI_API_KEY, 'Accept': 'application/json' } });
    if (!r.ok) {
      console.warn(`[airroi-area] HTTP ${r.status}`);
      return null;
    }
    const data = await r.json();
    const rawComps = Array.isArray(data) ? data : (data.data || data.listings || data.comparables || []);
    if (!rawComps.length) return null;

    // Aggregate into per-BR median revenue + occupancy + ADR
    const byBr = {};   // { 1: [rev,rev,...], 2: [...], ... }
    const occByBr = {};
    const adrByBr = {};
    const allRevs = [];
    for (const c of rawComps) {
      const prop = c.property_details || {};
      const perf = c.performance_metrics || {};
      const br = Number(prop.bedrooms || prop.beds) || 0;
      const rev = Number(perf.ttm_revenue || perf.revenue || perf.annual_revenue) || 0;
      const occRaw = Number(perf.ttm_occupancy || perf.occupancy_rate || perf.occupancy) || 0;
      const occ = occRaw > 0 && occRaw <= 1 ? occRaw : occRaw / 100;
      const adr = Number(perf.ttm_avg_rate || perf.avg_daily_rate || perf.adr) || 0;
      if (rev <= 0) continue;
      if (!byBr[br]) { byBr[br] = []; occByBr[br] = []; adrByBr[br] = []; }
      byBr[br].push(rev);
      if (occ > 0) occByBr[br].push(occ);
      if (adr > 0) adrByBr[br].push(adr);
      allRevs.push(rev);
    }
    const median = (arr) => {
      if (!arr || !arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const revByBr = {};
    const occByBrMedian = {};
    const adrByBrMedian = {};
    for (const br of Object.keys(byBr)) {
      revByBr[br] = median(byBr[br]);
      occByBrMedian[br] = median(occByBr[br]);
      adrByBrMedian[br] = median(adrByBr[br]);
    }
    const baseline = {
      revByBr,
      occByBr: occByBrMedian,
      adrByBr: adrByBrMedian,
      overallMedianRev: median(allRevs),
      compCount: rawComps.length,
      source: 'airroi'
    };
    cacheSet(cacheKey, baseline);
    console.log(`[airroi-area] ${rawComps.length} comps cached`, Object.keys(revByBr).map(b => `${b}BR=$${Math.round(revByBr[b]).toLocaleString()}`).join(' '));
    return baseline;
  } catch (e) {
    console.warn('[airroi-area] error:', e.message);
    return null;
  }
}

// Look up the AirROI area median revenue for a specific bedroom count.
// Falls back to overall median × industry per-BR scaling if exact BR missing.
const BEDROOM_REV_FACTORS = { 0: 0.60, 1: 0.75, 2: 1.00, 3: 1.25, 4: 1.50, 5: 1.75, 6: 2.00, 7: 2.25 };
function airroiBaselineForBr(baseline, br) {
  if (!baseline) return null;
  const exact = baseline.revByBr[br];
  if (exact > 0) {
    return {
      revenue: exact,
      occupancy: baseline.occByBr[br] || 0.55,
      adr: baseline.adrByBr[br] || 0
    };
  }
  // Fall back to scaling from overall median
  if (baseline.overallMedianRev > 0) {
    const f = BEDROOM_REV_FACTORS[Math.min(7, Math.max(0, Math.round(br)))] || 1;
    return {
      revenue: baseline.overallMedianRev * f / (BEDROOM_REV_FACTORS[2] || 1),  // normalize to 2BR baseline
      occupancy: 0.55,
      adr: 0
    };
  }
  return null;
}

// Filter a single RentCast listing against the user-supplied filters block.
// Returns true if it should be kept.
//
// Unconditional exclusions (cannot be overridden by user filters):
//   - Land / vacant lots — no structure to STR
//   - Listings with zero bedrooms (likely land, mobile lots, or bad data)
function passesFilters(L, f) {
  // ---- Always exclude land / vacant lots ----
  const rcType = (L.propertyType || '').toLowerCase();
  if (/\bland\b|\bvacant\b|\blot\b|\bacreage\b|\bagricult/i.test(rcType)) return false;
  const br = Number(L.bedrooms) || 0;
  if (br <= 0) return false;  // STR needs at least one bedroom

  if (!f) return true;
  if (f.types && f.types.length) {
    const ok = f.types.some(t => rcType.includes(t.replace('-', ' ')) || rcType.includes(t));
    if (!ok) return false;
  }
  const price = Number(L.price || L.listPrice) || 0;
  if (f.priceMin && price < f.priceMin) return false;
  if (f.priceMax && price > f.priceMax) return false;
  if (f.brMin != null && br < f.brMin) return false;
  if (f.brMax != null && br > f.brMax) return false;
  const ba = Number(L.bathrooms) || 0;
  if (f.baMin != null && ba < f.baMin) return false;
  if (f.baMax != null && ba > f.baMax) return false;
  if (f.yearBefore && L.yearBuilt && L.yearBuilt > f.yearBefore) return false;
  return true;
}

// GET /api/str-opportunity/search?location=...&filters=<json>&targetCap=0.11&...
app.get('/api/str-opportunity/search', async (req, res) => {
  const t0 = Date.now();
  const location = String(req.query.location || '').trim();
  if (!location) return res.status(400).json({ error: 'location is required' });
  if (!RENTCAST_API_KEY) return res.status(501).json({ error: 'RENTCAST_API_KEY not configured' });

  const cap = Math.min(parseInt(req.query.cap) || 500, 1000);
  // NOTE: use isFinite to allow 0 as a valid target (`|| 0.11` treats 0 as falsy)
  const rawTargetCap = parseFloat(req.query.targetCap);
  const targetCap = Math.max(0, Math.min(1, isFinite(rawTargetCap) ? rawTargetCap : 0.11));
  const radius = parseInt(req.query.radius) || 25;
  let filters = {};
  try { filters = JSON.parse(req.query.filters || '{}'); } catch { /* ignore */ }

  // Optional user overrides
  const overrideMul = req.query.strMultiplier != null ? parseFloat(req.query.strMultiplier) : null;
  const overrideOcc = req.query.occupancy != null ? parseFloat(req.query.occupancy) : null;

  // Cache key — by location + filters + target cap + result cap + assumptions
  const cacheKey = `sopp-search-${hashKey({ location, filters, cap, targetCap, radius, overrideMul, overrideOcc })}`;
  const cached = cacheGet(cacheKey, 60 * 60); // 1hr
  if (cached) return res.json({ ...cached, cached: true });

  console.log(`[str-opp/search] "${location}" cap=${cap} targetCap=${targetCap}`);

  try {
    // Step 1: geocode/parse location to RentCast args
    const loc = parseSearchLocation(location);
    const listingArgs = { limit: cap, status: 'Active' };
    if (loc.kind === 'zip') listingArgs.zipCode = loc.zipCode;
    else if (loc.kind === 'city') {
      listingArgs.city = loc.city;
      listingArgs.state = loc.state;
    } else {
      // Full address — geocode via Nominatim, then use lat/lng + radius
      const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&countrycodes=us&limit=1`,
        { headers: { 'User-Agent': 'RealEstateAnalyzer/1.0' } });
      if (r.ok) {
        const arr = await r.json();
        if (arr?.[0]) {
          listingArgs.lat = parseFloat(arr[0].lat);
          listingArgs.lng = parseFloat(arr[0].lon);
          listingArgs.radius = radius;
        }
      }
      if (!listingArgs.lat) return res.status(404).json({ error: `Could not geocode "${location}"` });
    }

    // Step 2: Pull active listings
    // Primary source: Realtor16 (Realtor.com via RapidAPI). Better coverage
    // and richer fields (photos, listing date, lot size) than RentCast.
    // Fallback: RentCast (always wired) if Realtor16 fails or isn't configured.
    const cityHint = loc.city || (loc.kind === 'zip' ? null : location.split(',')[0]);
    const stateHint = loc.state;
    let listings = [];
    let listingsSource = 'rentcast';
    let totalAvailable = 0;
    if (REALTOR16_RAPIDAPI_KEY) {
      try {
        let rt16Result;
        if (loc.kind === 'address' && listingArgs.lat) {
          rt16Result = await rt16ForSaleByCoords(
            { lat: listingArgs.lat, lng: listingArgs.lng, radius, limit: cap },
            REALTOR16_RAPIDAPI_KEY
          );
        } else {
          rt16Result = await rt16ForSaleByLocation(
            { location, limit: cap, searchRadius: loc.kind === 'address' ? radius : 0 },
            REALTOR16_RAPIDAPI_KEY
          );
        }
        if (rt16Result?.listings?.length) {
          listings = rt16Result.listings;
          totalAvailable = rt16Result.total || listings.length;
          listingsSource = 'realtor16';
          console.log(`[str-opp/search] Realtor16 returned ${listings.length} listings (${totalAvailable} total in market)`);
        }
      } catch (e) {
        console.warn('[str-opp/search] Realtor16 failed, falling back to RentCast:', e.message);
      }
    }
    if (!listings.length) {
      listings = await rcListingsSale(listingArgs, RENTCAST_API_KEY);
      listingsSource = 'rentcast';
    }

    // Step 2b: Look up market rent. Prefer zip-level (more reliable) — derive
    // the dominant zip from the listings if we don't have one from the query.
    let marketRaw = null;
    let marketZip = loc.zipCode || null;
    if (!marketZip && listings.length) {
      const zipCounts = {};
      for (const L of listings) {
        const z = L.zipCode || L.zip;
        if (z) zipCounts[z] = (zipCounts[z] || 0) + 1;
      }
      marketZip = Object.entries(zipCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    }
    if (marketZip) {
      marketRaw = await rcMarketByZip(marketZip, RENTCAST_API_KEY).catch(() => null);
    }
    if (!marketRaw && cityHint && stateHint) {
      marketRaw = await rcMarketByCity(cityHint, stateHint, RENTCAST_API_KEY).catch(() => null);
    }
    const market = normalizeMarket(marketRaw);

    // Step 3: Determine STR assumptions (auto-detect from city or use overrides)
    const cityForMarket = cityHint || (listings[0]?.city) || '';
    const strOpts = strDefaults(cityForMarket, {
      multiplier: overrideMul,
      occupancy: overrideOcc
    });

    // Step 3b: AirROI area baseline — primary STR data source.
    // Single call returns ~25 actual STR comparables; we group by BR and use
    // median revenue as the baseline for every RentCast listing.
    const sampleAddress = listings[0]?.formattedAddress || listings[0]?.address || location;
    const sampleBr = Number(listings[0]?.bedrooms) || 3;
    const sampleBa = Number(listings[0]?.bathrooms) || 2;
    const airroiBaseline = await fetchAirroiAreaBaseline({
      address: sampleAddress,
      bedrooms: sampleBr,
      bathrooms: sampleBa,
      guests: sampleBr * 2
    });

    // Step 4: For each listing, compute UW
    const candidates = [];
    let airroiCount = 0, heuristicCount = 0;
    for (const L of listings) {
      if (!passesFilters(L, filters)) continue;
      const price = Number(L.price || L.listPrice) || 0;
      if (price <= 0) continue;
      const bedrooms = Number(L.bedrooms) || 2;
      const bathrooms = Number(L.bathrooms) || 1;
      const ltrMonthly = rentForBedrooms(market, bedrooms);
      if (ltrMonthly <= 0) continue;

      // Primary: AirROI-derived baseline by BR count.
      // Fallback: RentCast LTR × multiplier × occupancy heuristic.
      let strAnnual, strOcc, strConfidence;
      const air = airroiBaselineForBr(airroiBaseline, bedrooms);
      if (air && air.revenue > 0) {
        strAnnual = air.revenue;
        strOcc = air.occupancy;
        strConfidence = 'airroi-baseline';
        airroiCount++;
      } else {
        strAnnual = strAnnualRevenue(ltrMonthly, strOpts);
        strOcc = strOpts.occupancy;
        strConfidence = 'estimated';
        heuristicCount++;
      }

      const uw = computeUnderwriting({
        price,
        units: 1,
        rentPerUnit: strAnnual / 12
      });
      candidates.push({
        id: L.id || `rc-${candidates.length}`,
        address: L.formattedAddress || L.address || '',
        lat: Number(L.latitude) || 0,
        lng: Number(L.longitude) || 0,
        propertyType: L.propertyType || '',
        bedrooms,
        bathrooms,
        sqft: Number(L.squareFootage) || 0,
        yearBuilt: Number(L.yearBuilt) || 0,
        price,
        lastSalePrice: Number(L.lastSalePrice) || 0,
        lastSaleDate: L.lastSaleDate || '',
        listingType: L.listingType || '',
        daysOnMarket: Number(L.daysOnMarket) || 0,
        ltrMonthlyRent: ltrMonthly,
        strAnnualRevenue: Math.round(strAnnual),
        occupancy: strOcc,              // 0-1 decimal; from AirROI or auto-detected
        confidence: strConfidence,      // 'airroi-baseline' | 'estimated'  (refinement → 'verified')
        // Realtor16 extras (when source is realtor16)
        photoUrl: L.photoUrl || '',
        permalink: L.permalink || '',
        listDate: L.listDate || '',
        priceReduced: Number(L.priceReduced) || 0,
        listingStatus: L.status || '',
        capRate: uw.capRate,
        noi: Math.round(uw.noi),
        monthlyCF: Math.round(uw.monthlyCF),
        annualCF: Math.round(uw.annualCF),
        cocReturn: uw.cocReturn,
        dscr: uw.dscr,
        targetPriceAtCap: Math.round(uw.targetPriceAtCap),
        roi: uw.roi,
        underwriting: {
          assumptions: uw.assumptions,
          monthlyPI: Math.round(uw.monthlyPI),
          totalOpex: Math.round(uw.totalOpex)
        }
      });
    }

    // Step 5: Filter by target cap; sort by cap desc
    const meeting = candidates.filter(c => c.capRate >= targetCap)
                              .sort((a, b) => b.capRate - a.capRate);

    const payload = {
      results: meeting,
      totalCandidates: candidates.length,
      totalScanned: listings.length,
      marketType: strOpts.marketType,
      marketEmoji: strOpts.emoji,
      autoMultiplier: strOpts.multiplier,
      autoOccupancy: strOpts.occupancy,
      ltrMedianRent: market?.medianRent || 0,
      airroiBaseline: airroiBaseline ? {
        compCount: airroiBaseline.compCount,
        revByBr: airroiBaseline.revByBr,
        occByBr: airroiBaseline.occByBr,
        used: airroiCount,
        fellBack: heuristicCount
      } : null,
      source: `${listingsSource}${airroiBaseline ? '+airroi' : ''}`,
      listingsSource,
      totalAvailable,
      tookMs: Date.now() - t0
    };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('[str-opp/search] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/str-opportunity/property
// Body: { address, price, bedrooms, bathrooms, units, units, strAnnualRevenue, occupancy, marketType }
// Returns the full Insights payload: property record, STR Low/Mid/High scenarios,
// nearby comparable sales, and an updated underwriting card.
app.post('/api/str-opportunity/property', async (req, res) => {
  const b = req.body || {};
  if (!b.address) return res.status(400).json({ error: 'address is required' });
  if (!RENTCAST_API_KEY) return res.status(501).json({ error: 'RENTCAST_API_KEY not configured' });

  const cacheKey = `sopp-prop-${hashKey({ a: b.address, p: b.price })}`;
  const cached = cacheGet(cacheKey, 24 * 60 * 60);
  if (cached) return res.json({ ...cached, cached: true });

  const out = {
    address: b.address,
    price: Number(b.price) || 0,
    bedrooms: Number(b.bedrooms) || 0,
    bathrooms: Number(b.bathrooms) || 0,
    units: Number(b.units) || 1,
    strAnnualRevenue: Number(b.strAnnualRevenue) || 0,
    occupancy: Number(b.occupancy) || 0.60,
    marketType: b.marketType || 'suburban',
    record: { owner: {}, tax: {}, lastSale: {} },
    nearbyComps: [],
    scenarios: null,
    sources: []
  };

  // Step 1: RentCast property record for owner, tax, last sale
  try {
    const url = `${RENTCAST_BASE}/properties?address=${encodeURIComponent(b.address)}`;
    const r = await fetch(url, { headers: { 'X-Api-Key': RENTCAST_API_KEY, 'Accept': 'application/json' } });
    const data = await r.json();
    const p = Array.isArray(data) ? data[0] : data;
    if (r.ok && p) {
      out.record.owner = {
        name: p.owner?.names?.[0] || p.owner?.name || '',
        mailingAddress: p.owner?.mailingAddress || '',
        ownerOccupied: !!p.ownerOccupied
      };
      out.record.tax = {
        assessedValue: Number(p.taxAssessments?.[Object.keys(p.taxAssessments || {}).slice(-1)[0]]?.value) || 0,
        annualTax: 0
      };
      out.record.lastSale = {
        price: Number(p.lastSalePrice) || 0,
        date: p.lastSaleDate || ''
      };
      out.lat = Number(p.latitude) || 0;
      out.lng = Number(p.longitude) || 0;
      out.yearBuilt = Number(p.yearBuilt) || 0;
      out.sqft = Number(p.squareFootage) || 0;
      out.sources.push('rentcast');
    }
  } catch (e) {
    console.warn('[str-opp/property] RentCast lookup failed:', e.message);
  }

  // Step 2: STR Low/Mid/High scenarios
  if (out.price > 0 && out.strAnnualRevenue > 0) {
    out.scenarios = computeScenarios(
      { price: out.price, units: out.units },
      out.strAnnualRevenue,
      out.occupancy
    );
  }

  // Step 3: Nearby comp sales — search listings near same zip
  // (Reuses RentCast /listings/sale with the property's zip to surface a few
  //  recent comps. This is a best-effort feature; failure is non-fatal.)
  try {
    const zip = (b.address.match(/\b(\d{5})\b/) || [])[1];
    if (zip) {
      const comps = await rcListingsSale({ zipCode: zip, limit: 8, status: 'Sold' }, RENTCAST_API_KEY).catch(() => []);
      out.nearbyComps = comps.slice(0, 6).map(c => ({
        address: c.formattedAddress || c.address || '',
        price: Number(c.lastSalePrice || c.price) || 0,
        lastSaleDate: c.lastSaleDate || '',
        bedrooms: Number(c.bedrooms) || 0,
        bathrooms: Number(c.bathrooms) || 0,
        sqft: Number(c.squareFootage) || 0,
        propertyType: c.propertyType || ''
      }));
    }
  } catch (e) {
    console.warn('[str-opp/property] comp search failed:', e.message);
  }

  cacheSet(cacheKey, out);
  res.json(out);
});

// POST /api/str-opportunity/refine
// Body: { addresses: [...] }
// Calls the AirROI/AirDNA Rentalizer endpoint (already wired) for each address
// and returns the precise STR revenue + occupancy estimate.
// 24-hour per-address cache.
app.post('/api/str-opportunity/refine', async (req, res) => {
  const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
  if (!addresses.length) return res.status(400).json({ error: 'addresses[] required' });
  if (addresses.length > 30) return res.status(400).json({ error: 'max 30 addresses per call' });

  if (!AIRROI_API_KEY) {
    // Graceful degrade — return empty object so client knows to leave badge as ⚪
    return res.json({});
  }

  const out = {};
  // Process in parallel batches of 5 (respect AirROI rate limits)
  const BATCH = 5;
  for (let i = 0; i < addresses.length; i += BATCH) {
    const slice = addresses.slice(i, i + BATCH);
    const responses = await Promise.allSettled(slice.map(async (address) => {
      const cacheKey = `sopp-airdna-${hashKey({ a: address })}`;
      const cached = cacheGet(cacheKey, 24 * 60 * 60);
      if (cached) return { address, ...cached, cached: true };

      try {
        const params = new URLSearchParams({
          address, bedrooms: '2', baths: '2', guests: '4', currency: 'usd'
        });
        const r = await fetch(`${AIRROI_BASE}/calculator/estimate?${params}`, {
          headers: { 'x-api-key': AIRROI_API_KEY, 'Accept': 'application/json' }
        });
        if (!r.ok) return { address, error: `HTTP ${r.status}` };
        const data = await r.json();
        const d = data.data || data;
        const result = {
          adr: Math.round(Number(d.average_daily_rate || d.adr) || 0),
          occupancy: Number(d.occupancy) || 0,
          revenue: Math.round(Number(d.revenue || d.annual_revenue) || 0),
          confidence: 'verified'
        };
        cacheSet(cacheKey, result);
        return { address, ...result };
      } catch (e) {
        return { address, error: e.message };
      }
    }));
    for (const r of responses) {
      if (r.status === 'fulfilled' && r.value?.address) {
        const { address, ...payload } = r.value;
        out[address] = payload;
      }
    }
  }
  res.json(out);
});

app.use(express.static(__dirname));

// --- Start ---
app.listen(PORT, () => {
  const status = AIRDNA_API_KEY ? '✓ configured' : '✗ MISSING (set AIRDNA_API_KEY in .env)';
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║        STR Investment Analyzer               ║
  ╠══════════════════════════════════════════════╣
  ║  URL:       http://localhost:${PORT}${' '.repeat(14 - String(PORT).length)}║
  ║  AirDNA:    ${status.padEnd(33)}║
  ║  API Base:  ${AIRDNA_BASE.slice(-33).padEnd(33)}║
  ╚══════════════════════════════════════════════╝
  `);
});
