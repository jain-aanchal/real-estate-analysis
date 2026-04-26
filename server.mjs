// STR Investment Analyzer — AirDNA Proxy Server
// Serves static index.html and proxies AirDNA Enterprise API calls,
// keeping the API key server-side.

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
    redfin_available: true,
    scraper_installed: playwrightInstalled,
    zillow_available: playwrightInstalled,
    base: AIRDNA_BASE
  });
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
        // Build a clean US address string
        const parts = [];
        if (a.house_number && a.road) parts.push(`${a.house_number} ${a.road}`);
        else if (a.road) parts.push(a.road);
        if (a.city || a.town || a.village) parts.push(a.city || a.town || a.village);
        if (a.state) parts.push(a.state);
        if (a.postcode) parts.push(a.postcode);
        const address = parts.length >= 2 ? parts.join(', ') : item.display_name.split(',').slice(0, 4).join(',');
        return {
          address,
          fullDisplay: item.display_name,
          type: item.type || item.class || ''
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
