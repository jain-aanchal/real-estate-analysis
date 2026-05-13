// Auction listings scraper — Auction.com (Hubzu/Xome planned)
// =============================================================================
// Pulls REAL distressed-property listings (auctions, bank-owned, foreclosures)
// from Auction.com's public search pages. Returns structured property objects
// shaped to match /api/distressed/search's expected response.
//
// Coverage: all 50 US states. Auction.com is the largest online distressed
// real-estate auction platform in the US (~30k-100k active listings depending
// on market conditions).
//
// NOTE: Scraping may violate Auction.com's ToS. Use for personal research only.
// =============================================================================

import { withBrowser } from './state-handlers/_shared.mjs';

// Map US state name → 2-letter code so we can route "San Mateo, CA" or "California"
// either to /residential/CA/ or /residential/CA/san-mateo/.
const STATE_CODES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY'
};

function normalizeState(s) {
  if (!s) return '';
  const upper = s.trim().toUpperCase();
  if (upper.length === 2) return upper;
  return STATE_CODES[s.toLowerCase().trim()] || '';
}

function buildAuctionUrl({ city, state, zip }) {
  const stateCode = normalizeState(state);
  if (zip) return `https://www.auction.com/residential/?zipCode=${zip}`;
  if (city && stateCode) {
    const slug = city.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `https://www.auction.com/residential/${stateCode}/${slug}/`;
  }
  if (stateCode) return `https://www.auction.com/residential/${stateCode}/`;
  return `https://www.auction.com/residential/`;
}

// Address from the detail URL slug — clean and reliable.
// `/details/1519-w-sonoma-ave-stockton-ca-2050229` →
//   "1519 W Sonoma Ave, Stockton, CA"
function addressFromUrl(detailUrl) {
  if (!detailUrl) return '';
  const m = detailUrl.match(/\/details\/([\w-]+)/);
  if (!m) return '';
  let parts = m[1].split('-');
  // Trim trailing numeric listing ID
  while (parts.length && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
  if (parts.length < 4) return '';
  // Last token is the 2-letter state, the one before is city (often multi-word)
  const stateCode = parts.pop().toUpperCase();
  // City: walk backwards taking 1-3 tokens until the rest looks like a street
  // (street ends with a common suffix like "ave/st/rd/blvd"). For simplicity,
  // assume city is 1 token; refine with a known suffix list.
  const STREET_SUFFIXES = new Set(['st', 'street', 'ave', 'avenue', 'rd', 'road',
    'blvd', 'boulevard', 'dr', 'drive', 'ln', 'lane', 'ct', 'court', 'way',
    'pl', 'place', 'ter', 'terrace', 'hwy', 'highway', 'pkwy', 'cir', 'circle',
    'trl', 'trail', 'sq', 'sqr']);
  // Find the index of the last street suffix
  let suffixIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (STREET_SUFFIXES.has(parts[i].toLowerCase())) { suffixIdx = i; break; }
  }
  let street = [], city = [];
  if (suffixIdx >= 0) {
    street = parts.slice(0, suffixIdx + 1);
    city = parts.slice(suffixIdx + 1);
  } else {
    // No recognized suffix — last 1-2 tokens are city, rest is street
    city = parts.slice(-1);
    street = parts.slice(0, -1);
  }
  if (!street.length || !city.length) return '';

  // Title-case helper
  const tc = (w) => w.length <= 2 ? w.toUpperCase() : (w[0].toUpperCase() + w.slice(1).toLowerCase());
  return `${street.map(tc).join(' ')}, ${city.map(tc).join(' ')}, ${stateCode}`;
}

