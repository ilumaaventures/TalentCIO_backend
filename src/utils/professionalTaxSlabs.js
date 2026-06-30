/**
 * professionalTaxSlabs.js
 *
 * State-wise Professional Tax (PT) slab data and lookup function for India.
 *
 * Rules:
 *  - PT is levied by state governments on monthly gross wages.
 *  - Amounts are whole numbers (₹ integer) — no rounding needed.
 *  - Maharashtra special rule: ₹300 in February for the highest bracket,
 *    ₹200 every other month (annual cumulative = ₹2,500).
 *  - States with NO PT return 0.
 *  - Unknown / empty state code returns 0 (safe default).
 *
 * Slab format per state:
 *   slabs: [ { upTo: <maxGrossInclusive | Infinity>, monthly: <rupees> }, ... ]
 *   Sorted ascending by upTo.  The algorithm picks the FIRST slab whose
 *   upTo >= monthlyGross.  If none match, the last slab is used.
 *
 * Source references (FY 2025-26):
 *   MH  — Maharashtra PT Act, 1975 (amended)
 *   KA  — Karnataka PT Act, 1976
 *   TN  — Tamil Nadu PT Act, 1992
 *   WB  — West Bengal PT Act, 1979
 *   KL  — Kerala PT Act, 1996
 *   AP  — Andhra Pradesh PT Act, 1987
 *   TG  — Telangana PT Act, 1987
 *   GJ  — Gujarat PT Act, 1976
 *   OD  — Odisha PT Act, 2000
 *   AS  — Assam PT Act, 1947
 *   MP  — MP Vritti Kar Adhiniyam, 1955
 *   JH  — Jharkhand PT Act, 2011
 *   PB  — Punjab PT Act, 1977
 *   GA  — Goa PT Act, 2001
 *   SK  — Sikkim PT Act, 2006
 *   TR  — Tripura PT Act, 1975
 *   HP  — Himachal Pradesh PT Act, 1998
 *   ML  — Meghalaya PT Act, 1947
 *
 * States with no PT: DL, UP, HR, RJ, CH, BR, CG, UK, AN, AR, DN, DD,
 *                    JK, LA, LD, MN, MZ, NL, PY
 */

// ---------------------------------------------------------------------------
// Slab tables
// ---------------------------------------------------------------------------

/**
 * @typedef {{ upTo: number, monthly: number }} Slab
 * @typedef {{ slabs: Slab[], februaryBonus?: number }} StateConfig
 */

