// Listing Scraper — extracts price + property details from a listing URL
// =============================================================================
// Supports: Redfin, Zillow, Realtor.com, MLS-style URLs. Falls back to
// generic OpenGraph / JSON-LD extraction for unknown hosts.
//
// Usage:
//   node listing-scraper.mjs --url "https://www.redfin.com/CA/Redwood-City/..."
// Output:
//   JSON: { price, bedrooms, bathrooms, sqft, address, yearBuilt, source, url }
// =============================================================================

import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function detectHost(url) {
  const u = url.toLowerCase();
  if (u.includes('redfin.com')) return 'redfin';
  if (u.includes('zillow.com')) return 'zillow';
  if (u.includes('realtor.com')) return 'realtor';
  if (u.includes('trulia.com')) return 'trulia';
  if (u.includes('homes.com')) return 'homes';
  if (u.includes('airbnb.com')) return 'airbnb';
  return 'generic';
}

function deepFind(obj, keys) {
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

async function scrape(url) {
  const host = detectHost(url);
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await ctx.newPage();

  try {
    // For Redfin direct URLs, CloudFront often 403s. Land at redfin.com first
    // to pick up cookies, then navigate to the property URL.
    if (host === 'redfin') {
      await page.goto('https://www.redfin.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    const finalUrl = page.url();
    process.stderr.write(`[listing] host=${host} finalUrl=${finalUrl}\n`);

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    if (/captcha|are you a human|press & hold/i.test(bodyText.slice(0, 2000))) {
      throw new Error(`${host} returned a captcha challenge`);
    }

    let price = 0, bedrooms = 0, bathrooms = 0, sqft = 0, yearBuilt = 0, address = '';
    let hoaMonthly = 0, taxAnnual = 0, taxRate = 0;

    // ---- Strategy 1: __NEXT_DATA__ (Zillow / Redfin / many Next.js sites) ----
    const nextData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    if (nextData) {
      try {
        const parsed = JSON.parse(nextData);
        const f = deepFind(parsed, [
          'price', 'listPrice', 'listingPrice', 'priceForHDP', 'currentPrice',
          'bedrooms', 'beds', 'numBedrooms',
          'bathrooms', 'baths', 'numBathrooms',
          'livingArea', 'sqFt', 'finishedSqFt', 'squareFootage',
          'yearBuilt', 'streetAddress',
          // HOA + tax fields (Zillow / Redfin variants)
          'monthlyHoaFee', 'monthlyHoaDues', 'hoaFee', 'hoaFees', 'hoa',
          'propertyTaxes', 'propertyTax', 'taxAmount', 'taxAnnualAmount',
          'taxAssessmentYear', 'propertyTaxRate', 'taxRate'
        ]);
        price = parseFloat(f.price || f.listPrice || f.listingPrice || f.priceForHDP || f.currentPrice) || 0;
        bedrooms = parseFloat(f.bedrooms || f.beds || f.numBedrooms) || 0;
        bathrooms = parseFloat(f.bathrooms || f.baths || f.numBathrooms) || 0;
        sqft = parseFloat(f.livingArea || f.sqFt || f.finishedSqFt || f.squareFootage) || 0;
        yearBuilt = parseInt(f.yearBuilt) || 0;
        address = f.streetAddress || '';
        hoaMonthly = parseFloat(f.monthlyHoaFee || f.monthlyHoaDues || f.hoaFee || f.hoaFees || f.hoa) || 0;
        taxAnnual = parseFloat(f.propertyTaxes || f.propertyTax || f.taxAmount || f.taxAnnualAmount) || 0;
        taxRate = parseFloat(f.propertyTaxRate || f.taxRate) || 0;
      } catch (e) {
        process.stderr.write(`[listing] __NEXT_DATA__ parse failed: ${e.message}\n`);
      }
    }

    // ---- Strategy 2: JSON-LD <script type="application/ld+json"> ----
    if (!price || !bedrooms) {
      const jsonLd = await page.evaluate(() => {
        const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
        return blocks.map(b => b.textContent).filter(Boolean);
      });
      for (const raw of jsonLd) {
        try {
          const data = JSON.parse(raw);
          const items = Array.isArray(data) ? data : [data];
          for (const it of items) {
            const f = deepFind(it, ['price', 'numberOfRooms', 'numberOfBedrooms', 'numberOfBathroomsTotal',
                                     'floorSize', 'streetAddress']);
            if (!price && f.price) price = parseFloat(f.price) || 0;
            if (!bedrooms && (f.numberOfBedrooms || f.numberOfRooms))
              bedrooms = parseInt(f.numberOfBedrooms || f.numberOfRooms) || 0;
            if (!bathrooms && f.numberOfBathroomsTotal)
              bathrooms = parseFloat(f.numberOfBathroomsTotal) || 0;
            if (!sqft && f.floorSize) sqft = parseFloat(String(f.floorSize).replace(/[^\d]/g, '')) || 0;
            if (!address && f.streetAddress) address = f.streetAddress;
          }
        } catch {}
      }
    }

    // ---- Strategy 3: Redfin's belowTheFold endpoint (for richer data) ----
    if (host === 'redfin') {
      const idMatch = finalUrl.match(/\/home\/(\d+)/);
      if (idMatch) {
        try {
          const btf = await page.evaluate(async (pid) => {
            const r = await fetch(`https://www.redfin.com/stingray/api/home/details/aboveTheFold?propertyId=${pid}&accessLevel=1`, { credentials: 'include' });
            if (!r.ok) return null;
            return (await r.text()).replace(/^\{\}&&/, '');
          }, idMatch[1]);
          if (btf) {
            const parsed = JSON.parse(btf);
            const info = parsed?.payload?.addressSectionInfo
              || parsed?.payload?.publicRecordsInfo?.basicInfo
              || {};
            if (!price) {
              price = Number(info.priceInfo?.amount?.value || info.priceInfo?.price?.value
                          || info.listingPrice || info.estimate?.value) || 0;
            }
            if (!bedrooms) bedrooms = Number(info.beds || info.numBeds || info.bedrooms) || 0;
            if (!bathrooms) bathrooms = Number(info.baths || info.numBaths || info.totalBaths) || 0;
            if (!sqft) sqft = Number(info.sqFt?.value || info.sqFt || info.finishedSqFt) || 0;
            if (!yearBuilt) yearBuilt = Number(info.yearBuilt?.value || info.yearBuilt) || 0;
            if (!address && info.streetAddress) {
              const sa = info.streetAddress;
              address = sa.assembledAddress || sa.streetNumberAndName || sa.streetAddress
                      || `${sa.streetNumber || ''} ${sa.streetName || ''}`.trim();
            }
            // Redfin HOA + tax (in aboveTheFold or publicRecordsInfo)
            if (!hoaMonthly) {
              hoaMonthly = Number(info.hoaDues?.value || info.hoaDues || info.monthlyHoaDues?.value
                          || info.monthlyHoaDues || info.hoaFee?.value || info.hoaFee) || 0;
            }
            const taxInfo = parsed?.payload?.publicRecordsInfo?.taxInfo
                         || parsed?.payload?.publicRecordsInfo?.basicInfo?.taxInfo
                         || info.taxInfo
                         || {};
            if (!taxAnnual) {
              taxAnnual = Number(taxInfo.taxableLandValue?.value || taxInfo.taxesDue?.value
                        || taxInfo.taxesDue || info.propertyTaxes?.value
                        || info.propertyTaxes) || 0;
            }
          }
        } catch (e) {
          process.stderr.write(`[listing] Redfin aboveTheFold failed: ${e.message}\n`);
        }
      }
    }

    // ---- Strategy 4: OpenGraph + regex on body text (final fallback) ----
    if (!price) {
      const og = await page.evaluate(() => {
        const m = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
        return {
          ogPrice: m('meta[property="product:price:amount"], meta[property="og:price:amount"], meta[name="price"]'),
          title: m('meta[property="og:title"]'),
          desc: m('meta[property="og:description"]')
        };
      });
      if (og.ogPrice) price = parseFloat(og.ogPrice.replace(/[^\d.]/g, '')) || 0;
      // Title/desc often contain "$3,250,000" — try to extract a price-shaped number
      if (!price) {
        const combined = `${og.title} ${og.desc} ${bodyText.slice(0, 2000)}`;
        // Match prices with at least one comma (i.e. >= $1,000)
        const priceM = combined.match(/\$\s*([\d]{1,3}(?:,\d{3})+)/);
        if (priceM) price = parseInt(priceM[1].replace(/,/g, '')) || 0;
      }
    }
    if (!bedrooms || !bathrooms) {
      const brM = bodyText.match(/(\d+(?:\.\d+)?)\s*(?:bd|beds?|bedrooms?)/i);
      const baM = bodyText.match(/(\d+(?:\.\d+)?)\s*(?:ba\b|baths?|bathrooms?)/i);
      if (brM && !bedrooms) bedrooms = parseFloat(brM[1]);
      if (baM && !bathrooms) bathrooms = parseFloat(baM[1]);
    }

    // ---- HOA / tax from body text (final fallback) ----
    // Normalize: collapse whitespace so labels and $-values that span DOM
    // boundaries (newlines, tabs) appear as adjacent tokens.
    const flatBody = bodyText.replace(/\s+/g, ' ');

    if (!hoaMonthly) {
      const candidates = [
        // "HOA Dues $250/month", "Monthly HOA: $325", "$425/month HOA"
        /(?:HOA\s*(?:Dues|Fee)?s?|Monthly\s*HOA|Homeowners?\s*Association)\s*[:\-]?\s*\$\s*([\d,]+)\s*(?:\/?\s*(?:mo(?:nth)?|monthly))?/i,
        /\$\s*([\d,]+)\s*\/\s*month\s*HOA/i,
        // Label-first with small gap (label, then any text up to 30 chars, then $X)
        /(?:HOA(?:\s+(?:Dues|Fee))?|Monthly\s*HOA|Homeowners?\s*Association)[^$]{0,30}\$\s*([\d,]+)/i,
        // Redfin's mortgage breakdown often shows "HOA / Condo Fee $X"
        /HOA\s*\/?\s*Condo\s*(?:Fee)?[^$]{0,30}\$\s*([\d,]+)/i
      ];
      for (const re of candidates) {
        const m = flatBody.match(re);
        if (m) { hoaMonthly = parseInt(m[1].replace(/,/g, '')); break; }
      }
    }

    if (!taxAnnual) {
      const candidates = [
        // "Annual Tax $4,250", "Property Taxes $4,250/year"
        /(?:Annual\s+)?Property\s+Tax(?:es)?\s*[:\-]?\s*\$\s*([\d,]+)/i,
        /Tax(?:es)?\s*[:\-]?\s*\$\s*([\d,]+)\s*\/\s*(?:yr|year|annually)/i,
        /Annual\s+Tax(?:es)?\s*[:\-]?\s*\$\s*([\d,]+)/i,
        // Label-then-near $ (handles "Property tax" + newline + "$3,500/year")
        /Property\s+Tax(?:es)?[^$]{0,40}\$\s*([\d,]+)/i,
        /Tax\s+Amount[^$]{0,30}\$\s*([\d,]+)/i,
        // Redfin's mortgage breakdown ("Property taxes" line item, monthly $)
        /Property\s+Tax(?:es)?[^$]{0,30}\$\s*([\d,]+)\s*\/\s*mo/i
      ];
      for (const re of candidates) {
        const m = flatBody.match(re);
        if (m) {
          const v = parseInt(m[1].replace(/,/g, ''));
          // Heuristic: if pattern matched a monthly value (re ends with /mo), annualize
          if (/\/\s*mo/.test(re.source) && v < 20000) taxAnnual = v * 12;
          else taxAnnual = v;
          break;
        }
      }
    }

    // Derive annual % rate from $ tax and price (or vice versa)
    if (!taxRate && taxAnnual && price) {
      taxRate = +((taxAnnual / price) * 100).toFixed(3);
    } else if (!taxAnnual && taxRate && price) {
      taxAnnual = Math.round(price * (taxRate / 100));
    }
    if (!address) {
      const og = await page.evaluate(() => document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '');
      // Often the title is "123 Main St, Austin, TX 78701 | Redfin"
      const m = og.match(/^([^|]+?)\s*[|·\-]\s*/) || og.match(/^([^,]+,[^,]+,\s*[A-Z]{2}\s*\d*)/);
      if (m) address = m[1].trim();
    }

    await browser.close();

    if (!price && !bedrooms && !bathrooms && !hoaMonthly && !taxAnnual) {
      throw new Error(`Could not extract listing info from ${host}`);
    }

    return {
      price, bedrooms, bathrooms, sqft, yearBuilt, address,
      hoaMonthly, taxAnnual, taxRate,
      source: host, url: finalUrl
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ---- CLI ----
const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : '';
}
const url = getArg('--url');
if (!url) {
  console.error('Usage: node listing-scraper.mjs --url "<listing URL>"');
  process.exit(2);
}

scrape(url)
  .then((data) => { process.stdout.write(JSON.stringify(data)); process.exit(0); })
  .catch((err) => { console.error('[listing-scraper] Error:', err.message); process.exit(1); });
