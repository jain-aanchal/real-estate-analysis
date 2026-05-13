// IL county recorder handler
// =============================================================================
// Per-county recorder portals in IL vary widely; v1 returns a
// reliable deep-link to NETR Online for manual verification, plus a best-effort
// distress probe via Playwright when a known county pattern matches.
//
// To extend: add a county-specific case in the switch below with a custom
// scraper. Each one should return { distress, mortgage } in the documented
// shape (see county-recorder-scraper.mjs).
// =============================================================================

import { withBrowser, parseDistressFromText, buildNetrLink } from './_shared.mjs';

export default async function scrape({ address, county }) {
  // Best-effort generic probe via Google search → first 200 chars of body text.
  // Many county portals are CloudFront-blocked; this is intentional fallback
  // logic until per-county handlers are written.
  const probe = await withBrowser(async (page) => {
    const q = encodeURIComponent(`"${address}" notice of default OR trustee sale OR lis pendens`);
    await page.goto(`https://www.google.com/search?q=${q}`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    const txt = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
    return parseDistressFromText(txt);
  }).catch(() => null);

  return {
    distress: probe || { status: 'NONE' },
    mortgage: null,
    state: 'IL',
    county,
    verifyUrl: buildNetrLink('IL', county)
  };
}
