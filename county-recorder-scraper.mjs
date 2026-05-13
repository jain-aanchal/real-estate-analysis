// County Recorder Scraper
// =============================================================================
// Generic + per-state handlers for pulling distress filings (NOD, lis pendens,
// auction notices, deed of trust) from county recorder portals.
//
// Strategy:
//   1. Try the per-state specialized handler if one exists.
//   2. Fall back to a generic NETR Online deep-link (manual verification).
//
// Per-state handlers live in `state-handlers/<state>-recorder.mjs` and expose
// a default `async fn({ address, county })` returning the same shape.
// =============================================================================

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lazy import the state handler if available; otherwise return null.
async function loadStateHandler(state) {
  if (!state) return null;
  const s = state.toLowerCase();
  const path = join(__dirname, 'state-handlers', `${s}-recorder.mjs`);
  if (!existsSync(path)) return null;
  try {
    const mod = await import(`./state-handlers/${s}-recorder.mjs`);
    return mod.default || mod.scrape || null;
  } catch (err) {
    console.warn(`[recorder-scraper] failed to load ${s} handler:`, err.message);
    return null;
  }
}

export async function scrapeRecorder({ address, county, state }) {
  const handler = await loadStateHandler(state);
  if (handler) {
    try {
      const result = await handler({ address, county });
      if (result) return { ...result, source: `${state.toLowerCase()}-recorder` };
    } catch (err) {
      console.warn(`[recorder-scraper] ${state} handler error:`, err.message);
    }
  }

  // Generic fallback: provide deep-link to NETR Online so the user can verify
  // manually. We can't reliably scrape every county's portal without per-county
  // selectors — and many counties block headless browsers entirely.
  const netrUrl = state
    ? `https://publicrecords.netronline.com/state/${state.toUpperCase()}`
    : `https://publicrecords.netronline.com/`;
  return {
    distress: { status: 'UNKNOWN' },
    mortgage: null,
    source: 'netr-fallback',
    note: 'No per-county scraper available. Verify manually.',
    verifyUrl: netrUrl
  };
}