// Parse a single auction.com listing card.
// Card text:
//   "Ends in 2 days\n$145,000\nCurrent Bid\n2 bd\n1 ba\n903 sq. ft.\n1519 W Sonoma Ave, Stockton, CA 95204\nBank Owned"
function parseListingCard(card) {
  const text = (card.text || '').replace(/\s+/g, ' ');
  const priceMatch = text.match(/\$\s*([\d,]+)/);
  const brMatch = text.match(/(\d+(?:\.\d+)?)\s*bd\b/i);
  const baMatch = text.match(/(\d+(?:\.\d+)?)\s*ba\b/i);
  const sqftMatch = text.match(/([\d,]+)\s*sq\.?\s*ft\b/i);

  // Status / flags
  let status = 'auction';
  const flags = [];
  if (/bank\s*owned/i.test(text)) { flags.push('Bank Owned'); }
  if (/foreclosure/i.test(text)) { status = 'nod'; flags.push('Foreclosure'); }
  if (/short\s*sale/i.test(text)) { flags.push('Short Sale'); }
  if (/private\s*seller/i.test(text)) { flags.push('Private Seller'); }
  if (/ends\s+in/i.test(text) && flags.length === 0) flags.push('Active Auction');

  const endsMatch = text.match(/Ends\s+in\s+(\d+)\s*(day|hour|week)/i);

  // Address: prefer the URL slug (deterministic); fall back to text regex.
  let address = addressFromUrl(card.detailUrl);
  if (!address) {
    // Match "1234 St, City, ST" where street is bounded by a clear leading
    // word boundary (not inside a price like "$145,000")
    const fallback = text.match(/(?:^|\.\s+|\bft\.?\s+|\bbid\s+)(\d{1,6}\s+[A-Za-z][\w\s.'-]+,\s*[A-Z][a-zA-Z .'-]+,\s*[A-Z]{2}(?:\s+\d{5})?)/);
    if (fallback) address = fallback[1].trim();
  }
  if (!address) return null;

  return {
    address,
    price: priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0,
    bedrooms: brMatch ? parseFloat(brMatch[1]) : 0,
    bathrooms: baMatch ? parseFloat(baMatch[1]) : 0,
    sqft: sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, '')) : 0,
    status,
    flags,
    endsIn: endsMatch ? `${endsMatch[1]} ${endsMatch[2]}${endsMatch[1] === '1' ? '' : 's'}` : null,
    detailUrl: card.detailUrl || null
  };
}

export async function scrapeAuctions({ city, state, zip, cap = 100 } = {}) {
  const out = { listings: [], sources: [], totalAvailable: 0 };
  if (!city && !state && !zip) return out;

  const url = buildAuctionUrl({ city, state, zip });
  out.deepLinks = { 'Auction.com': url };

  try {
    const data = await withBrowser(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3500);

      // Scroll a few times to load lazy cards
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(800);
      }

      return await page.evaluate(() => {
        const totalMatch = (document.body?.innerText || '').match(/([\d,]+)\s+Properties\s+in/i);
        const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, '')) : 0;

        // Each property card is anchored by a link to /details/<slug>
        const detailLinks = [...document.querySelectorAll('a[href*="/details/"]')];
        const seenHrefs = new Set();
        const cards = [];
        for (const link of detailLinks) {
          if (seenHrefs.has(link.href)) continue;
          seenHrefs.add(link.href);
          // Walk up to find the enclosing card container
          let card = link;
          for (let i = 0; i < 6 && card?.parentElement; i++) {
            card = card.parentElement;
            const txt = card.innerText || '';
            // Card looks like one once we see address + price + bd/ba
            if (txt.length > 60 && /\$[\d,]+/.test(txt) && /\d+\s*bd/i.test(txt)) break;
          }
          cards.push({ text: card?.innerText || '', detailUrl: link.href });
        }
        return { total, cards };
      });
    }, 60000);

    if (!data) return out;
    out.totalAvailable = data.total;
    out.sources.push('auction.com');

    const seen = new Set();
    for (const c of data.cards.slice(0, cap)) {
      const parsed = parseListingCard(c);
      if (!parsed) continue;
      const key = parsed.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.listings.push(parsed);
    }
  } catch (e) {
    console.warn('[auction-scraper] error:', e.message);
  }
  return out;
}

// ---- CLI (only when invoked directly) ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const a = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };
  scrapeAuctions({ city: a('--city'), state: a('--state'), zip: a('--zip'), cap: parseInt(a('--cap')) || 50 })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error('error:', e.message); process.exit(1); });
}
