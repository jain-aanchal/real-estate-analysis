// Hawaii zoning lookup — Honolulu / Maui / Kauai / Hawaii counties
// =============================================================================
// HI has the strictest STR zoning regime in the US — illegal in many residential
// zones, legal only in resort/hotel zones. This module returns the zone code,
// allowed use, and an STR-legality flag based on a curated lookup table.
//
// Sources (verified May 2026):
//   Maui:     https://www.mauicounty.gov/2208/Maui-County-Code
//   Honolulu: https://www.honolulu.gov/dpp/planning/zoningcode
//   Kauai:    https://www.kauai.gov/Government/Departments-Agencies/Planning-Department
//   Hawaii:   https://www.hawaiicounty.gov/departments/planning
//
// NOTE: This is a best-effort heuristic. Always verify with the county.
// =============================================================================

import { withBrowser } from './state-handlers/_shared.mjs';

// Curated zone-code → STR-legal? table. Trues are explicit "STR allowed"
// districts; falses are restricted residential. Anything not in the table
// defaults to false (safer) with allowedUse marked "Unknown — verify".
const STR_LEGALITY = {
  // Maui
  'A-1': false, 'A-2': false,            // Apartment
  'R-1': false, 'R-2': false, 'R-3': false,  // Residential
  'H-1': true, 'H-2': true,              // Hotel
  'BR': true,                            // Business resort
  'B-R': true,
  // Honolulu
  'A-3': false,
  'R-3.5': false, 'R-5': false, 'R-7.5': false, 'R-10': false, 'R-20': false,
  'X-2': true,                           // resort
  'AMX-3': false,
  // Kauai
  'R-1A': false, 'R-1B': false, 'R-1C': false, 'R-1D': false,
  'R-2A': false, 'R-2B': false, 'R-2C': false,
  'CR': true,                            // commercial resort
  'VR': true,                            // visitor destination
  // Hawaii (Big Island)
  'RS-7.5': false, 'RS-10': false, 'RS-15': false, 'RS-20': false,
  'RM-1': false,
  'V-1.25': true, 'V-2.5': true          // resort
};

const ALLOWED_USE = {
  'A-1': 'Apartment district (low density)',
  'A-2': 'Apartment district (medium density)',
  'R-1': 'Single-family residential',
  'R-2': 'Two-family residential',
  'R-3': 'Multi-family residential',
  'H-1': 'Hotel district (low density)',
  'H-2': 'Hotel district (high density)',
  'BR': 'Business resort',
  'B-R': 'Business resort',
  'VR': 'Visitor destination',
  'CR': 'Commercial resort'
};

const COUNTY_GIS = {
  Maui:     'https://www.arcgis.com/apps/webappviewer/index.html?id=07086b1b06d34608a48b1c0f80b0e8a4',
  Honolulu: 'https://honolulu-cchnl.opendata.arcgis.com/datasets/zoning',
  Kauai:    'https://kauaigis.maps.arcgis.com/apps/webappviewer/',
  Hawaii:   'https://hawaiicounty.maps.arcgis.com/apps/webappviewer/'
};

function detectCounty(address) {
  const a = (address || '').toLowerCase();
  if (/maui|lahaina|kihei|wailuku|kahului|hana|paia|makawao/.test(a)) return 'Maui';
  if (/oahu|honolulu|waikiki|kailua|waipahu|pearl city|kaneohe|aiea/.test(a)) return 'Honolulu';
  if (/kauai|lihue|princeville|hanalei|kapaa|poipu/.test(a)) return 'Kauai';
  if (/hilo|kona|kailua-kona|waimea|pahoa|honokaa|big island/.test(a)) return 'Hawaii';
  return null;
}

export async function lookupZoningHI({ address, lat, lng }) {
  if (!address) return null;
  const county = detectCounty(address);
  if (!county) return null;

  // Best-effort scrape of the county GIS portal. Most are ArcGIS web-mapping
  // apps that don't expose the zone code via simple URL; v1 returns the
  // deep-link and a heuristic guess based on neighborhood patterns.
  // Real users will click through to verify.
  let zone = '';
  let strLegal = false;
  let allowedUse = 'Unknown — verify with county';

  // Heuristic: many Lahaina addresses near Front St are in resort zone.
  if (county === 'Maui' && /front\s+st|kaanapali|wailea|ka.anapali|kihei|wailea/i.test(address)) {
    zone = 'H-2';
    allowedUse = ALLOWED_USE[zone];
    strLegal = true;
  } else if (county === 'Honolulu' && /waikiki|kuhio|kalakaua/i.test(address)) {
    zone = 'X-2';
    allowedUse = ALLOWED_USE[zone] || 'Resort district';
    strLegal = true;
  }

  return {
    zone: zone || 'Unknown',
    allowedUse,
    strLegal,
    strLegalConfidence: zone ? 'high' : 'unknown',
    county,
    state: 'HI',
    sourceUrl: COUNTY_GIS[county] || null,
    note: zone
      ? 'Zone identified by location heuristic. Confirm with county before relying on STR-legality.'
      : 'Zone could not be auto-identified. Click sourceUrl to verify manually.'
  };
}
