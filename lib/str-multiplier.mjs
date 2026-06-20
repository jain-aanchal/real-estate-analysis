// STR multiplier auto-detection by market type
// =============================================================================
// The STR Opportunity Finder converts LTR rent (RentCast Rent Zestimate /
// market median) → STR annual revenue via:
//
//   strAnnualRev = monthlyLtrRent × 12 × STR_MULTIPLIER × OCCUPANCY
//
// Different markets warrant different defaults:
//
//   vacation 🌴  multiplier 2.5×  occ 60%   (beach, ski, resort towns)
//   metro    🏙️  multiplier 1.8×  occ 65%   (top 50 MSA short-stay markets)
//   college  🎓  multiplier 1.5×  occ 55%   (university towns)
//   suburban 🏘️  multiplier 1.4×  occ 50%   (default fallback)
//
// This module auto-detects market type from city name. The user can always
// override via the filter bar — see CTO-130 spec § 6.
// =============================================================================

const MARKET_TABLE = {
  vacation: { multiplier: 2.5, occupancy: 0.60, emoji: '🌴' },
  metro:    { multiplier: 1.8, occupancy: 0.65, emoji: '🏙️' },
  college:  { multiplier: 1.5, occupancy: 0.55, emoji: '🎓' },
  suburban: { multiplier: 1.4, occupancy: 0.50, emoji: '🏘️' }
};

// Curated city lists. Lowercased, no punctuation. Match logic strips spaces
// and punctuation from input before comparing.
const VACATION_CITIES = new Set([
  // Hawaii
  'lahaina', 'kihei', 'wailea', 'kaanapali', 'kapalua', 'makena', 'maui',
  'kauai', 'lihue', 'princeville', 'hanalei', 'poipu', 'kapaa',
  'kona', 'kailuakona', 'hilo', 'waikoloa', 'waimea', 'bigisland', 'hawi',
  'honolulu', 'waikiki', 'kailua',
  // Florida vacation
  'destin', 'panamacitybeach', 'pensacola', 'fortwaltonbeach', '30a',
  'keywest', 'islamorada', 'marathon', 'keylargo', 'florida keys',
  'siestakey', 'annamariaisland', 'naples', 'marco island', 'sanibel',
  'amelia island', 'jacksonville beach', 'st augustine', 'flagler beach',
  'daytona beach', 'cocoa beach', 'satellite beach', 'melbourne beach',
  // Outer Banks NC, SC coast
  'obx', 'outer banks', 'kitty hawk', 'kill devil hills', 'nags head',
  'duck', 'corolla', 'rodanthe', 'hatteras', 'ocracoke',
  'myrtle beach', 'north myrtle beach', 'pawleys island', 'hilton head',
  'isle of palms', 'sullivansisland', 'folly beach',
  // Gulf coast Alabama / Mississippi
  'gulfshores', 'orange beach', 'fort morgan', 'gulfbreeze',
  // Texas vacation
  'galveston', 'south padre island', 'port aransas', 'rockport',
  // CA vacation
  'big sur', 'carmel', 'pacific grove', 'monterey', 'sausalito',
  'half moon bay', 'pismo beach', 'morrobay', 'cambria',
  'mendocino', 'fort bragg', 'avila beach', 'shellbeach',
  'palm springs', 'palm desert', 'la quinta', 'rancho mirage', 'idyllwild',
  'mammoth lakes', 'south lake tahoe', 'tahoe city', 'truckee', 'incline village',
  'avalon', 'catalina',
  // Arizona vacation
  'sedona', 'jerome', 'prescott', 'flagstaff',
  // Ski / mountain
  'aspen', 'snowmass', 'vail', 'beaver creek', 'breckenridge', 'keystone',
  'telluride', 'crested butte', 'steamboat springs', 'winterpark',
  'park city', 'deer valley', 'sundance', 'alta', 'snowbird',
  'jackson hole', 'jackson', 'tetonvillage',
  'stowe', 'killington', 'okemo', 'mount snow',
  'big sky', 'whitefish', 'bigsky', 'whitefish',
  'sun valley', 'ketchum', 'mccall',
  // Sedona / desert getaways already listed above
  // SE vacation
  'gatlinburg', 'pigeon forge', 'sevierville',
  'asheville', 'banner elk', 'boone', 'blowing rock',
  'savannah', 'tybee island', 'st simons', 'jekyll island'
]);

