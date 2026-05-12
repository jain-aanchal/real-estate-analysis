// AirDNA Rentalizer PDF parser
// =============================================================================
// Extracts: ADR, occupancy, projected revenue, NOI, OpEx, and comp listings
// from an AirDNA Rentalizer / Property Analytics PDF export.
//
// Usage (CLI):  node airdna-pdf-parser.mjs <path-to-pdf>
// Usage (lib): `import { parseAirDNAPdf } from './airdna-pdf-parser.mjs'`
// =============================================================================

import { readFile } from 'fs/promises';

// Note: stderr noise from pdfjs-dist is filtered at server.mjs import time
// (see installStderrFilter below — called before this module loads).
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

async function extractText(buffer) {
  // pdfjs strictly checks for Uint8Array (not Node Buffer subclass). Force a fresh copy.
  const src = Buffer.isBuffer(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice()
    : (buffer instanceof Uint8Array ? buffer.slice() : new Uint8Array(buffer));
  const loadingTask = pdfjsLib.getDocument({ data: src, disableWorker: true, isEvalSupported: false, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Preserve some structure: tokens on the same y-coordinate stay together
    const lines = {};
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (!lines[y]) lines[y] = [];
      lines[y].push({ x: item.transform[4], text: item.str });
    }
    const orderedYs = Object.keys(lines).map(Number).sort((a, b) => b - a);
    const pageLines = orderedYs.map(y =>
      lines[y].sort((a, b) => a.x - b.x).map(t => t.text).join(' ').replace(/\s+/g, ' ').trim()
    ).filter(l => l.length > 0);
    pages.push(pageLines);
  }
  return pages;
}

// -------- helpers --------
// Parse a dollar value that may include K/M/B suffix:
//   "$38.4K"  → 38400
//   "$1.2M"   → 1200000
//   "$94,234" → 94234
//   "$3.5B"   → 3500000000
const SUFFIX_MULT = { K: 1_000, k: 1_000, M: 1_000_000, m: 1_000_000, B: 1_000_000_000, b: 1_000_000_000 };
const numFrom = (s) => {
  if (s == null) return 0;
  const txt = String(s).replace(/[\$,]/g, '');
  // Capture leading number + optional K/M/B suffix.
  // Suffix must IMMEDIATELY follow the digits (no whitespace) and NOT be the
  // first letter of a longer word. AirDNA always prints "$94.2K", never
  // "$94.2 K" or "$94.2 Million". Without this guard, "$449.4 Medium"
  // would erroneously parse as 449,400,000 because "M" leads "Medium".
  const m = txt.match(/(-?\d+(?:\.\d+)?)([KkMmBb])?(?![a-zA-Z])/);
  if (!m) return 0;
  const base = parseFloat(m[1]);
  const mult = m[2] ? SUFFIX_MULT[m[2]] : 1;
  return base * mult;
};
const pctFrom = (s) => {
  if (s == null) return 0;
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) return parseFloat(m[1]);
  const n = numFrom(s);
  // If we got a raw "0.62" assume it's a fraction; if "62" assume percent
  return n > 1 ? n : n * 100;
};

// Look for the first match of any regex in the text body
function findFirst(body, patterns) {
  for (const p of patterns) {
    const m = body.match(p);
    if (m) return m[1];
  }
  return null;
}

