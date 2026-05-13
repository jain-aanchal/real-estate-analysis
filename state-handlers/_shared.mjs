// Shared helpers for state-specific recorder scrapers.
// =============================================================================
// Most county recorders use Tyler Technologies / Granicus / Aumentum / CSC
// platforms with very similar grantor-grantee search UIs. This module exposes
// helpers to drive those generic flows so per-state files stay small.
//
// All scrapers must return a plain JSON object — they're invoked from the
// server in-process (not subprocess) so they need to be quick and reliable.
// =============================================================================

import { existsSync } from 'fs';

let _chromiumImport = null;
async function getChromium() {
  if (!_chromiumImport) {
    _chromiumImport = (async () => {
      try {
        const m = await import('playwright');
        return m.chromium;
      } catch {
        return null;
      }
    })();
  }
  return _chromiumImport;
}

// Open Playwright Chromium quickly; return null if Playwright isn't installed.
export async function withBrowser(fn, timeoutMs = 45000) {
  const chromium = await getChromium();
  if (!chromium) return null;
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US'
  });
  const page = await ctx.newPage();
  try {
    const result = await Promise.race([
      fn(page),
      new Promise((_, rej) => setTimeout(() => rej(new Error('scraper timeout')), timeoutMs))
    ]);
    return result;
  } finally {
    await browser.close();
  }
}

// Parse a typical distress-event row.
// Returns null if no distress signal found.
export function parseDistressFromText(bodyText) {
  if (!bodyText) return null;
  const flat = bodyText.replace(/\s+/g, ' ');
  // NOD signals
  const nodMatch = flat.match(/(?:notice of default|nod\b|default and election to sell)\s.*?(?:filed|recorded)?\s*(?:on)?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (nodMatch) return { status: 'NOD', nodDate: nodMatch[1] };
  // Auction
  const aucMatch = flat.match(/(?:trustee.s sale|sheriff.s sale|notice of sale)\s.*?(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (aucMatch) return { status: 'AUCTION', auctionDate: aucMatch[1] };
  // Lis pendens
  const lpMatch = flat.match(/lis\s*pendens\s.*?(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (lpMatch) return { status: 'LIS_PENDENS', filedDate: lpMatch[1] };
  return null;
}

// Generic NETR Online deep-link builder — used as a 'always works' fallback so
// the user can verify info that we couldn't programmatically extract.
export function buildNetrLink(state, county) {
  if (state && county) {
    return `https://publicrecords.netronline.com/state/${state.toUpperCase()}/county/${encodeURIComponent(county)}`;
  }
  if (state) return `https://publicrecords.netronline.com/state/${state.toUpperCase()}`;
  return 'https://publicrecords.netronline.com/';
}