/** @type {Object.<string, StateConfig>} */
const PT_STATE_CONFIGS = {
  // ── Maharashtra ─────────────────────────────────────────────────────────
  // ₹200/month for gross > ₹10,000.  February = ₹300 (cumulative: ₹2,500/yr)
  // For ₹7,501-₹10,000: ₹175/month (standard; female employees are exempt —
  // not modelled here; employers can use the manual override for exceptions).
  MH: {
    slabs: [
      { upTo: 7500,     monthly: 0   },
      { upTo: 10000,    monthly: 175 },
      { upTo: Infinity, monthly: 200 },
    ],
    // In February the ₹200 bracket becomes ₹300 (the extra ₹100 makes the
    // annual total ₹2,500).  Only the top bracket gets the bonus.
    februaryTopBracketAmount: 300,
    februaryTopBracketThreshold: 10000, // gross > this threshold in Feb
  },

  // ── Karnataka ───────────────────────────────────────────────────────────
  KA: {
    slabs: [
      { upTo: 14999,    monthly: 0   },
      { upTo: Infinity, monthly: 200 },
    ],
  },

  // ── Tamil Nadu ──────────────────────────────────────────────────────────
  // PT is deducted half-yearly; amounts below are effective monthly.
  TN: {
    slabs: [
      { upTo: 21000,    monthly: 0    },
      { upTo: 30000,    monthly: 135  },
      { upTo: 45000,    monthly: 315  },
      { upTo: 60000,    monthly: 690  },
      { upTo: 75000,    monthly: 1025 },
      { upTo: Infinity, monthly: 1250 },
    ],
  },

  // ── West Bengal ─────────────────────────────────────────────────────────
  WB: {
    slabs: [
      { upTo: 10000,    monthly: 0   },
      { upTo: 15000,    monthly: 110 },
      { upTo: 25000,    monthly: 130 },
      { upTo: 40000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },

  // ── Kerala ──────────────────────────────────────────────────────────────
  KL: {
    slabs: [
      { upTo: 1999,     monthly: 0   },
      { upTo: 2999,     monthly: 20  },
      { upTo: 4999,     monthly: 30  },
      { upTo: 7499,     monthly: 50  },
      { upTo: 9999,     monthly: 75  },
      { upTo: 12499,    monthly: 100 },
      { upTo: 16666,    monthly: 125 },
      { upTo: 20833,    monthly: 166 },
      { upTo: Infinity, monthly: 208 },
    ],
  },

  // ── Andhra Pradesh ──────────────────────────────────────────────────────
  AP: {
    slabs: [
      { upTo: 15000,    monthly: 0   },
      { upTo: 20000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },

  // ── Telangana ───────────────────────────────────────────────────────────
  TG: {
    slabs: [
      { upTo: 15000,    monthly: 0   },
      { upTo: 20000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },

  // ── Gujarat ─────────────────────────────────────────────────────────────
  GJ: {
    slabs: [
      { upTo: 5999,     monthly: 0   },
      { upTo: 8999,     monthly: 80  },
      { upTo: 11999,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },

  // ── Odisha ──────────────────────────────────────────────────────────────
  OD: {
    slabs: [
      { upTo: 13304,    monthly: 0   },
      { upTo: 25000,    monthly: 125 },
      { upTo: Infinity, monthly: 200 },
    ],
  },

  // ── Assam ───────────────────────────────────────────────────────────────
  AS: {
    slabs: [
      { upTo: 9999,     monthly: 0   },
      { upTo: 14999,    monthly: 150 },
      { upTo: 24999,    monthly: 180 },
      { upTo: Infinity, monthly: 208 },
    ],
  },

  // ── Madhya Pradesh ──────────────────────────────────────────────────────
  MP: {
    slabs: [
      { upTo: 18750,    monthly: 0   },
      { upTo: 25000,    monthly: 125 },
      { upTo: 33333,    monthly: 167 },
      { upTo: Infinity, monthly: 208 },
    ],
  },

  // ── Jharkhand ───────────────────────────────────────────────────────────
  JH: {
    slabs: [
      { upTo: 25000,    monthly: 0   },
      { upTo: 41666,    monthly: 100 },
      { upTo: Infinity, monthly: 150 },
    ],
  },

  // ── Punjab ──────────────────────────────────────────────────────────────
  PB: {
    slabs: [
      { upTo: 24999,    monthly: 0   },
      { upTo: Infinity, monthly: 200 },
    ],
  },

  // ── Goa ─────────────────────────────────────────────────────────────────
  GA: {
    slabs: [
      { upTo: 15000,    monthly: 0   },
      { upTo: 25000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },

  // ── Sikkim ──────────────────────────────────────────────────────────────
  SK: {
    slabs: [
      { upTo: 20000,    monthly: 0   },
      { upTo: 30000,    monthly: 125 },
      { upTo: 40000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },

  // ── Tripura ─────────────────────────────────────────────────────────────
  TR: {
    slabs: [
      { upTo: 7500,     monthly: 0   },
      { upTo: 15000,    monthly: 120 },
      { upTo: Infinity, monthly: 208 },
    ],
  },

  // ── Himachal Pradesh ────────────────────────────────────────────────────
  HP: {
    slabs: [
      { upTo: 7500,     monthly: 0   },
      { upTo: 12500,    monthly: 125 },
      { upTo: 17500,    monthly: 175 },
      { upTo: Infinity, monthly: 208 },
    ],
  },

  // ── Meghalaya ───────────────────────────────────────────────────────────
  ML: {
    slabs: [
      { upTo: 4166,     monthly: 0   },
      { upTo: 6250,     monthly: 16  },
      { upTo: 8333,     monthly: 25  },
      { upTo: 12500,    monthly: 41  },
      { upTo: 16666,    monthly: 62  },
      { upTo: 20833,    monthly: 83  },
      { upTo: 25000,    monthly: 150 },
      { upTo: Infinity, monthly: 208 },
    ],
  },
};

// ---------------------------------------------------------------------------
// PT_STATE_LIST — used by frontend dropdowns
// ---------------------------------------------------------------------------

/**
 * All Indian states/UTs, sorted alphabetically.
 * States that levy PT are listed first conceptually, but the entire list is
 * alphabetical so the UI dropdown is easy to navigate.
 * `leviesPT: true` can be used by the UI to highlight or group entries.
 */
const PT_STATE_LIST = [
  { code: '',   name: 'None / Manual Override',        leviesPT: false },
  { code: 'AN', name: 'Andaman & Nicobar Islands',     leviesPT: false },
  { code: 'AP', name: 'Andhra Pradesh',                leviesPT: true  },
  { code: 'AR', name: 'Arunachal Pradesh',             leviesPT: false },
  { code: 'AS', name: 'Assam',                         leviesPT: true  },
  { code: 'BR', name: 'Bihar',                         leviesPT: false },
  { code: 'CG', name: 'Chhattisgarh',                  leviesPT: false },
  { code: 'CH', name: 'Chandigarh',                    leviesPT: false },
  { code: 'DL', name: 'Delhi',                         leviesPT: false },
  { code: 'DN', name: 'Dadra & Nagar Haveli',          leviesPT: false },
  { code: 'DD', name: 'Daman & Diu',                   leviesPT: false },
  { code: 'GA', name: 'Goa',                           leviesPT: true  },
  { code: 'GJ', name: 'Gujarat',                       leviesPT: true  },
  { code: 'HR', name: 'Haryana',                       leviesPT: false },
  { code: 'HP', name: 'Himachal Pradesh',              leviesPT: true  },
  { code: 'JK', name: 'Jammu & Kashmir',               leviesPT: false },
  { code: 'JH', name: 'Jharkhand',                     leviesPT: true  },
  { code: 'KA', name: 'Karnataka',                     leviesPT: true  },
  { code: 'KL', name: 'Kerala',                        leviesPT: true  },
  { code: 'LA', name: 'Ladakh',                        leviesPT: false },
  { code: 'LD', name: 'Lakshadweep',                   leviesPT: false },
  { code: 'MP', name: 'Madhya Pradesh',                leviesPT: true  },
  { code: 'MH', name: 'Maharashtra',                   leviesPT: true  },
  { code: 'MN', name: 'Manipur',                       leviesPT: false },
  { code: 'ML', name: 'Meghalaya',                     leviesPT: true  },
  { code: 'MZ', name: 'Mizoram',                       leviesPT: false },
  { code: 'NL', name: 'Nagaland',                      leviesPT: false },
  { code: 'OD', name: 'Odisha',                        leviesPT: true  },
  { code: 'PB', name: 'Punjab',                        leviesPT: true  },
  { code: 'PY', name: 'Puducherry',                    leviesPT: false },
  { code: 'RJ', name: 'Rajasthan',                     leviesPT: false },
  { code: 'SK', name: 'Sikkim',                        leviesPT: true  },
  { code: 'TN', name: 'Tamil Nadu',                    leviesPT: true  },
  { code: 'TG', name: 'Telangana',                     leviesPT: true  },
  { code: 'TR', name: 'Tripura',                       leviesPT: true  },
  { code: 'UP', name: 'Uttar Pradesh',                 leviesPT: false },
  { code: 'UK', name: 'Uttarakhand',                   leviesPT: false },
  { code: 'WB', name: 'West Bengal',                   leviesPT: true  },
];

// ---------------------------------------------------------------------------
// Lookup function
// ---------------------------------------------------------------------------

/**
 * Returns the monthly Professional Tax amount (in ₹, integer) for a given
 * state and gross monthly earnings.
 *
 * @param {string}  stateCode    - 2-letter state code (e.g. 'MH', 'KA').
 *                                 Empty string or unknown code → 0.
 * @param {number}  monthlyGross - Gross monthly earnings (totalEarnings).
 * @param {number}  [month=0]   - Calendar month (1–12).  Used for the
 *                                Maharashtra February special rule.
 *                                Defaults to 0 (non-February behaviour).
 * @param {number}  [year]      - Calendar year (unused currently; reserved
 *                                for future slab-year amendments).
 * @returns {number} PT amount in whole rupees (never negative).
 */
const getMonthlyPT = (stateCode, monthlyGross, month = 0) => {
  if (!stateCode) return 0;
  const cfg = PT_STATE_CONFIGS[stateCode.toUpperCase()];
  if (!cfg) return 0;

  const gross = Number(monthlyGross) || 0;
  if (gross <= 0) return 0;

  // Find the matching slab
  const matchedSlab = cfg.slabs.find(s => gross <= s.upTo);
  const slabAmount = matchedSlab ? matchedSlab.monthly : cfg.slabs[cfg.slabs.length - 1].monthly;

  // Maharashtra February special rule
  if (
    stateCode.toUpperCase() === 'MH' &&
    Number(month) === 2 &&
    cfg.februaryTopBracketThreshold !== undefined &&
    gross > cfg.februaryTopBracketThreshold
  ) {
    return cfg.februaryTopBracketAmount;
  }

  return slabAmount;
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getMonthlyPT,
  PT_STATE_LIST,
  PT_STATE_CONFIGS, // exported for testing / admin tooling
};
