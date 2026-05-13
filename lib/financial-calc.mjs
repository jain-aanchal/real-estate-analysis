// Shared underwriting math
// =============================================================================
// Single source of truth for cap rate / NOI / OpEx / CoC / DSCR / ROI / target
// price calculations. Used by:
//   - LTR tab (client-side)
//   - Distressed tab Insights card (client-side)
//   - /api/distressed/property and /api/distressed/search (server-side precompute)
//
// Designed to be importable in both Node and the browser without a build step.
// =============================================================================

export const DEFAULT_ASSUMPTIONS = {
  downPct: 35,
  rate: 7.25,
  termYears: 30,
  closingCosts: 0,
  vacancyRate: 6,        // %
  maintPct: 8,           // % of EGI
  capexPct: 5,           // % of EGI
  pmPct: 8,              // % of EGI
  insurancePerUnit: 55,  // $/unit/month
  utilitiesPerUnit: 50,  // $/unit/month (owner-paid portion)
  otherOpex: 150,        // $/month flat
  taxRate: 1.1,          // % of price annually
  rentGrowth: 3,         // % yearly
  opexGrowth: 2,         // % yearly
  appreciation: 3,       // % yearly
  targetCapRate: 0.11,   // 11% — used for "Target buy price"
  roiYears: 5
};

// Standard mortgage P&I payment per month
export function mortgagePI(principal, annualRatePct, years) {
  if (principal <= 0 || years <= 0) return 0;
  const r = (annualRatePct / 100) / 12;
  const n = years * 12;
  if (r === 0) return principal / n;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

// Remaining loan balance after `monthsElapsed` of payments
export function mortgageBalance(principal, annualRatePct, years, monthsElapsed) {
  if (principal <= 0) return 0;
  const r = (annualRatePct / 100) / 12;
  const pmt = mortgagePI(principal, annualRatePct, years);
  if (r === 0) return Math.max(0, principal - pmt * monthsElapsed);
  return principal * Math.pow(1 + r, monthsElapsed) - pmt * ((Math.pow(1 + r, monthsElapsed) - 1) / r);
}

// Compute every metric used by the LTR tab and the Distressed Underwriting card.
// `input` is property data; `assumptions` are user-tunable knobs.
//
// Returns a flat object — all $ are annual unless suffixed "Monthly".
export function computeUnderwriting(input, opts = {}) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...opts };
  const price = Number(input.price) || 0;
  const units = Math.max(1, Number(input.units) || 1);
  const rentPerUnit = Number(input.rentPerUnit) || Number(opts.rentPerUnit) || 0;
  const otherIncomePerUnit = Number(input.otherIncomePerUnit) || 0;

  // Financing
  const down = price * (a.downPct / 100);
  const loan = price - down;
  const monthlyPI = mortgagePI(loan, a.rate, a.termYears);
  const annualDS = monthlyPI * 12;
  const cashIn = down + (a.closingCosts || 0);

  // Income
  const gprMonthly = (rentPerUnit + otherIncomePerUnit) * units;
  const gprAnnual = gprMonthly * 12;
  const vacancyLoss = gprAnnual * (a.vacancyRate / 100);
  const egi = gprAnnual - vacancyLoss;

  // OpEx
  const taxAnnual = price * (a.taxRate / 100);
  const insuranceAnnual = a.insurancePerUnit * units * 12;
  const maintAnnual = egi * (a.maintPct / 100);
  const capexAnnual = egi * (a.capexPct / 100);
  const pmAnnual = egi * (a.pmPct / 100);
  const utilitiesAnnual = a.utilitiesPerUnit * units * 12;
  const otherOpexAnnual = a.otherOpex * 12;
  const totalOpex = taxAnnual + insuranceAnnual + maintAnnual
                  + capexAnnual + pmAnnual + utilitiesAnnual + otherOpexAnnual;

  // Bottom line
  const noi = egi - totalOpex;
  const annualCF = noi - annualDS;
  const monthlyCF = annualCF / 12;
  const capRate = price > 0 ? noi / price : 0;
  const cocReturn = cashIn > 0 ? annualCF / cashIn : 0;
  const dscr = annualDS > 0 ? noi / annualDS : 0;
  const targetPrice = noi > 0 ? noi / a.targetCapRate : 0;

  // Multi-year ROI
  const years = a.roiYears || 5;
  let cumCF = 0;
  for (let y = 1; y <= years; y++) {
    const yrEgi = egi * Math.pow(1 + a.rentGrowth / 100, y - 1);
    const yrOpex = totalOpex * Math.pow(1 + (a.opexGrowth || 2) / 100, y - 1);
    cumCF += (yrEgi - yrOpex) - annualDS;
  }
  const balEnd = mortgageBalance(loan, a.rate, a.termYears, years * 12);
  const principalPaid = loan - balEnd;
  const futureValue = price * Math.pow(1 + a.appreciation / 100, years);
  const apprGain = futureValue - price;
  const totalReturn = cumCF + principalPaid + apprGain;
  const roi = cashIn > 0 ? totalReturn / cashIn : 0;

  return {
    // Inputs echoed for convenience
    price, units, rentPerUnit, assumptions: a,
    // Financing
    down, loan, monthlyPI, annualDS, cashIn,
    // Income
    gprMonthly, gprAnnual, vacancyLoss, egi,
    // OpEx components
    taxAnnual, insuranceAnnual, maintAnnual, capexAnnual,
    pmAnnual, utilitiesAnnual, otherOpexAnnual, totalOpex,
    monthlyOpex: totalOpex / 12,
    // Key metrics
    noi, annualCF, monthlyCF, capRate, cocReturn, dscr,
    targetPriceAtCap: targetPrice,
    roi
  };
}

// Convenience: round all numeric values to whole dollars / hundredths for display.
export function roundMetrics(m) {
  const r = {};
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (typeof v === 'number') r[k] = Math.round(v * 100) / 100;
    else r[k] = v;
  }
  return r;
}
