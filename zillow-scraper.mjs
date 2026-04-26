// Zillow Scraper — Playwright-based bedroom/bathroom lookup
// ============================================================================
// WARNING: Scraping Zillow may violate their Terms of Service. Use for personal
// research only. Zillow has strong bot detection (Perimeter-X) which may block
// headless requests. If blocked, the scraper will return an error — users can
// fall back to entering BR/BA manually.
// ============================================================================
//
// Usage:
//   node zillow-scraper.mjs --address "123 Main St, Austin, TX 78701"
//
// Output:
//   JSON object to stdout: { bedrooms, bathrooms, price?, sqft?, url? }

import { chromium } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function scrapeZillow(address) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: USER_AGENT,
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const page = await context.newPage();

  // Zillow accepts addresses in the path; hyphen-encoded is most reliable.
  const slug = address.trim().replace(/,/g, '').replace(/\s+/g, '-');
  const url = `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`;

  process.stderr.write(`[zillow] Navigating: ${url}\n`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Zillow sometimes redirects to /homedetails/... (a specific property),
    // other times to /homes/.../ search results. Give it a moment to settle.
    await page.waitForTimeout(2500);

    const finalUrl = page.url();
    process.stderr.write(`[zillow] Final URL: ${finalUrl}\n`);

    // Check for Perimeter-X captcha
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    if (/captcha|are you a human|press & hold/i.test(bodyText.slice(0, 2000))) {
      throw new Error('Zillow returned a captcha challenge (bot detection)');
    }

    // Strategy 1: Try the __NEXT_DATA__ blob (Zillow uses Next.js)
    const nextData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    let bedrooms = 0;
    let bathrooms = 0;
    let price = 0;
    let sqft = 0;

    let priceHistory = [];
    let yearBuilt = 0;

    if (nextData) {
      try {
        const parsed = JSON.parse(nextData);
        // Search deep for bedrooms/bathrooms keys
        const found = deepFindProperty(parsed, ['bedrooms', 'bathrooms', 'price', 'livingArea', 'yearBuilt']);
        if (found.bedrooms) bedrooms = parseFloat(found.bedrooms) || 0;
        if (found.bathrooms) bathrooms = parseFloat(found.bathrooms) || 0;
        if (found.price) price = parseFloat(found.price) || 0;
        if (found.livingArea) sqft = parseFloat(found.livingArea) || 0;
        if (found.yearBuilt) yearBuilt = parseInt(found.yearBuilt) || 0;

        // Extract price history array (Zillow embeds it under propertyDetails / priceHistory)
        priceHistory = deepFindArray(parsed, 'priceHistory')
          .map(ev => ({
            date: ev.date || ev.time || '',
            price: Number(ev.price) || 0,
            event: ev.event || ev.eventDescription || '',
            source: ev.source || 'Zillow',
            pricePerSqFt: Number(ev.pricePerSquareFoot) || 0
          }))
          .filter(ev => ev.price > 0 || ev.event);
      } catch (e) {
        process.stderr.write(`[zillow] __NEXT_DATA__ parse failed: ${e.message}\n`);
      }
    }

    // Strategy 2: Regex scan of visible page text
    if (!bedrooms || !bathrooms) {
      // Zillow formats: "3 bds", "3 beds", "2 ba", "2.5 baths"
      const brMatch = bodyText.match(/(\d+(?:\.\d+)?)\s*(?:bds?|beds?|bedrooms?)\b/i);
      if (brMatch && !bedrooms) bedrooms = parseFloat(brMatch[1]);

      const baMatch = bodyText.match(/(\d+(?:\.\d+)?)\s*(?:ba\b|baths?|bathrooms?)/i);
      if (baMatch && !bathrooms) bathrooms = parseFloat(baMatch[1]);
    }

    // Strategy 3: structured fact list (summary card)
    if (!bedrooms || !bathrooms) {
      const factsText = await page
        .evaluate(() => {
          const sel = document.querySelector(
            '[data-testid="bed-bath-beyond"], [data-testid="home-facts-summary"]'
          );
          return sel ? sel.innerText : '';
        })
        .catch(() => '');
      if (factsText) {
        const brM = factsText.match(/(\d+(?:\.\d+)?)\s*(?:bds?|beds?)/i);
        const baM = factsText.match(/(\d+(?:\.\d+)?)\s*(?:ba|baths?)/i);
        if (brM && !bedrooms) bedrooms = parseFloat(brM[1]);
        if (baM && !bathrooms) bathrooms = parseFloat(baM[1]);
      }
    }

    await browser.close();

    if (!bedrooms && !bathrooms && !priceHistory.length) {
      throw new Error('Could not extract BR/BA or price history from Zillow page');
    }

    return { bedrooms, bathrooms, price, sqft, yearBuilt, priceHistory, url: finalUrl };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// Recursively find the first array value for a named key, anywhere in the tree
function deepFindArray(obj, targetKey) {
  const stack = [obj];
  const seen = new WeakSet();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const k of Object.keys(cur)) {
      if (k === targetKey && Array.isArray(cur[k]) && cur[k].length) {
        // Prefer arrays of objects with date/price/event shape
        if (typeof cur[k][0] === 'object') return cur[k];
      }
      if (cur[k] && typeof cur[k] === 'object') stack.push(cur[k]);
    }
  }
  return [];
}

// Recursively find the first occurrence of each requested key in a nested object
function deepFindProperty(obj, keys) {
  const result = {};
  const remaining = new Set(keys);
  const stack = [obj];
  const seen = new WeakSet();

  while (stack.length && remaining.size) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    for (const k of Object.keys(cur)) {
      if (remaining.has(k) && (typeof cur[k] === 'number' || typeof cur[k] === 'string')) {
        result[k] = cur[k];
        remaining.delete(k);
      }
      if (cur[k] && typeof cur[k] === 'object') stack.push(cur[k]);
    }
  }
  return result;
}

// ---------- CLI entry ----------
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const address = getArg('--address', '');

if (!address) {
  console.error('Usage: node zillow-scraper.mjs --address "123 Main St, Austin, TX"');
  process.exit(2);
}

scrapeZillow(address)
  .then((data) => {
    process.stdout.write(JSON.stringify(data));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[zillow] Error:', err.message);
    process.exit(1);
  });
