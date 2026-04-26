// Dwellsy Scraper — Playwright-based LTR rent lookup
// ============================================================================
// Scrapes Dwellsy.com search results for a given address + bedroom count,
// and emits a JSON summary: { medianRent, low, high, count, listings[] }
// ============================================================================
//
// Usage:
//   node dwellsy-scraper.mjs --address "Cleveland, OH 44113" --bedrooms 2
//
// Output (stdout, JSON):
//   { medianRent, low, high, count, listings: [{ title, url, rent, bedrooms, bathrooms, sqft, address }] }

import { chromium } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

async function scrapeDwellsy(address, bedrooms) {
  // Extract a city/zip from the address for the search query
  // Dwellsy's URL structure: https://dwellsy.com/homes-for-rent/{city-st} or ?search=<query>
  const search = address.trim();

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: USER_AGENT,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await context.newPage();

  try {
    const searchUrl = `https://dwellsy.com/search?search=${encodeURIComponent(search)}${bedrooms ? `&beds=${bedrooms}` : ''}`;
    process.stderr.write(`[dwellsy] Navigating: ${searchUrl}\n`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Detect captcha / human-verification wall
    const title = await page.title();
    const bodyPreview = await page.evaluate(() => (document.body.innerText || '').slice(0, 500));
    if (/human verification|are you human|captcha|verify you are/i.test(title + ' ' + bodyPreview)) {
      await browser.close();
      throw new Error('Dwellsy returned a human-verification / captcha challenge');
    }

    // Scroll to load more listings
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(1500);

    // Extract listing cards (selectors are fallbacks — Dwellsy's markup may change)
    const listings = await page.evaluate(() => {
      const results = [];
      const cards = [...document.querySelectorAll(
        '[data-testid="listing-card"], .listing-card, article[class*="listing"], a[href*="/listing/"], a[href*="/home/"]'
      )];
      const seen = new Set();
      for (const card of cards) {
        const root = card.closest('article, div[class*="card"], li') || card;
        const text = root.innerText || '';
        const linkEl = card.tagName === 'A' ? card : card.querySelector('a[href]');
        const url = linkEl?.href || '';
        if (url && seen.has(url)) continue;
        if (url) seen.add(url);

        const rentM = text.match(/\$\s*([\d,]+)\s*(?:\/\s*mo|\/month|\s*monthly|\s*\/mo)?/i);
        const brM = text.match(/(\d+)\s*(?:bd|bed|br)\b/i);
        const baM = text.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath)\b/i);
        const sqM = text.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft)/i);
        const rent = rentM ? parseInt(rentM[1].replace(/,/g, '')) : 0;
        if (!rent || rent < 300 || rent > 20000) continue; // sanity filter

        // Address often sits in an element with class containing 'address' or first line
        const addrEl = root.querySelector('[class*="address" i], [data-testid*="address" i]');
        const address = (addrEl?.innerText || text.split('\n')[1] || '').trim().slice(0, 140);

        const titleEl = root.querySelector('h2, h3, [class*="title" i]');
        const title = (titleEl?.innerText || address || '').trim().slice(0, 120);

        results.push({
          title,
          url,
          address,
          rent,
          bedrooms: brM ? parseInt(brM[1]) : 0,
          bathrooms: baM ? parseFloat(baM[1]) : 0,
          sqft: sqM ? parseInt(sqM[1].replace(/,/g, '')) : 0
        });
        if (results.length >= 30) break;
      }
      return results;
    });

    await browser.close();

    // Filter by bedroom count if specified
    let filtered = listings;
    if (bedrooms) {
      const br = parseInt(bedrooms);
      filtered = listings.filter(l => !l.bedrooms || l.bedrooms === br);
      if (filtered.length < 3) filtered = listings; // don't over-filter
    }

    const rents = filtered.map(l => l.rent).filter(r => r > 0);
    if (!rents.length) {
      throw new Error('No rent data extracted from Dwellsy');
    }

    return {
      medianRent: median(rents),
      low: Math.min(...rents),
      high: Math.max(...rents),
      count: filtered.length,
      listings: filtered.slice(0, 15)
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ---------- CLI ----------
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const address = getArg('--address', '');
const bedrooms = getArg('--bedrooms', '');
if (!address) {
  console.error('Usage: node dwellsy-scraper.mjs --address "Cleveland, OH" [--bedrooms 2]');
  process.exit(2);
}

scrapeDwellsy(address, bedrooms)
  .then((data) => {
    process.stdout.write(JSON.stringify(data));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[dwellsy-scraper] Error:', err.message);
    process.exit(1);
  });
