// Airbnb Scraper — Playwright-based fallback for when AirDNA API is unavailable
// ============================================================================
// WARNING: Scraping Airbnb may violate their Terms of Service. This script is
// provided for personal research / market analysis only. Use at your own risk.
// Rate-limited; uses a realistic user agent and waits for dynamic content.
// ============================================================================
//
// Usage:
//   node scraper.mjs --address "Austin, TX" [--count 12]
//
// Output:
//   JSON array of comp objects printed to stdout (for consumption by server.mjs)

import { chromium } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function scrapeAirbnb(address, count) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: USER_AGENT,
    locale: 'en-US',
  });

  const page = await context.newPage();

  // Airbnb search URL — they accept a human-readable query in the path segment.
  const query = encodeURIComponent(address).replace(/%20/g, '-');
  const url = `https://www.airbnb.com/s/${query}/homes`;

  process.stderr.write(`[scraper] Navigating: ${url}\n`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for listing cards to render (data-testid selector is stable on Airbnb)
    await page
      .waitForSelector('[data-testid="card-container"], [itemprop="itemListElement"]', {
        timeout: 20000,
      })
      .catch(() => {
        process.stderr.write('[scraper] No card-container selector found; trying fallback.\n');
      });

    // Scroll a bit to trigger lazy-loading
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1500);

    const listings = await page.evaluate((max) => {
      // Try both selectors
      let cards = Array.from(document.querySelectorAll('[data-testid="card-container"]'));
      if (!cards.length) {
        cards = Array.from(document.querySelectorAll('[itemprop="itemListElement"]'));
      }
      cards = cards.slice(0, max);

      return cards.map((card) => {
        const text = card.innerText || '';
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

        // Link to the listing
        const linkEl = card.querySelector('a[href*="/rooms/"]');
        const href = linkEl ? linkEl.href : '';
        const listingId = href.match(/\/rooms\/(\d+)/)?.[1] || '';

        // Title: usually the first non-empty line or an h3-ish element
        const title =
          card.querySelector('[data-testid="listing-card-title"]')?.innerText ||
          card.querySelector('[data-testid="listing-card-name"]')?.innerText ||
          lines[0] ||
          'Airbnb listing';

        // Price: look for a $ followed by digits, often near "night" or "total"
        // Prefer "per night" match; fall back to first $-amount.
        let adr = 0;
        const perNightMatch = text.match(/\$(\d[\d,]*)\s*(?:x|per|\/|\s)?\s*night/i);
        if (perNightMatch) {
          adr = parseInt(perNightMatch[1].replace(/,/g, ''));
        } else {
          const dollarMatch = text.match(/\$(\d[\d,]*)/);
          if (dollarMatch) adr = parseInt(dollarMatch[1].replace(/,/g, ''));
        }

        // Bedrooms: "2 bedrooms", "1 bedroom", or "Studio"
        let br = 0;
        if (/\bstudio\b/i.test(text)) {
          br = 0;
        } else {
          const brMatch = text.match(/(\d+(?:\.\d+)?)\s*bed(?:room)?s?\b/i);
          if (brMatch) br = parseFloat(brMatch[1]);
          else {
            // Just "beds" (single-room count)
            const bedsMatch = text.match(/(\d+)\s*beds?\b/i);
            if (bedsMatch) br = parseFloat(bedsMatch[1]);
          }
        }

        // Bathrooms: "1.5 baths", "2 bathrooms"
        let ba = 0;
        const baMatch = text.match(/(\d+(?:\.\d+)?)\s*bath(?:room)?s?\b/i);
        if (baMatch) ba = parseFloat(baMatch[1]);

        // Guests / accommodates
        let sleeps = 0;
        const guestsMatch = text.match(/(\d+)\s*guest/i);
        if (guestsMatch) sleeps = parseInt(guestsMatch[1]);

        // Reviews count: often in parens next to a star rating, e.g. "4.92 (128)"
        let reviews = 0;
        const reviewMatch = text.match(/\(\s*(\d+)\s*\)/);
        if (reviewMatch) reviews = parseInt(reviewMatch[1]);
        // Alternate: "X reviews"
        if (!reviews) {
          const altReview = text.match(/(\d+)\s*reviews?/i);
          if (altReview) reviews = parseInt(altReview[1]);
        }

        // Star rating (for logging / optional use)
        const ratingMatch = text.match(/(\d\.\d+)\s*(?:\(|\s)/);
        const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

        return {
          source: href || title,
          listingId,
          title,
          adr,
          occ: 0, // Not available from search page — user can fill in
          br,
          ba,
          sleeps,
          daysAvail: 0,
          reviews,
          rating,
          revenue: 0, // Not available from search page
        };
      });
    }, count);

    await browser.close();

    // Filter out rows with no ADR (parsing failures)
    return listings.filter((l) => l.adr > 0);
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ---------- CLI entry ----------
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const address = getArg('--address', '');
const count = parseInt(getArg('--count', '12'));

if (!address) {
  console.error('Usage: node scraper.mjs --address "Austin, TX" [--count 12]');
  process.exit(2);
}

scrapeAirbnb(address, count)
  .then((listings) => {
    // Print JSON to stdout — server.mjs parses this
    process.stdout.write(JSON.stringify(listings));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[scraper] Error:', err.message);
    process.exit(1);
  });
