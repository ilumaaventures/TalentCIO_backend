const { roundAmount } = require('./prorationUtils');

const PT_STATE_CONFIGS = {
  MH: {
    slabs: [
      { upTo: 7500,     monthly: 0   },
      { upTo: 10000,    monthly: 175 },
      { upTo: Infinity, monthly: 200 },
    ],
    februaryTopBracketAmount: 300,
    februaryTopBracketThreshold: 10000,
  },
  KA: {
    slabs: [
      { upTo: 14999,    monthly: 0   },
      { upTo: Infinity, monthly: 200 },
    ],
  },
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
  WB: {
    slabs: [
      { upTo: 10000,    monthly: 0   },
      { upTo: 15000,    monthly: 110 },
      { upTo: 25000,    monthly: 130 },
      { upTo: 40000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },
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
  AP: {
    slabs: [
      { upTo: 15000,    monthly: 0   },
      { upTo: 20000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },
  TG: {
    slabs: [
      { upTo: 15000,    monthly: 0   },
      { upTo: 20000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },
  GJ: {
    slabs: [
      { upTo: 5999,     monthly: 0   },
      { upTo: 8999,     monthly: 80  },
      { upTo: 11999,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },
  OD: {
    slabs: [
      { upTo: 13304,    monthly: 0   },
      { upTo: 25000,    monthly: 125 },
      { upTo: Infinity, monthly: 200 },
    ],
  },
  AS: {
    slabs: [
      { upTo: 9999,     monthly: 0   },
      { upTo: 14999,    monthly: 150 },
      { upTo: 24999,    monthly: 180 },
      { upTo: Infinity, monthly: 208 },
    ],
  },
  MP: {
    slabs: [
      { upTo: 18750,    monthly: 0   },
      { upTo: 25000,    monthly: 125 },
      { upTo: 33333,    monthly: 167 },
      { upTo: Infinity, monthly: 208 },
    ],
  },
  JH: {
    slabs: [
      { upTo: 25000,    monthly: 0   },
      { upTo: 41666,    monthly: 100 },
      { upTo: Infinity, monthly: 150 },
    ],
  },
  PB: {
    slabs: [
      { upTo: 24999,    monthly: 0   },
      { upTo: Infinity, monthly: 200 },
    ],
  },
  GA: {
    slabs: [
      { upTo: 15000,    monthly: 0   },
      { upTo: 25000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },
  SK: {
    slabs: [
      { upTo: 20000,    monthly: 0   },
      { upTo: 30000,    monthly: 125 },
      { upTo: 40000,    monthly: 150 },
      { upTo: Infinity, monthly: 200 },
    ],
  },
  TR: {
    slabs: [
      { upTo: 7500,     monthly: 0   },
      { upTo: 15000,    monthly: 120 },
      { upTo: Infinity, monthly: 208 },
    ],
  },
  HP: {
    slabs: [
      { upTo: 7500,     monthly: 0   },
      { upTo: 12500,    monthly: 125 },
      { upTo: 17500,    monthly: 175 },
      { upTo: Infinity, monthly: 208 },
    ],
  },
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

const getMonthlyPT = (stateCode, monthlyGross, month = 0) => {
  if (!stateCode) return 0;
  const cfg = PT_STATE_CONFIGS[stateCode.toUpperCase()];
  if (!cfg) return 0;

  const gross = Number(monthlyGross) || 0;
  if (gross <= 0) return 0;

  const matchedSlab = cfg.slabs.find(s => gross <= s.upTo);
  const slabAmount = matchedSlab ? matchedSlab.monthly : cfg.slabs[cfg.slabs.length - 1].monthly;

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

const computeStatutoryComponents = ({ pfEnabled, gratuityEnabled, lwfEnabled, monthlyCTC, basicMaster, config, includePfInCTC, includeGratuityInCTC }) => {
  let pfEmployer = 0;
  let pfEmployee = 0;
  let pfBase = 0;

  if (pfEnabled && basicMaster > 0 && monthlyCTC > 0) {
    if (config.pfCalculationType === 'fixed') {
      pfEmployer = roundAmount(config.pfAmountEmployer);
      pfEmployee = roundAmount(config.pfAmountEmployee);
      pfBase = pfEmployee;
    } else {
      pfBase = roundAmount(Math.min(basicMaster, config.pfCap));
      pfEmployer = roundAmount(pfBase * config.pfEmployerRate);
      pfEmployee = roundAmount(pfBase * config.pfRate);
    }
  }

  const gratuity = gratuityEnabled ? roundAmount(basicMaster * config.gratuityRate) : 0;
  const lwfEmployer = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployer) : 0;
  const lwfEmployee = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployee) : 0;

  return {
    pfEmployer,
    pfEmployee,
    pfBase,
    gratuity,
    lwfEmployer,
    lwfEmployee,
    pfEmployerInCTC: (pfEnabled && includePfInCTC) ? pfEmployer : 0,
    gratuityInCTC: (gratuityEnabled && includeGratuityInCTC) ? gratuity : 0,
  };
};

module.exports = {
  computeStatutoryComponents,
  getMonthlyPT,
  PT_STATE_LIST,
  PT_STATE_CONFIGS,
};
