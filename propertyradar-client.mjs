// PropertyRadar — paid feed client (env-gated)
// =============================================================================
// When PROPERTYRADAR_API_KEY is set in .env, this client is the preferred data
// source for distress filings (NOD, auctions, tax liens). When the key is
// absent, the server's aggregator falls back to free scrapers transparently.
//
// API docs: https://developers.propertyradar.com/
// Pricing:  $89/mo entry tier as of May 2026
// =============================================================================

// Search distressed properties by location.
// Returns an array shaped like the rest of /api/distressed/search results.
export async function propertyRadarSearch({ apiKey, base, location, filters, cap = 500 }) {
  if (!apiKey) return null;
  const body = {
    Criteria: [
      { name: 'Location', value: [location] }
    ],
    Limit: cap,
    Page: 1
  };
  // Map our generic filters → PropertyRadar criteria
  if (filters?.statuses?.includes('nod')) body.Criteria.push({ name: 'Foreclosure', value: ['true'] });
  if (filters?.statuses?.includes('auction')) body.Criteria.push({ name: 'AuctionScheduled', value: ['true'] });
  if (filters?.statuses?.includes('tax_delinquent')) body.Criteria.push({ name: 'TaxDelinquent', value: ['true'] });
  if (filters?.types?.length) body.Criteria.push({ name: 'PropertyType', value: filters.types });
  if (filters?.priceMin || filters?.priceMax) {
    body.Criteria.push({ name: 'AVM', value: [`${filters.priceMin || 0}-${filters.priceMax || ''}`] });
  }

  const url = `${base}/properties?Fields=BasicInfo,Ownership,Mortgage,Foreclosure,Tax`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`PropertyRadar HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  return (data.results || []).map((p, idx) => ({
    id: p.RadarID || `pr-${idx}`,
    address: p.SiteAddress || '',
    lat: Number(p.SiteLatitude) || 0,
    lng: Number(p.SiteLongitude) || 0,
    propertyType: (p.PropertyType || '').toLowerCase().includes('multi') ? 'multi-family' : 'single-family',
    units: Number(p.Units) || 1,
    bedrooms: Number(p.Bedrooms) || 0,
    bathrooms: Number(p.Bathrooms) || 0,
    yearBuilt: Number(p.YearBuilt) || 0,
    lastSalePrice: Number(p.LastSalePrice) || 0,
    lastSaleDate: p.LastSaleDate || '',
    estimatedValue: Number(p.AVM) || 0,
    ownerName: p.OwnerName || '',
    ownerOccupied: !!p.OwnerOccupied,
    status: p.AuctionScheduled ? 'auction'
          : p.Foreclosure ? 'nod'
          : p.TaxDelinquent ? 'tax_delinquent'
          : 'off_market',
    flags: [
      p.Foreclosure ? 'NOD' : null,
      p.AuctionScheduled ? 'Auction' : null,
      p.TaxDelinquent ? 'Tax lien' : null
    ].filter(Boolean),
    capRate: 0, noi: 0,
    _propertyRadar: true
  }));
}

// Per-property full record
export async function propertyRadarProperty({ apiKey, base, address }) {
  if (!apiKey) return null;
  const url = `${base}/property/by-address?address=${encodeURIComponent(address)}` +
              `&Fields=BasicInfo,Ownership,Mortgage,Foreclosure,Tax,SaleHistory`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' } });
  if (!r.ok) return null;
  const p = await r.json();
  return {
    address: p.SiteAddress || address,
    lat: Number(p.SiteLatitude) || 0,
    lng: Number(p.SiteLongitude) || 0,
    units: Number(p.Units) || 1,
    bedrooms: Number(p.Bedrooms) || 0,
    bathrooms: Number(p.Bathrooms) || 0,
    yearBuilt: Number(p.YearBuilt) || 0,
    estimatedValue: Number(p.AVM) || 0,
    saleComp: {
      lastSalePrice: Number(p.LastSalePrice) || 0,
      lastSaleDate: p.LastSaleDate || '',
      priceHistory: p.SaleHistory || [],
      nearbyComps: []
    },
    record: {
      owner: {
        name: p.OwnerName || '',
        mailingAddress: p.OwnerMailingAddress || '',
        ownerOccupied: !!p.OwnerOccupied
      },
      mortgage: {
        lender: p.MortgageLender || '',
        originalAmount: Number(p.MortgageAmount) || 0,
        originationDate: p.MortgageDate || '',
        estimatedBalance: Number(p.MortgageBalance) || 0,
        loanType: p.LoanType || ''
      },
      distress: {
        status: p.AuctionScheduled ? 'AUCTION' : p.Foreclosure ? 'NOD' : 'NONE',
        nodDate: p.NODDate || null,
        auctionDate: p.AuctionDate || null,
        defaultAmount: Number(p.DefaultAmount) || 0,
        trustee: p.Trustee || ''
      },
      tax: {
        assessedValue: Number(p.AssessedValue) || 0,
        annualTax: Number(p.AnnualTax) || 0,
        taxRate: Number(p.TaxRate) || 0,
        delinquentYears: Number(p.TaxDelinquentYears) || 0
      }
    }
  };
}