// -------- main parse --------
export async function parseAirDNAPdf(input) {
  const buffer = typeof input === 'string' ? await readFile(input) : input;
  const pages = await extractText(buffer);
  const flat = pages.flat();
  const body = flat.join('\n');

  // ---- Core metrics ----
  // AirDNA Rentalizer typically prints:
  //   "Annual Revenue $94,234"  "Avg Daily Rate $267"  "Occupancy 62%"
  //   "Revenue Potential / Projected Annual Revenue"
  // NOTE: capture group also includes an optional K/M/B suffix so numFrom()
  // can multiply by 1,000 / 1,000,000 / 1,000,000,000. AirDNA reports often
  // print compact forms like "$38.4K" or "$1.2M".
  // K/M/B suffix must be IMMEDIATELY after the number (no whitespace) and
  // not the leading letter of a longer word (e.g. "$449.4 Medium" must not
  // grab the 'M'). Use a negative lookahead on letters after the suffix.
  const NUM = '[\\d,]+(?:\\.\\d+)?(?:[KkMmBb](?![a-zA-Z]))?';

  // ---- AirDNA Rentalizer layout note ----
  // The Rentalizer PDF prints values BEFORE labels:
  //   "$110.6K 67.4% $449.4 Medium"      ← values
  //   "Projected Average Confidence"      ← label row 1
  //   "Revenue Occupancy Daily Rate Score" ← label row 2
  // AND label-before-value for the OpEx/NOI summary:
  //   "Operating Expenses"  → "$38.4K"
  //   "Net Operating Income" → "$72.2K"
  // We try both orientations.

  let adr = 0, occupancy = 0, revenue = 0;

  // Strategy A: the projection summary row "$X[K] Y.Y% $Z[K] [Confidence]"
  // appearing anywhere in the body — most reliable for the Rentalizer report.
  const summaryRe = new RegExp(`\\$\\s*(${NUM})\\s+([\\d]{1,3}(?:\\.\\d+)?)\\s*%\\s+\\$\\s*(${NUM})`);
  const summaryM = body.match(summaryRe);
  if (summaryM) {
    revenue = numFrom(summaryM[1]);
    occupancy = parseFloat(summaryM[2]);
    adr = numFrom(summaryM[3]);
  }

  // Strategy B: label-keyed fallback (works for older / alternate layouts)
  if (!adr) {
    adr = numFrom(findFirst(body, [
      new RegExp(`(?:Avg(?:erage)?\\s+Daily\\s+Rate|Average\\s+Nightly\\s+Rate|Daily\\s+Rate|ADR)\\s*[:\\-]?\\s*\\$?(${NUM})`, 'i')
    ]));
  }
  if (!occupancy) {
    occupancy = pctFrom(findFirst(body, [
      /(?:Occupancy(?:\s+Rate)?|Avg(?:erage)?\s+Occupancy)\s*[:\-]?\s*([\d]{1,3}(?:\.\d+)?\s*%)/i,
      /Occupancy\s*[:\-]?\s*([0-9.]+)/i
    ]));
  }
  if (!revenue) {
    revenue = numFrom(findFirst(body, [
      new RegExp(`(?:Annual\\s+Revenue|Projected\\s+(?:Annual\\s+)?Revenue|Revenue\\s+Potential|Total\\s+Revenue|Forecasted\\s+Revenue)\\s*[:\\-]?\\s*\\$?(${NUM})`, 'i')
    ]));
  }

  // For OpEx and NOI the label PRECEDES the value, with a newline in between.
  // Scan flat (multi-line aware) AND label-keyed.
  const valueAfterLabel = (labelRe) => {
    // find label, then the next $-value (within next ~80 chars)
    const m = body.match(new RegExp(`${labelRe}[\\s\\S]{0,80}?\\$\\s*(-?${NUM})`, 'i'));
    return m ? numFrom(m[1]) : 0;
  };

  let noi = numFrom(findFirst(body, [
    new RegExp(`(?:Net\\s+Operating\\s+Income|NOI)\\s*[:\\-]?\\s*\\$?(-?${NUM})`, 'i')
  ]));
  if (!noi) noi = valueAfterLabel('Net\\s+Operating\\s+Income');

  let opex = numFrom(findFirst(body, [
    new RegExp(`(?:Total\\s+Operating\\s+Expenses?|Operating\\s+Expenses?|OpEx|Annual\\s+Expenses?)\\s*[:\\-]?\\s*\\$?(${NUM})`, 'i')
  ]));
  if (!opex) opex = valueAfterLabel('Operating\\s+Expenses');

  // ---- Comparable listings ----
  // AirDNA Rentalizer table columns (left → right):
  //   <Title> <Bedrooms> <Baths> <Revenue Potential $K> <Days Available> <Revenue $K> <Occupancy %> <ADR $>
  //
  // Real example from a Rentalizer PDF:
  //   "Elegant, best value, 2-bedroom, 2.5 bath, AC pool. 2 2.5 $90.6K 360 $89.3K 71.9% $344.8"
  // The 7 trailing tokens are deterministic; we anchor on that pattern and
  // treat whatever's before as the title.
  const comps = [];
  const compHeaderIdx = flat.findIndex(l =>
    /comparable|comp set|comp listings|default comps|nearby listings/i.test(l)
  );

  const rowRe = new RegExp(
    '(\\d{1,2})\\s+' +                                  // bedrooms
    '(\\d{1,2}(?:\\.\\d+)?)\\s+' +                      // bathrooms
    '\\$\\s*([\\d,]+(?:\\.\\d+)?\\s*[KkMmBb]?)\\s+' +   // revenue potential
    '(\\d{1,4})\\s+' +                                  // days available
    '\\$\\s*([\\d,]+(?:\\.\\d+)?\\s*[KkMmBb]?)\\s+' +   // actual revenue
    '([\\d]{1,3}(?:\\.\\d+)?)\\s*%\\s+' +               // occupancy %
    '\\$\\s*([\\d,]+(?:\\.\\d+)?\\s*[KkMmBb]?)'         // ADR
  );

  const startIdx = compHeaderIdx >= 0 ? compHeaderIdx + 1 : 0;
  // Stop at the next section/chart break
  const stopIdx = (() => {
    for (let i = startIdx + 3; i < flat.length; i++) {
      if (/airdna\.co|map data|additional listings|amenities|projected monthly/i.test(flat[i])) return i;
    }
    return Math.min(startIdx + 80, flat.length);
  })();

  for (let i = startIdx; i < stopIdx; i++) {
    const line = flat[i];
    if (/^\s*(?:title|bedrooms|baths|revenue|occupancy|adr|days|potential|available)\s*$/i.test(line)) continue;
    const m = line.match(rowRe);
    if (!m) continue;
    const dataStart = line.indexOf(m[0]);
    const title = dataStart > 5 ? line.slice(0, dataStart).trim() : '';
    const bedrooms = parseInt(m[1]);
    const bathrooms = parseFloat(m[2]);
    const revenuePotential = numFrom(m[3]);
    const daysAvailable = parseInt(m[4]);
    const revenue = numFrom(m[5]);
    const occVal = parseFloat(m[6]);
    const adrVal = numFrom(m[7]);
    if (adrVal < 30 || adrVal > 10000) continue;
    comps.push({
      title: title.slice(0, 120),
      bedrooms,
      bathrooms,
      revenuePotential,
      daysAvailable,
      revenue,
      occupancy: occVal,
      adr: adrVal
    });
  }

  // Dedup comps by (title + adr)
  const seenComp = new Set();
  const uniqueComps = comps.filter(c => {
    const k = `${c.title}|${c.adr}|${c.occupancy}`;
    if (seenComp.has(k)) return false;
    seenComp.add(k);
    return true;
  });

  return {
    adr,
    occupancy,
    revenue,
    noi,
    opex,
    comps: uniqueComps,
    pageCount: pages.length,
    // Debug: small body sample (control chars stripped so strict JSON parsers are happy)
    bodySample: body.slice(0, 800).replace(/[\x00-\x1f]+/g, ' ')
  };
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node airdna-pdf-parser.mjs <path-to-pdf>');
    process.exit(2);
  }
  try {
    const result = await parseAirDNAPdf(path);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Parse error:', err.message);
    process.exit(1);
  }
}
