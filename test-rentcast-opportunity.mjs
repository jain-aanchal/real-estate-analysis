// RentCast — STR Opportunity Finder feasibility smoke test
// =============================================================================
// Verifies the three endpoints the search pipeline depends on:
//   GET /v1/listings/sale
//   GET /v1/markets
//   GET /v1/avm/rent/long-term
//
// Run:  node test-rentcast-opportunity.mjs
// =============================================================================

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  listingsSale, marketByZip, marketByCity, rentAvm,
  normalizeMarket, rentForBedrooms
} from './rentcast-opportunity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(__dirname, '.env'))) {
  const env = readFileSync(join(__dirname, '.env'), 'utf8');
  env.split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}

const key = process.env.RENTCAST_API_KEY;
if (!key || key.startsWith('your-')) {
  console.error('❌ RENTCAST_API_KEY not set in .env');
  process.exit(2);
}

const line = () => console.log('─'.repeat(70));
const log = (m) => console.log(m);

(async () => {
  line();
  log('RentCast — STR Opportunity Finder Smoke Test');
  line();
  log(`Key: ${key.slice(0, 8)}…${key.slice(-4)}`);
  log('');

  // 1. Pull listings in San Mateo, CA
  log('[1/3] Listings — for-sale in San Mateo, CA…');
  let listings = [];
  try {
    listings = await listingsSale({ city: 'San Mateo', state: 'CA', limit: 10 }, key);
    log(`  ✓ Returned ${listings.length} listing(s)`);
    for (const L of listings.slice(0, 5)) {
      const addr = L.formattedAddress || L.address || `${L.streetAddress || ''}`;
      const br = L.bedrooms ?? '?';
      const ba = L.bathrooms ?? '?';
      const sf = L.squareFootage ?? '?';
      const yr = L.yearBuilt ?? '?';
      const price = L.price ?? L.listPrice ?? L.lastSalePrice ?? 0;
      log(`    ${addr}`);
      log(`        ${br}BR/${ba}BA · ${sf} sqft · built ${yr} · $${price.toLocaleString()}`);
    }
    if (listings.length === 0) {
      log('  ⚠ Zero listings — try a different market or check plan tier');
    }
  } catch (e) {
    log(`  ❌ Listings failed: ${e.message}`);
    process.exit(1);
  }
  log('');

  // 2. Market rent data for 94401
  log('[2/3] Market rent — zip 94401 (San Mateo)…');
  let market = null;
  try {
    const raw = await marketByZip('94401', key);
    market = normalizeMarket(raw);
    if (market.medianRent) {
      log(`  ✓ Median rent: $${market.medianRent.toLocaleString()}/mo`);
      if (Object.keys(market.byBedrooms).length) {
        for (const [b, r] of Object.entries(market.byBedrooms)) {
          log(`    ${b}BR → $${Number(r).toLocaleString()}/mo`);
        }
      } else {
        log(`    (no per-bedroom breakdown — falling back to industry scaling)`);
        for (const b of [1, 2, 3, 4]) {
          log(`    ${b}BR (scaled) → $${rentForBedrooms(market, b).toLocaleString()}/mo`);
        }
      }
    } else {
      log('  ⚠ Market returned but no median rent found');
    }
  } catch (e) {
    log(`  ⚠ Market call failed: ${e.message}`);
  }
  log('');

  // 3. Per-address rent AVM for the first listing
  log('[3/3] Rent AVM — first listing…');
  if (!listings.length) {
    log('  (skipped — no listings)');
  } else {
    const L = listings[0];
    try {
      const avm = await rentAvm({
        address: L.formattedAddress || L.address,
        bedrooms: L.bedrooms,
        bathrooms: L.bathrooms
      }, key);
      const rent = avm?.rent || avm?.estimatedRent || avm?.medianRent;
      const range = avm?.rentRangeLow && avm?.rentRangeHigh
        ? ` (range $${avm.rentRangeLow.toLocaleString()}–$${avm.rentRangeHigh.toLocaleString()})`
        : '';
      if (rent) {
        log(`  ✓ ${L.formattedAddress || L.address}`);
        log(`    Rent AVM: $${rent.toLocaleString()}/mo${range}`);
      } else {
        log(`  ⚠ No rent value in AVM response`);
        log(`    Raw: ${JSON.stringify(avm).slice(0, 200)}`);
      }
    } catch (e) {
      log(`  ⚠ Rent AVM failed: ${e.message}`);
    }
  }

  log('');
  line();
  const ok = listings.length > 0 && market?.medianRent > 0;
  if (ok) {
    log('✅ FEASIBILITY CONFIRMED — safe to build CTO-130 search endpoint.');
  } else {
    log('⚠ Partial — fix issues above before Phase 2.');
  }
  line();
})().catch(e => {
  console.error('Unexpected:', e);
  process.exit(1);
});
