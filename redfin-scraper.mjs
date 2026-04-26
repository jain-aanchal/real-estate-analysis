// Redfin Scraper — Playwright-based bedroom/bathroom lookup
// ============================================================================
// Uses a real Chromium browser to visit Redfin's property page and extract
// BR/BA from the rendered page. More reliable than Redfin's public JSON
// endpoints which rate-limit server-side fetch requests.
// ============================================================================
//
// Usage:
//   node redfin-scraper.mjs --address "980 Governors Bay Dr, Redwood City, CA"
//
// Output:
//   JSON object to stdout: { bedrooms, bathrooms, sqft?, price?, yearBuilt?, url }

import { chromium } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function scrapeRedfin(address) {
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

  // Go to Redfin search with the address
  const searchUrl = `https://www.redfin.com/search#query=${encodeURIComponent(address)}`;
  process.stderr.write(`[redfin] Navigating: ${searchUrl}\n`);

  try {
    await page.goto(`https://www.redfin.com`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);

    // Use the search box
    const searchInput = await page.$('input#search-box-input, input[data-testid="search-box-input"], input[placeholder*="address"]');
    if (searchInput) {
      await searchInput.click();
      await searchInput.fill(address);
      await page.waitForTimeout(1500);

      // Wait for autocomplete suggestions
      const suggestion = await page.$('.SearchBoxAutocomplete .item-row:first-child, [data-testid="searchSuggestion"]:first-child, .suggestItem:first-child');
      if (suggestion) {
        await suggestion.click();
        await page.waitForTimeout(3000);
      } else {
        // Press Enter to search
        await searchInput.press('Enter');
        await page.waitForTimeout(4000);
      }
    } else {
      // Fallback: navigate directly to search URL
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    const finalUrl = page.url();
    process.stderr.write(`[redfin] Final URL: ${finalUrl}\n`);

    // Check if we landed on a property detail page
    const bodyText = await page.evaluate(() => document.body.innerText || '');

    let bedrooms = 0;
    let bathrooms = 0;
    let sqft = 0;
    let price = 0;
    let yearBuilt = 0;

    // Strategy 1: Look for the stats/facts bar (e.g., "4 Beds • 3 Baths • 2,450 Sq Ft")
    const statsText = await page.evaluate(() => {
      const selectors = [
        '.HomeMainStats', '.home-main-stats-variant',
        '[data-rf-test-id="abp-homeinfo"]', '.HomeInfo',
        '.statsValue', '.stat-block'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.length > 3) return el.innerText;
      }
      // Fallback: look in the top section
      const header = document.querySelector('.aboveTheFold, .above-the-fold, header');
      return header ? header.innerText.slice(0, 1000) : '';
    }).catch(() => '');

    if (statsText) {
      const brM = statsText.match(/(\d+)\s*(?:Beds?|beds?|BR|Bedrooms?)/i);
      const baM = statsText.match(/(\d+(?:\.\d+)?)\s*(?:Baths?|baths?|BA|Bathrooms?)/i);
      const sqM = statsText.match(/([\d,]+)\s*(?:Sq\.?\s*Ft|sqft|sq ft|square feet)/i);
      if (brM) bedrooms = parseInt(brM[1]);
      if (baM) bathrooms = parseFloat(baM[1]);
      if (sqM) sqft = parseInt(sqM[1].replace(/,/g, ''));
    }

    // Strategy 2: Regex on full page text
    if (!bedrooms || !bathrooms) {
      const brM2 = bodyText.match(/(\d+)\s*(?:Beds?|beds?|BR|Bedrooms?)\b/);
      const baM2 = bodyText.match(/(\d+(?:\.\d+)?)\s*(?:Baths?|baths?|BA|Bathrooms?)\b/);
      if (brM2 && !bedrooms) bedrooms = parseInt(brM2[1]);
      if (baM2 && !bathrooms) bathrooms = parseFloat(baM2[1]);
    }

    // Strategy 3: Try __NEXT_DATA__ or script-injected JSON
    if (!bedrooms || !bathrooms) {
      const scriptData = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll('script')];
        for (const s of scripts) {
          const t = s.textContent || '';
          if (t.includes('"beds"') || t.includes('"numBedrooms"')) {
            return t.slice(0, 50000);
          }
        }
        return '';
      }).catch(() => '');

      if (scriptData) {
        const bedsM = scriptData.match(/"(?:beds|numBedrooms|bedrooms?)"\s*:\s*(\d+)/);
        const bathsM = scriptData.match(/"(?:baths|numBathrooms|bathrooms?)"\s*:\s*([\d.]+)/);
        if (bedsM && !bedrooms) bedrooms = parseInt(bedsM[1]);
        if (bathsM && !bathrooms) bathrooms = parseFloat(bathsM[1]);
      }
    }

    // Extract price
    const priceMatch = bodyText.match(/\$\s*([\d,]+(?:,\d{3})+)/);
    if (priceMatch) price = parseInt(priceMatch[1].replace(/,/g, ''));

    // Year built
    const ybMatch = bodyText.match(/(?:Year Built|Built in|Built)\s*:?\s*((?:19|20)\d{2})/i);
    if (ybMatch) yearBuilt = parseInt(ybMatch[1]);

    // ---------------- Property History (sales) ----------------
    // Redfin lazy-loads the "Property History" section on scroll. Trigger it.
    try {
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollBy(0, 2500));
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollBy(0, 2500));
      await page.waitForTimeout(1500);
      // Try clicking "See all property history" expand if present
      const expand = await page.$('button:has-text("See all property history"), button[aria-label*="property history" i], button:has-text("See more")');
      if (expand) { await expand.click().catch(() => {}); await page.waitForTimeout(1500); }
    } catch {}

    let priceHistory = [];

    // Strategy A: look for propertyHistoryInfo in any script tag
    const scriptJson = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script')];
      for (const s of scripts) {
        const t = s.textContent || '';
        if (t.includes('propertyHistoryInfo') || t.includes('"events"') && t.includes('"eventDescription"')) {
          return t;
        }
      }
      return '';
    }).catch(() => '');

    if (scriptJson) {
      // Find the events array via a non-greedy bracket-scan after `"events":[`
      const idx = scriptJson.indexOf('"events":');
      if (idx >= 0) {
        const after = scriptJson.slice(idx);
        const arrStart = after.indexOf('[');
        if (arrStart >= 0) {
          let depth = 0, end = -1;
          for (let i = arrStart; i < after.length; i++) {
            if (after[i] === '[') depth++;
            else if (after[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
          }
          if (end > 0) {
            try {
              const arr = JSON.parse(after.slice(arrStart, end));
              if (Array.isArray(arr)) {
                priceHistory = arr.map(ev => ({
                  date: (ev.eventDate && ev.eventDate.value) || ev.eventDate || ev.date || '',
                  price: Number(ev.price?.value || ev.price) || 0,
                  event: ev.eventDescription || ev.event || '',
                  source: (ev.source && ev.source.value) || ev.source || 'Redfin',
                  pricePerSqFt: Number(ev.pricePerSqFt?.value || ev.pricePerSqFt) || 0
                })).filter(ev => ev.date || ev.price > 0);
              }
            } catch (e) {
              process.stderr.write(`[redfin] events parse failed: ${e.message}\n`);
            }
          }
        }
      }
    }

    // Strategy B: scrape visible history rows. Redfin uses a mix of <tr> and
    // role="row" divs under a section titled "Property History" / "Sale & Tax History".
    if (!priceHistory.length) {
      priceHistory = await page.evaluate(() => {
        const rows = [];
        const seen = new Set();
        const dateRe = /\b(?:\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})\b/i;
        const priceRe = /\$\s*([\d,]+)/;
        const eventRe = /\b(Sold|Listed|Listing (?:removed|updated|added)|Price (?:decreased|increased|changed)|Relisted|Pending|Contingent|Delisted|Contingency removed|Back on market|Public Record)\b/i;

        // Scan every table row and ARIA row on the page
        const candidates = [...document.querySelectorAll('tr, [role="row"]')];
        for (const r of candidates) {
          const text = (r.innerText || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length < 6) continue;
          const dM = text.match(dateRe);
          const pM = text.match(priceRe);
          const eM = text.match(eventRe);
          // Require at least date+event or date+price
          if (!dM) continue;
          if (!eM && !pM) continue;
          const key = `${dM[0]}|${pM ? pM[1] : ''}|${eM ? eM[1] : ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({
            date: dM[0],
            price: pM ? parseInt(pM[1].replace(/,/g, '')) : 0,
            event: eM ? eM[1] : '',
            source: 'Redfin',
            pricePerSqFt: 0
          });
        }
        return rows;
      }).catch(() => []);
    }

    // Strategy C: Call Redfin's belowTheFold JSON endpoint for priceHistory
    // This requires propertyId which we can parse from the final URL: /home/12345
    if (!priceHistory.length) {
      const idMatch = finalUrl.match(/\/home\/(\d+)/);
      if (idMatch) {
        const pid = idMatch[1];
        try {
          const btfUrl = `https://www.redfin.com/stingray/api/home/details/belowTheFold?propertyId=${pid}&accessLevel=1`;
          const json = await page.evaluate(async (u) => {
            try {
              const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
              if (!r.ok) return null;
              const txt = await r.text();
              return txt.replace(/^\{\}&&/, '');
            } catch { return null; }
          }, btfUrl);
          if (json) {
            const parsed = JSON.parse(json);
            const events = parsed?.payload?.propertyHistoryInfo?.events || [];
            process.stderr.write(`[redfin] belowTheFold events: ${events.length}\n`);
            if (events.length) {
              const fmtDate = (d) => {
                if (!d) return '';
                if (typeof d === 'object') {
                  return d.formatted || d.value || '';
                }
                // Unix milliseconds → YYYY-MM-DD
                if (typeof d === 'number' && d > 1e11) {
                  return new Date(d).toISOString().slice(0, 10);
                }
                return String(d);
              };
              priceHistory = events.map(ev => ({
                date: fmtDate(ev.eventDate),
                price: Number(ev.price?.value || ev.price) || 0,
                event: ev.eventDescription || '',
                source: ev.source || 'Redfin',
                pricePerSqFt: Number(ev.pricePerSqFt?.value || ev.pricePerSqFt) || 0
              })).filter(ev => ev.date || ev.price > 0);
            }
          }
        } catch (e) {
          process.stderr.write(`[redfin] belowTheFold failed: ${e.message}\n`);
        }
      }
    }

    // Diagnostic if still empty: report what headings/tables were on the page
    if (!priceHistory.length) {
      const diag = await page.evaluate(() => {
        const body = (document.body.innerText || '').slice(0, 300);
        const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map(h => h.innerText.trim()).filter(h => h && h.length < 80).slice(0, 12);
        return { bodyLen: body.length, headings };
      }).catch(() => null);
      process.stderr.write(`[redfin] no priceHistory found. diag: ${JSON.stringify(diag)}\n`);
    }

    await browser.close();

    if (!bedrooms && !bathrooms && !priceHistory.length) {
      throw new Error('Could not extract BR/BA or sales history from Redfin page');
    }

    return { bedrooms, bathrooms, sqft, price, yearBuilt, priceHistory, url: finalUrl };
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

if (!address) {
  console.error('Usage: node redfin-scraper.mjs --address "980 Governors Bay Dr, Redwood City, CA"');
  process.exit(2);
}

scrapeRedfin(address)
  .then((data) => {
    process.stdout.write(JSON.stringify(data));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[redfin-scraper] Error:', err.message);
    process.exit(1);
  });