const METRO_CITIES = new Set([
  // Top-50 MSA short-stay markets
  'new york', 'newyork', 'nyc', 'manhattan', 'brooklyn', 'queens', 'bronx',
  'los angeles', 'losangeles', 'la', 'hollywood', 'beverlyhills', 'santamonica',
  'chicago', 'miami', 'miamibeach', 'south beach',
  'san francisco', 'sanfrancisco', 'sf', 'oakland', 'berkeley', 'emeryville',
  'san mateo', 'sanmateo', 'redwood city', 'redwoodcity', 'foster city',
  'fostercity', 'burlingame', 'san bruno', 'sanbruno', 'south san francisco',
  'daly city', 'dalycity', 'pacifica', 'milbrae', 'belmont', 'sancarlos',
  'san carlos', 'menlo park', 'menlopark', 'palo alto', 'paloalto',
  'mountain view', 'mountainview', 'sunnyvale', 'cupertino', 'san jose',
  'sanjose', 'santa clara', 'santaclara', 'campbell', 'los gatos', 'losgatos',
  'fremont', 'union city', 'unioncity', 'hayward', 'sanleandro',
  'boston', 'cambridge', 'somerville',
  'washington', 'washingtondc', 'dc',
  'seattle', 'bellevue', 'redmond',
  'denver', 'aurora', 'centennial',
  'atlanta', 'decatur', 'sandysprings',
  'houston', 'dallas', 'fortworth', 'plano', 'arlington',
  'austin', 'sanantonio',
  'phoenix', 'scottsdale', 'tempe', 'mesa',
  'philadelphia', 'philly',
  'portland', 'beaverton',
  'nashville', 'franklin', 'brentwood',
  'new orleans', 'neworleans',
  'minneapolis', 'stpaul',
  'detroit', 'royaloak',
  'baltimore',
  'pittsburgh',
  'cleveland',
  'cincinnati',
  'kansas city', 'kansascity', 'kc',
  'indianapolis',
  'columbus',
  'milwaukee',
  'oklahoma city', 'oklahomacity', 'okc',
  'tulsa',
  'memphis',
  'louisville',
  'richmond',
  'raleigh', 'durham', 'chapel hill',
  'charlotte',
  'salt lake city', 'saltlakecity', 'slc',
  'las vegas', 'vegas', 'henderson', 'paradise',
  'sacramento', 'roseville',
  'san diego', 'sandiego'
]);

const COLLEGE_CITIES = new Set([
  'boulder',                  // CU Boulder
  'fort collins',             // Colorado State
  'athens',                   // UGA
  'ann arbor', 'annarbor',    // UMich
  'east lansing',             // MSU
  'madison',                  // UW-Madison
  'gainesville',              // UF
  'tallahassee',              // FSU
  'eugene',                   // U of O
  'corvallis',                // OSU
  'chapel hill',              // UNC
  'charlottesville',          // UVA
  'iowa city', 'iowacity',    // U of Iowa
  'columbia',                 // U of MO / USC
  'lawrence',                 // KU
  'norman',                   // OU
  'state college',            // PSU
  'happy valley',
  'college station', 'collegestation', // TAMU
  'auburn',                   // Auburn U
  'tuscaloosa',               // Alabama
  'oxford',                   // Ole Miss
  'starkville',               // MSU (Miss)
  'baton rouge', 'batonrouge', // LSU
  'fayetteville',             // U of Arkansas
  'morgantown',               // WVU
  'knoxville',                // UTK
  'gainesville',              // UGA Florida (dup ok)
  'lexington',                // UK
  'columbia',                 // dup ok
  'bloomington',              // IU
  'west lafayette',           // Purdue
  'champaign', 'urbana',      // UIUC
  'evanston',                 // Northwestern
  'south bend', 'southbend',  // Notre Dame
  'east lansing',             // dup ok
  'cambridge',                // Harvard (also metro — metro wins via order)
  'new haven', 'newhaven',    // Yale
  'princeton',                // Princeton
  'ithaca',                   // Cornell
  'syracuse',                 // Syracuse U
  'rochester',                // U of R
  'amherst',                  // UMass
  'storrs',                   // UConn
  'kingston',                 // URI
  'orono',                    // U of Maine
  'durham',                   // Duke (also metro — metro wins)
  'tucson',                   // U of A
  'tempe',                    // ASU (also metro)
  'flagstaff',                // NAU (already in vacation — vacation wins)
  'reno',                     // UNR
  'ogden',                    // Weber
  'logan',                    // USU
  'provo'                     // BYU
]);

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')   // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns one of: 'vacation' | 'metro' | 'college' | 'suburban'
// Precedence: vacation > metro > college > suburban.
// Rationale: a city listed in both vacation and college (e.g., Boulder area)
// gets the vacation defaults because STR economics are dominated by tourism
// demand when both forces are present.
export function detectMarketType(city) {
  const norm = normalize(city);
  if (!norm) return 'suburban';
  // Also try a space-collapsed form so "Las Vegas" matches "lasvegas"
  const collapsed = norm.replace(/\s+/g, '');
  const has = (set) => set.has(norm) || set.has(collapsed);
  if (has(VACATION_CITIES)) return 'vacation';
  if (has(METRO_CITIES)) return 'metro';
  if (has(COLLEGE_CITIES)) return 'college';
  return 'suburban';
}

// Returns { marketType, multiplier, occupancy, emoji } given a city name.
// User overrides (passed in `opts`) take precedence over auto-detected values.
export function strDefaults(city, opts = {}) {
  const marketType = opts.marketType || detectMarketType(city);
  const base = MARKET_TABLE[marketType] || MARKET_TABLE.suburban;
  return {
    marketType,
    multiplier: opts.multiplier != null ? Number(opts.multiplier) : base.multiplier,
    occupancy:  opts.occupancy  != null ? Number(opts.occupancy)  : base.occupancy,
    emoji: base.emoji
  };
}

// Convenience: derive annual STR revenue from monthly LTR rent.
export function strAnnualRevenue(monthlyLtrRent, opts) {
  const rent = Number(monthlyLtrRent) || 0;
  const m = opts?.multiplier ?? MARKET_TABLE.suburban.multiplier;
  const o = opts?.occupancy ?? MARKET_TABLE.suburban.occupancy;
  return rent * 12 * m * o;
}

export const MARKET_TYPES = Object.keys(MARKET_TABLE);
