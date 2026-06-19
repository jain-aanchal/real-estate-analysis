// STR Low / Mid / High scenario math
// =============================================================================
// Shared module used by:
//   - STR tab (single-property analysis)
//   - STR Opportunity Finder drawer (per-row Insights pane)
//
// The Mid scenario is "what the user/auto-detected market multiplier says";
// Low = ADR × 0.8 + Occupancy − 10pts (conservative downside)
// High = ADR × 1.2 + Occupancy + 10pts (optimistic upside)
//
// Each scenario returns the same shape so the UI can render columns directly.
// =============================================================================

import { computeUnderwriting } from './financial-calc.mjs';

const SCENARIO_DEFS = [
  { key: 'low',  label: 'Low',  adrFactor: 0.8, occShift: -0.10 },
  { key: 'mid',  label: 'Mid',  adrFactor: 1.0, occShift:  0.00 },
  { key: 'high', label: 'High', adrFactor: 1.2, occShift:  0.10 }
];

// Compute Low / Mid / High scenarios given a property + the Mid assumptions.
//
//   property = { price, units, bedrooms, ... }
//   midRevenue = annual STR revenue at the Mid scenario (e.g., from RentCast
//                heuristic OR AirDNA Rentalizer)
//   midOccupancy = decimal 0-1 (e.g., 0.60 for vacation default)
//   uwAssumptions = financial-calc.mjs assumption overrides (rate, term, etc.)
//
// Returns:
//   { low: {...uw}, mid: {...uw}, high: {...uw} }
// where each {...uw} is the full computeUnderwriting() result.
export function computeScenarios(property, midRevenue, midOccupancy = 0.60, uwAssumptions = {}) {
  const out = {};
  for (const s of SCENARIO_DEFS) {
    // Scale revenue by ADR factor and proportional occupancy shift.
    // (ADR and occ both shift in the same direction → multiplicative effect.)
    const occ = Math.max(0.01, Math.min(1, midOccupancy + s.occShift));
    const occRatio = midOccupancy > 0 ? occ / midOccupancy : 1;
    const annualRev = midRevenue * s.adrFactor * occRatio;
    const uw = computeUnderwriting(
      {
        price: property.price,
        units: property.units || 1,
        rentPerUnit: annualRev / 12 / (property.units || 1)
      },
      uwAssumptions
    );
    out[s.key] = {
      label: s.label,
      adrFactor: s.adrFactor,
      occupancy: occ,
      annualRevenue: annualRev,
      capRate: uw.capRate,
      noi: uw.noi,
      monthlyCF: uw.monthlyCF,
      annualCF: uw.annualCF,
      dscr: uw.dscr,
      cocReturn: uw.cocReturn,
      totalOpex: uw.totalOpex,
      monthlyPI: uw.monthlyPI
    };
  }
  return out;
}
