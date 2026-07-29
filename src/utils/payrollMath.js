const { getMonthlyPT } = require('./professionalTaxSlabs');
const DEFAULT_PAYROLL_CONFIG = {
  basicPercent: 0.5,
  hraPercent: 0.5,
  pfRate: 0.12,
  pfCap: 15000,
  pfEmployerRate: 0.12,
  pfCalculationType: 'percent',
  pfAmountEmployee: 1800,
  pfAmountEmployer: 1800,
  esiEmployeeRate: 0.0075,
  esiEmployerRate: 0.0325,
  esiBasicThreshold: 21000,
  lwfEmployer: 35,
  lwfEmployee: 15,
  gratuityRate: 0.0481,
  defaultWorkingDays: 30,
  defaultInsurance: 0,
  ltaMaxPercent: 0.0833,
};

const roundAmount = (value) => Math.round((Number(value) || 0) * 100) / 100;
const sumNamedAmounts = (items = []) => items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const getSegmentLops = (totalLop, workingDays, totalDays, strategy = 'proportional', segments = [], customLops = []) => {
  const segmentLops = new Array(segments.length).fill(0);
  if (totalLop <= 0 || segments.length === 0) return segmentLops;

  if (strategy === 'custom') {
    let sum = 0;
    for (let i = 0; i < segments.length; i++) {
      segmentLops[i] = Number(customLops[i]) || 0;
      sum += segmentLops[i];
    }
    for (let i = 0; i < segments.length; i++) {
      const segWorkingDays = (segments[i].daysCount / totalDays) * workingDays;
      segmentLops[i] = Math.max(0, Math.min(segWorkingDays, segmentLops[i]));
    }
  } else if (strategy === 'older_first') {
    let remainingLop = totalLop;
    for (let i = 0; i < segments.length; i++) {
      const segWorkingDays = (segments[i].daysCount / totalDays) * workingDays;
      const segLop = Math.min(remainingLop, segWorkingDays);
      segmentLops[i] = roundAmount(segLop);
      remainingLop -= segLop;
    }
  } else if (strategy === 'newer_first') {
    let remainingLop = totalLop;
    for (let i = segments.length - 1; i >= 0; i--) {
      const segWorkingDays = (segments[i].daysCount / totalDays) * workingDays;
      const segLop = Math.min(remainingLop, segWorkingDays);
      segmentLops[i] = roundAmount(segLop);
      remainingLop -= segLop;
    }
  } else {
    // proportional
    for (let i = 0; i < segments.length; i++) {
      const segRatio = segments[i].daysCount / totalDays;
      segmentLops[i] = roundAmount(segRatio * totalLop);
    }
  }
  return segmentLops;
};

const getDayProrateArray = (totalDays, workingDays, paidDays, strategy = 'proportional', segmentLops = [], segments = []) => {
  const dayProrate = new Array(totalDays).fill(1);
  if (workingDays <= 0) return dayProrate;
  const ratio = Math.min(paidDays / workingDays, 1);
  if (ratio >= 1) return dayProrate;

  if (segments.length === 0) {
    dayProrate.fill(ratio);
    return dayProrate;
  }

  const computedLops = getSegmentLops(workingDays - paidDays, workingDays, totalDays, strategy, segments, segmentLops);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segLop = computedLops[i] || 0;
    const segRatio = seg.daysCount / totalDays;
    const segWorkingDays = segRatio * workingDays;
    const segProrate = segWorkingDays > 0 ? Math.max(0, Math.min(1, (segWorkingDays - segLop) / segWorkingDays)) : 1;
    for (let d = seg.startDay; d <= seg.endDay; d++) {
      dayProrate[d - 1] = segProrate;
    }
  }
  return dayProrate;
};

const normalizeConfig = (config = {}) => {
  const getNum = (val, def) => {
    const n = Number(val);
    return Number.isFinite(n) ? n : def;
  };
  const cfg = config || {};
  return {
    basicPercent: getNum(cfg.basicPercent, DEFAULT_PAYROLL_CONFIG.basicPercent),
    hraPercent: getNum(cfg.hraPercent, DEFAULT_PAYROLL_CONFIG.hraPercent),
    pfRate: getNum(cfg.pfRate, DEFAULT_PAYROLL_CONFIG.pfRate),
    pfCap: getNum(cfg.pfCap, DEFAULT_PAYROLL_CONFIG.pfCap),
    pfEmployerRate: getNum(cfg.pfEmployerRate, DEFAULT_PAYROLL_CONFIG.pfEmployerRate),
    pfCalculationType: cfg.pfCalculationType || DEFAULT_PAYROLL_CONFIG.pfCalculationType,
    pfAmountEmployee: getNum(cfg.pfAmountEmployee, DEFAULT_PAYROLL_CONFIG.pfAmountEmployee),
    pfAmountEmployer: getNum(cfg.pfAmountEmployer, DEFAULT_PAYROLL_CONFIG.pfAmountEmployer),
    esiEmployeeRate: getNum(cfg.esiEmployeeRate, DEFAULT_PAYROLL_CONFIG.esiEmployeeRate),
    esiEmployerRate: getNum(cfg.esiEmployerRate, DEFAULT_PAYROLL_CONFIG.esiEmployerRate),
    esiBasicThreshold: getNum(cfg.esiBasicThreshold, DEFAULT_PAYROLL_CONFIG.esiBasicThreshold),
    lwfEmployer: getNum(cfg.lwfEmployer, DEFAULT_PAYROLL_CONFIG.lwfEmployer),
    lwfEmployee: getNum(cfg.lwfEmployee, DEFAULT_PAYROLL_CONFIG.lwfEmployee),
    gratuityRate: getNum(cfg.gratuityRate, DEFAULT_PAYROLL_CONFIG.gratuityRate),
    defaultWorkingDays: getNum(cfg.defaultWorkingDays, DEFAULT_PAYROLL_CONFIG.defaultWorkingDays),
    defaultInsurance: getNum(cfg.defaultInsurance, DEFAULT_PAYROLL_CONFIG.defaultInsurance),
    ltaMaxPercent: getNum(cfg.ltaMaxPercent, DEFAULT_PAYROLL_CONFIG.ltaMaxPercent),
    salaryComponents: cfg.salaryComponents || null,
  };
};

const getMonthlyCTCValue = (source = {}) => {
  const monthlyCTC = Number(source.monthlyCTC);
  if (Number.isFinite(monthlyCTC) && monthlyCTC > 0) return monthlyCTC;

  const annualCTC = Number(source.annualCTC);
  if (Number.isFinite(annualCTC) && annualCTC > 0) return annualCTC / 12;

  const salaryCTC = Number(source.salaryStructure?.ctc);
  if (Number.isFinite(salaryCTC) && salaryCTC > 0) return salaryCTC;

  return 0;
};

const calculateHRAExemption = (basicMaster, hraMaster, rentPaidMonthly, isMetroCity) => {
  const annualBasic = basicMaster * 12;
  const annualHRA = hraMaster * 12;
  const rentPaidAnnual = (Number(rentPaidMonthly) || 0) * 12;
  if (rentPaidAnnual <= 0) return 0;

  const pctOfBasic = annualBasic * 0.10;
  const capPercent = isMetroCity ? 0.50 : 0.40;
  const capAmount = annualBasic * capPercent;

  return Math.max(0, Math.min(
    annualHRA,
    rentPaidAnnual - pctOfBasic,
    capAmount
  ));
};

const calculateTaxForRegime = (regime, annualTaxableIncome) => {
  const income = Math.max(0, annualTaxableIncome);
  let tax = 0;

  if (regime === 'new') {
    if (income <= 400000) return 0;
    if (income > 2400000) {
      tax += (income - 2400000) * 0.30;
      tax += 300000;
    } else if (income > 2000000) {
      tax += (income - 2000000) * 0.25;
      tax += 200000;
    } else if (income > 1600000) {
      tax += (income - 1600000) * 0.20;
      tax += 120000;
    } else if (income > 1200000) {
      tax += (income - 1200000) * 0.15;
      tax += 60000;
    } else if (income > 800000) {
      tax += (income - 800000) * 0.10;
      tax += 20000;
    } else if (income > 400000) {
      tax += (income - 400000) * 0.05;
    }

    if (income <= 1200000) {
      tax = 0;
    }
  } else {
    // Old Regime
    if (income <= 250000) return 0;
    if (income > 1000000) {
      tax += (income - 1000000) * 0.30;
      tax += 112500;
    } else if (income > 500000) {
      tax += (income - 500000) * 0.20;
      tax += 12500;
    } else if (income > 250000) {
      tax += (income - 250000) * 0.05;
    }

    if (income <= 500000) {
      tax = 0;
    }
  }

  return tax;
};

const calculateTaxDetails = (employee, monthlyCTC, config, basicMaster, hraMaster, totalEarnings) => {
  const annualGrossEarnings = totalEarnings * 12;
  const dec = employee.declarations || {};
  const ptEnabled = employee.ptEnabled !== false;

  // 1. New Regime calculations
  const standardDeductionNew = 75000;
  const netTaxableIncomeNew = Math.max(0, annualGrossEarnings - standardDeductionNew);
  let annualTaxNewBase = calculateTaxForRegime('new', netTaxableIncomeNew);
  // Apply Marginal Relief under Section 87A for New Regime (Budget 2025 limit: ₹12 Lakhs)
  if (netTaxableIncomeNew > 1200000) {
    const excessIncome = netTaxableIncomeNew - 1200000;
    if (annualTaxNewBase > excessIncome) {
      annualTaxNewBase = excessIncome;
    }
  }
  const cessNew = roundAmount(annualTaxNewBase * 0.04);
  const annualTaxNew = roundAmount(annualTaxNewBase + cessNew);
  const monthlyTaxNew = roundAmount(annualTaxNew / 12);

  // 2. Old Regime calculations
  const standardDeductionOld = 50000;
  const hraExemption = calculateHRAExemption(basicMaster, hraMaster, dec.rentPaidMonthly || 0, dec.isMetroCity || false);
  const sec80C = Math.min(Number(dec.section80C) || 0, 150000);
  const sec80D = Math.min(Number(dec.section80D) || 0, 25000);
  const sec24b = Math.min(Number(dec.section24b) || 0, 200000);
  const sec80CCD1B = Math.min(Number(dec.section80CCD1B) || 0, 50000);
  const otherExemptions = Number(dec.otherExemptions) || 0;
  const professionalTaxOld = ptEnabled ? (Number(employee.deductions?.professionalTax) || 0) * 12 : 0;

  const totalDeductionsOld = standardDeductionOld + hraExemption + sec80C + sec80D + sec24b + sec80CCD1B + otherExemptions + professionalTaxOld;
  const netTaxableIncomeOld = Math.max(0, annualGrossEarnings - totalDeductionsOld);
  const annualTaxOldBase = calculateTaxForRegime('old', netTaxableIncomeOld);
  const cessOld = roundAmount(annualTaxOldBase * 0.04);
  const annualTaxOld = roundAmount(annualTaxOldBase + cessOld);
  const monthlyTaxOld = roundAmount(annualTaxOld / 12);

  return {
    newRegime: {
      standardDeduction: standardDeductionNew,
      netTaxableIncome: netTaxableIncomeNew,
      annualTaxBase: annualTaxNewBase,
      cess: cessNew,
      annualTax: annualTaxNew,
      monthlyTax: monthlyTaxNew,
    },
    oldRegime: {
      standardDeduction: standardDeductionOld,
      hraExemption,
      section80C: sec80C,
      section80D: sec80D,
      section24b: sec24b,
      section80CCD1B: sec80CCD1B,
      otherExemptions,
      professionalTax: professionalTaxOld,
      totalDeductions: totalDeductionsOld,
      netTaxableIncome: netTaxableIncomeOld,
      annualTaxBase: annualTaxOldBase,
      cess: cessOld,
      annualTax: annualTaxOld,
      monthlyTax: monthlyTaxOld,
    }
  };
};

const buildMasterSalaryStructure = (source = {}, configInput = {}) => {
  const config = normalizeConfig(configInput);
  let monthlyCTC = roundAmount(getMonthlyCTCValue(source));

  if (source.payType === 'hourly') {
    const hours = source.hoursWorked !== undefined ? Number(source.hoursWorked) : 160;
    monthlyCTC = roundAmount((Number(source.hourlyRate) || 0) * hours);
  }

  const isIntern = source.employmentType === 'intern';
  const isHourly = source.payType === 'hourly';
  const isFlat = source.payType === 'flat';
  const useComponents = source.useSalaryComponents !== false && !isIntern && !isHourly && !isFlat;

  // Toggles integration
  const pfEnabled = !isIntern && !isHourly && !isFlat && source.pfEnabled !== false;
  const esiEnabled = !isIntern && !isHourly && !isFlat && source.esiEnabled !== false;
  const ptEnabled = !isIntern && !isHourly && !isFlat && source.ptEnabled !== false;
  const lwfEnabled = !isIntern && !isHourly && !isFlat && source.lwfEnabled !== false;
  const gratuityEnabled = !isIntern && !isHourly && !isFlat && source.gratuityEnabled !== false;
  const includePfInCTC = !isIntern && !isHourly && !isFlat && source.includePfInCTC === true;
  const includeGratuityInCTC = !isIntern && !isHourly && !isFlat && source.includeGratuityInCTC !== false;

  let basicPercent = !useComponents ? 1.0 : config.basicPercent;
  if (useComponents && source.basicPercent !== undefined && source.basicPercent !== null && Number(source.basicPercent) > 0) {
    basicPercent = Number(source.basicPercent) > 1 ? Number(source.basicPercent) / 100 : Number(source.basicPercent);
  }

  let hraPercent = !useComponents ? 0 : config.hraPercent;
  if (useComponents && source.hraPercent !== undefined && source.hraPercent !== null && Number(source.hraPercent) > 0) {
    hraPercent = Number(source.hraPercent) > 1 ? Number(source.hraPercent) / 100 : Number(source.hraPercent);
  }

  const hasDynamicComponents = config.salaryComponents && config.salaryComponents.length > 0;

  let basicMaster = roundAmount(monthlyCTC * basicPercent);
  const sourceBasic = source.basic !== undefined ? source.basic : source.salaryStructure?.basic;
  if (useComponents && sourceBasic !== undefined && sourceBasic !== null && Number(sourceBasic) > 0) {
    basicMaster = roundAmount(sourceBasic);
  }

  let hraMaster = roundAmount(basicMaster * hraPercent);
  const sourceHra = source.hra !== undefined ? source.hra : source.salaryStructure?.hra;
  if (useComponents && sourceHra !== undefined && sourceHra !== null && Number(sourceHra) > 0) {
    hraMaster = roundAmount(sourceHra);
  }

  if (hasDynamicComponents) {
    const basicComp = config.salaryComponents.find(c => c.id === 'basic');
    if (basicComp) {
      const sourceBasic = source.basic !== undefined ? source.basic : source.salaryStructure?.basic;
      if (!useComponents) {
        basicMaster = monthlyCTC;
      } else if (useComponents && sourceBasic !== undefined && sourceBasic !== null && Number(sourceBasic) > 0) {
        basicMaster = roundAmount(sourceBasic);
      } else {
        let bVal = basicComp.linkValue;
        if (source.basicPercent !== undefined && source.basicPercent !== null && Number(source.basicPercent) > 0) {
          bVal = Number(source.basicPercent) > 1 ? Number(source.basicPercent) / 100 : Number(source.basicPercent);
        }
        if (basicComp.linkedTo === 'ctc_percent') {
          basicMaster = roundAmount(monthlyCTC * bVal);
        } else if (basicComp.linkedTo === 'fixed') {
          const val = source['basic'] !== undefined ? source['basic'] : (source.salaryStructure?.['basic'] !== undefined ? source.salaryStructure['basic'] : 0);
          basicMaster = roundAmount(val);
        }
      }
    }
    const hraComp = config.salaryComponents.find(c => c.id === 'hra');
    if (hraComp) {
      const sourceHra = source.hra !== undefined ? source.hra : source.salaryStructure?.hra;
      if (!useComponents) {
        hraMaster = 0;
      } else if (useComponents && sourceHra !== undefined && sourceHra !== null && Number(sourceHra) > 0) {
        hraMaster = roundAmount(sourceHra);
      } else {
        let hVal = hraComp.linkValue;
        if (source.hraPercent !== undefined && source.hraPercent !== null && Number(source.hraPercent) > 0) {
          hVal = Number(source.hraPercent) > 1 ? Number(source.hraPercent) / 100 : Number(source.hraPercent);
        }
        if (hraComp.linkedTo === 'basic_percent') {
          hraMaster = roundAmount(basicMaster * hVal);
        } else if (hraComp.linkedTo === 'ctc_percent') {
          hraMaster = roundAmount(monthlyCTC * hVal);
        } else if (hraComp.linkedTo === 'fixed') {
          const val = source['hra'] !== undefined ? source['hra'] : (source.salaryStructure?.['hra'] !== undefined ? source.salaryStructure['hra'] : 0);
          hraMaster = roundAmount(val);
        }
      }
    }
  }

  // PF Calculation
  let pfEmployer = 0;
  let pfEmployee = 0;
  let pfBase = 0;
  if (pfEnabled) {
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

  // Gratuity Calculation
  const gratuity = gratuityEnabled ? roundAmount(basicMaster * config.gratuityRate) : 0;

  // LWF Calculation
  const lwfEmployer = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployer) : 0;
  const lwfEmployee = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployee) : 0;

  // ESI Calculation — Two-pass to avoid circular dependency:
  // Pass 1: compute allowances/earnings with ESI disabled to determine actual gross wages
  // Pass 2: check if actualGrossWages <= esiBasicThreshold, then apply ESI
  const insurance = monthlyCTC > 0 ? roundAmount(source.insuranceAmount ?? config.defaultInsurance) : 0;
  const employerNPS = roundAmount(source.employerNPS);


  // CTC integration balancing special allowance
  const pfEmployerInCTC = (pfEnabled && includePfInCTC) ? pfEmployer : 0;
  const gratuityInCTC = (gratuityEnabled && includeGratuityInCTC) ? gratuity : 0;

  const otherAllowances = source.salaryStructure?.otherAllowances || source.otherAllowances || [];
  const otherAllowancesSum = roundAmount(otherAllowances.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));

  let flexi = 0, broadband = 0, petrol = 0, lta = 0, ltaCap = 0, conveyance = 0, medicalAllowance = 0, specialAllowance = 0;

  // Helper: compute component earnings (pass 1 — esiEmployer placeholder = 0 for remainder calculation)
  const computeEarnings = (esiEmployerPlaceholder) => {
    const em = {};
    if (hasDynamicComponents) {
      ltaCap = roundAmount(basicMaster * config.ltaMaxPercent);
      let sumOfAllNonRemainder = 0;
      config.salaryComponents.forEach(c => {
        if (c.type === 'earning' && c.linkedTo !== 'remainder') {
          let amount = 0;
          if (c.id === 'basic') {
            amount = basicMaster;
          } else if (c.id === 'hra') {
            amount = hraMaster;
          } else if (c.linkedTo === 'ctc_percent') {
            let pct = c.linkValue;
            const overrideVal = source[c.id + 'Percent'];
            if (overrideVal !== undefined && overrideVal !== null && Number(overrideVal) > 0) {
              pct = Number(overrideVal) > 1 ? Number(overrideVal) / 100 : Number(overrideVal);
            }
            amount = roundAmount(monthlyCTC * pct);
          } else if (c.linkedTo === 'basic_percent') {
            let pct = c.linkValue;
            const overrideVal = source[c.id + 'Percent'];
            if (overrideVal !== undefined && overrideVal !== null && Number(overrideVal) > 0) {
              pct = Number(overrideVal) > 1 ? Number(overrideVal) / 100 : Number(overrideVal);
            }
            amount = roundAmount(basicMaster * pct);
          } else if (c.linkedTo === 'fixed') {
            let val = source[c.id] !== undefined ? source[c.id] : (source.salaryStructure?.[c.id] !== undefined ? source.salaryStructure[c.id] : 0);
            if (c.id === 'medical' && val === 0) {
              val = source.medicalAllowance !== undefined ? source.medicalAllowance : (source.salaryStructure?.medicalAllowance !== undefined ? source.salaryStructure.medicalAllowance : 0);
            }
            if (c.id === 'flexi' && val === 0) {
              val = source.flexiAmount !== undefined ? source.flexiAmount : (source.salaryStructure?.flexiAmount !== undefined ? source.salaryStructure.flexiAmount : 0);
            }
            amount = roundAmount(val);
          }
          if (c.id === 'lta') amount = roundAmount(Math.min(amount, ltaCap || amount));
          em[c.id] = amount;
          sumOfAllNonRemainder += amount;
        }
      });
      config.salaryComponents.forEach(c => {
        if (c.type === 'earning' && c.linkedTo === 'remainder') {
          em[c.id] = roundAmount(Math.max(
            monthlyCTC - sumOfAllNonRemainder - pfEmployer - gratuity - lwfEmployer - insurance - esiEmployerPlaceholder - employerNPS - otherAllowancesSum,
            0
          ));
        }
      });
    }
    return em;
  };

  // Pass 1 — no ESI cost in the remainder formula
  let earningsMap = computeEarnings(0);

  if (hasDynamicComponents) {
    flexi = earningsMap['flexi'] || 0;
    broadband = earningsMap['broadband'] || 0;
    petrol = earningsMap['petrol'] || 0;
    lta = earningsMap['lta'] || 0;
    conveyance = earningsMap['conveyance'] || 0;
    medicalAllowance = earningsMap['medical'] || 0;
    specialAllowance = earningsMap['special'] || 0;
  } else {
    flexi = roundAmount(source.flexiAmount);
    broadband = roundAmount(source.broadband);
    petrol = roundAmount(source.petrol);
    const ltaRequested = roundAmount(source.lta);
    ltaCap = roundAmount(basicMaster * config.ltaMaxPercent);
    lta = roundAmount(Math.min(ltaRequested, ltaCap || ltaRequested));
    conveyance = roundAmount(source.salaryStructure?.conveyance);
    medicalAllowance = roundAmount(source.salaryStructure?.medicalAllowance);
    specialAllowance = roundAmount(Math.max(
      monthlyCTC - basicMaster - hraMaster - flexi - broadband - petrol - lta - pfEmployer - gratuity - lwfEmployer - insurance - employerNPS - conveyance - medicalAllowance - otherAllowancesSum,
      0
    ));
  }

  if (!useComponents) {
    basicMaster = monthlyCTC;
    hraMaster = 0;
    flexi = 0; broadband = 0; petrol = 0; lta = 0; conveyance = 0; medicalAllowance = 0; specialAllowance = 0;
    if (hasDynamicComponents) {
      Object.keys(earningsMap).forEach(k => { earningsMap[k] = k === 'basic' ? monthlyCTC : 0; });
    }
  }

  // Pass 1 total earnings — used to determine actual gross wages for ESI eligibility
  const pass1TotalEarnings = hasDynamicComponents
    ? roundAmount(Object.values(earningsMap).reduce((sum, v) => sum + v, 0) + otherAllowancesSum)
    : roundAmount(basicMaster + hraMaster + flexi + broadband + petrol + lta + specialAllowance + conveyance + medicalAllowance + otherAllowancesSum);

  // Pass 2 — ESI eligibility based on actual gross wages (not CTC proxy)
  const esiApplicable = esiEnabled && (pass1TotalEarnings <= config.esiBasicThreshold);
  const esiEmployer = roundAmount(esiApplicable ? basicMaster * config.esiEmployerRate : 0);
  const esiEmployee = roundAmount(esiApplicable ? basicMaster * config.esiEmployeeRate : 0);

  // Re-run earnings with correct ESI employer cost in remainder formula
  if (esiApplicable) {
    if (hasDynamicComponents) {
      earningsMap = computeEarnings(esiEmployer);
      flexi = earningsMap['flexi'] || 0;
      broadband = earningsMap['broadband'] || 0;
      petrol = earningsMap['petrol'] || 0;
      lta = earningsMap['lta'] || 0;
      conveyance = earningsMap['conveyance'] || 0;
      medicalAllowance = earningsMap['medical'] || 0;
      specialAllowance = earningsMap['special'] || 0;
      if (!useComponents) {
        basicMaster = monthlyCTC;
        hraMaster = 0;
        Object.keys(earningsMap).forEach(k => { earningsMap[k] = k === 'basic' ? monthlyCTC : 0; });
      }
    } else {
      specialAllowance = roundAmount(Math.max(
        monthlyCTC - basicMaster - hraMaster - flexi - broadband - petrol - lta - pfEmployer - gratuity - lwfEmployer - insurance - esiEmployer - employerNPS - conveyance - medicalAllowance - otherAllowancesSum,
        0
      ));
    }
  }



  const totalEarnings = hasDynamicComponents
    ? roundAmount(Object.values(earningsMap).reduce((sum, v) => sum + v, 0) + otherAllowancesSum)
    : roundAmount(basicMaster + hraMaster + flexi + broadband + petrol + lta + specialAllowance + conveyance + medicalAllowance + otherAllowancesSum);

  // Gross Salary = all earnings paid to employee (Basic + HRA + Flexi + all allowances)
  // Standard CTC formula: CTC = Gross + Employer PF + Employer ESI + LWF + Gratuity + Employer NPS
  const grossSalary = totalEarnings;

  const totalEmployerContributions = roundAmount(
    pfEmployer + esiEmployer + gratuity + lwfEmployer + insurance + employerNPS
  );


  // Dynamic Tax Engine Calculations
  const taxRegime = source.taxRegime || 'new';
  const declarations = source.declarations || {};

  const taxDetails = calculateTaxDetails({
    ...source,
    ptEnabled,
    taxRegime,
    declarations
  }, monthlyCTC, config, basicMaster, hraMaster, totalEarnings);

  const calculatedTdsMonthly = taxDetails[taxRegime === 'old' ? 'oldRegime' : 'newRegime'].monthlyTax;
  const tds = Number(source.deductions?.tds) > 0 ? Number(source.deductions?.tds) : roundAmount(calculatedTdsMonthly);

  // Professional Tax: prefer manual override when non-zero, otherwise
  // auto-compute from state slab (getMonthlyPT returns 0 if no state set).
  const manualPT = Number(source.deductions?.professionalTax) || 0;
  const computedPT = (ptEnabled && source.ptState)
    ? getMonthlyPT(source.ptState, totalEarnings, source._month)
    : 0;
  const professionalTax = ptEnabled
    ? (manualPT > 0 ? manualPT : computedPT)
    : 0;
  const otherDeductions = source.deductions?.otherDeductions || source.otherDeductions || [];
  const otherDeductionsSum = roundAmount(otherDeductions.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));

  const deductionsMap = {};
  if (hasDynamicComponents) {
    config.salaryComponents.forEach(c => {
      if (c.type === 'deduction') {
        let amount = 0;
        if (c.linkedTo === 'ctc_percent') {
          let pct = c.linkValue;
          const overrideVal = source[c.id + 'Percent'];
          if (overrideVal !== undefined && overrideVal !== null && Number(overrideVal) > 0) {
            pct = Number(overrideVal) > 1 ? Number(overrideVal) / 100 : Number(overrideVal);
          }
          amount = roundAmount(monthlyCTC * pct);
        } else if (c.linkedTo === 'basic_percent') {
          let pct = c.linkValue;
          const overrideVal = source[c.id + 'Percent'];
          if (overrideVal !== undefined && overrideVal !== null && Number(overrideVal) > 0) {
            pct = Number(overrideVal) > 1 ? Number(overrideVal) / 100 : Number(overrideVal);
          }
          amount = roundAmount(basicMaster * pct);
        } else if (c.linkedTo === 'fixed') {
          let val = source[c.id] !== undefined ? source[c.id] : (source.deductions?.[c.id] !== undefined ? source.deductions[c.id] : 0);
          amount = roundAmount(val);
        }
        deductionsMap[c.id] = amount;
      }
    });
  }
  const dynamicDeductionsSum = roundAmount(Object.values(deductionsMap).reduce((sum, v) => sum + v, 0));

  const totalDeductions = roundAmount(
    pfEmployee +
    esiEmployee +
    professionalTax +
    tds +
    lwfEmployee +
    otherDeductionsSum +
    dynamicDeductionsSum
  );

  return {
    config,
    monthlyCTC,
    annualCTC: roundAmount(monthlyCTC * 12),
    basicMaster,
    hraMaster,
    pfBase,
    pfEmployer,
    pfEmployee,
    gratuity,
    lwfEmployer,
    lwfEmployee,
    insurance,
    flexi,
    broadband,
    petrol,
    lta,
    ltaCap,
    employerNPS,
    conveyance,
    medicalAllowance,
    specialAllowance,
    esiApplicable,
    esiEmployer,
    esiEmployee,
    grossSalary,
    totalEarnings,
    totalEmployerContributions,
    grossTotalSalary: roundAmount(totalEarnings + totalEmployerContributions),
    totalDeductions,
    netTakeHome: roundAmount(Math.max(0, totalEarnings - totalDeductions)),
    diff: roundAmount(monthlyCTC - (basicMaster + hraMaster + flexi + broadband + petrol + lta + pfEmployer + gratuity + lwfEmployer + insurance + esiEmployer + employerNPS + conveyance + medicalAllowance + specialAllowance)),
    taxRegime,
    declarations,
    taxDetails,
    tds,
    professionalTax,
    pfEnabled,
    esiEnabled,
    ptEnabled,
    lwfEnabled,
    gratuityEnabled,
    includePfInCTC,
    includeGratuityInCTC,
    useSalaryComponents: source.useSalaryComponents !== false,
    earningsMap,
    deductionsMap,
  };
};

const buildPayrollSnapshot = (employeeInput, configInput, attendance, adjustments = {}, monthNum, yearNum) => {
  const employee = (employeeInput && typeof employeeInput.toObject === 'function')
    ? employeeInput.toObject()
    : employeeInput;
  const config = normalizeConfig(configInput);
  
  const year = Number(yearNum) || Number(attendance?.year) || Number(adjustments?.year) || new Date().getFullYear();
  const month = Number(monthNum) || Number(attendance?.month) || Number(adjustments?.month) || (new Date().getMonth() + 1);

  const getYYYYMMDD = (dateVal) => {
    const dateObj = new Date(dateVal);
    if (isNaN(dateObj.getTime())) return '';
    const y = dateObj.getUTCFullYear();
    const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const getEmployeeParamsForDate = (dateStr) => {
    const revisions = [...(employee.salaryRevisions || [])].sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));
    if (revisions.length === 0) {
      return employee;
    }
    const latestRevision = revisions[revisions.length - 1];
    const latestRevDateStr = getYYYYMMDD(latestRevision.effectiveDate);
    if (dateStr >= latestRevDateStr) {
      return employee;
    }
    let activeRevision = null;
    for (let i = revisions.length - 1; i >= 0; i--) {
      const revDateStr = getYYYYMMDD(revisions[i].effectiveDate);
      if (revDateStr && revDateStr <= dateStr) {
        activeRevision = revisions[i];
        break;
      }
    }
    if (!activeRevision) {
      activeRevision = revisions[0];
    }

    const getVal = (field, def) => {
      if (activeRevision && activeRevision[field] !== undefined && activeRevision[field] !== null) {
        return activeRevision[field];
      }
      if (employee[field] !== undefined && employee[field] !== null) {
        return employee[field];
      }
      return def;
    };

    const getDeductionVal = (field, def) => {
      if (activeRevision && activeRevision.deductions && activeRevision.deductions[field] !== undefined && activeRevision.deductions[field] !== null) {
        return activeRevision.deductions[field];
      }
      if (employee.deductions && employee.deductions[field] !== undefined && employee.deductions[field] !== null) {
        return employee.deductions[field];
      }
      return def;
    };

    const getStructureVal = (field, def) => {
      if (activeRevision && activeRevision.salaryStructure && activeRevision.salaryStructure[field] !== undefined && activeRevision.salaryStructure[field] !== null) {
        return activeRevision.salaryStructure[field];
      }
      if (employee.salaryStructure && employee.salaryStructure[field] !== undefined && employee.salaryStructure[field] !== null) {
        return employee.salaryStructure[field];
      }
      return def;
    };

    let monthlyCTC = Number(activeRevision.newCTC) || Number(activeRevision.monthlyCTC) || 0;
    if (!monthlyCTC && activeRevision === revisions[0]) {
      monthlyCTC = Number(revisions[0].previousCTC) || Number(employee.monthlyCTC) || 0;
    }

    const resObj = {
      monthlyCTC,
      employmentType: getVal('employmentType', 'full-time'),
      payType: getVal('payType', 'salaried'),
      hourlyRate: getVal('hourlyRate', 0),
      pfEnabled: getVal('pfEnabled', true),
      esiEnabled: getVal('esiEnabled', true),
      ptEnabled: getVal('ptEnabled', true),
      ptState: getVal('ptState', ''),
      lwfEnabled: getVal('lwfEnabled', true),
      gratuityEnabled: getVal('gratuityEnabled', true),
      includePfInCTC: getVal('includePfInCTC', false),
      includeGratuityInCTC: getVal('includeGratuityInCTC', true),
      basicPercent: getVal('basicPercent', null),
      hraPercent: getVal('hraPercent', null),
      useSalaryComponents: getVal('useSalaryComponents', true),
      joiningBonus: getVal('joiningBonus', 0),
      flexiAmount: getVal('flexiAmount', 0),
      broadband: getVal('broadband', 0),
      petrol: getVal('petrol', 0),
      lta: getVal('lta', 0),
      employerNPS: getVal('employerNPS', 0),
      insuranceAmount: getVal('insuranceAmount', 0),
      deductions: {
        tds: getDeductionVal('tds', 0),
        professionalTax: getDeductionVal('professionalTax', 0),
        otherDeductions: getDeductionVal('otherDeductions', []),
      },
      salaryStructure: {
        conveyance: getStructureVal('conveyance', 0),
        medicalAllowance: getStructureVal('medicalAllowance', 0),
        otherAllowances: getStructureVal('otherAllowances', []),
      },
    };

    if (config?.salaryComponents) {
      config.salaryComponents.forEach(c => {
        const pctKey = `${c.id}Percent`;
        resObj[pctKey] = getVal(pctKey, null);
        resObj[c.id] = getVal(c.id, null);
        if (c.type === 'deduction') {
          resObj.deductions[c.id] = getDeductionVal(c.id, null);
        } else {
          resObj.salaryStructure[c.id] = getStructureVal(c.id, null);
        }
      });
    }

    return resObj;
  };

  const totalDaysInMonth = new Date(year, month, 0).getDate();
  const dailyStructures = [];
  const dailyOtherAllowances = [];
  const dailyOtherDeductions = [];

  const isHourly = employee.payType === 'hourly';
  const hoursWorked = isHourly ? (Number(attendance?.hoursWorked) || Number(adjustments?.hoursWorked) || Number(employee.hoursWorked) || 0) : 0;

  for (let d = 1; d <= totalDaysInMonth; d++) {
    const currentStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const activeParams = getEmployeeParamsForDate(currentStr);
    
    const daySource = {
      ...activeParams,
      hoursWorked: isHourly ? hoursWorked : undefined,
      pfEnabled: adjustments.pfEnabled !== undefined ? adjustments.pfEnabled : activeParams.pfEnabled,
      esiEnabled: adjustments.esiEnabled !== undefined ? adjustments.esiEnabled : activeParams.esiEnabled,
      ptEnabled: adjustments.ptEnabled !== undefined ? adjustments.ptEnabled : activeParams.ptEnabled,
      ptState: adjustments.ptState !== undefined ? adjustments.ptState : activeParams.ptState,
      lwfEnabled: adjustments.lwfEnabled !== undefined ? adjustments.lwfEnabled : activeParams.lwfEnabled,
      gratuityEnabled: adjustments.gratuityEnabled !== undefined ? adjustments.gratuityEnabled : activeParams.gratuityEnabled,
      includePfInCTC: adjustments.includePfInCTC !== undefined ? adjustments.includePfInCTC : activeParams.includePfInCTC,
      includeGratuityInCTC: adjustments.includeGratuityInCTC !== undefined ? adjustments.includeGratuityInCTC : activeParams.includeGratuityInCTC,
      basicPercent: adjustments.basicPercent !== undefined && adjustments.basicPercent !== null ? adjustments.basicPercent : activeParams.basicPercent,
      hraPercent: adjustments.hraPercent !== undefined && adjustments.hraPercent !== null ? adjustments.hraPercent : activeParams.hraPercent,
      // Thread month/year so getMonthlyPT can apply the MH February rule
      _month: month,
      _year: year,
    };

    // Copy custom percentage overrides and component overrides from activeParams and adjustments to daySource
    Object.keys(activeParams).forEach(key => {
      if (key.endsWith('Percent') || (config.salaryComponents && config.salaryComponents.some(c => c.id === key || `${c.id}Percent` === key))) {
        daySource[key] = activeParams[key];
      }
    });
    Object.keys(adjustments).forEach(key => {
      if ((key.endsWith('Percent') || (config.salaryComponents && config.salaryComponents.some(c => c.id === key || `${c.id}Percent` === key))) && adjustments[key] !== undefined && adjustments[key] !== null) {
        daySource[key] = adjustments[key];
      }
    });

    const dayMaster = buildMasterSalaryStructure(daySource, config);
    dailyStructures.push(dayMaster);
    dailyOtherAllowances.push(daySource.salaryStructure?.otherAllowances || []);
    dailyOtherDeductions.push(daySource.deductions?.otherDeductions || []);
  }

  const master = {};
  const sample = dailyStructures[0] || {};
  for (const [key, val] of Object.entries(sample)) {
    if (typeof val === 'number') {
      let sum = 0;
      for (const ds of dailyStructures) {
        sum += ds[key] || 0;
      }
      master[key] = roundAmount(sum / totalDaysInMonth);
    } else if (typeof val === 'boolean') {
      master[key] = dailyStructures[dailyStructures.length - 1][key];
    } else {
      master[key] = val;
    }
  }

  const averagedEarningsMap = {};
  for (const ds of dailyStructures) {
    if (ds.earningsMap) {
      for (const [key, val] of Object.entries(ds.earningsMap)) {
        averagedEarningsMap[key] = (averagedEarningsMap[key] || 0) + val;
      }
    }
  }
  for (const key of Object.keys(averagedEarningsMap)) {
    averagedEarningsMap[key] = roundAmount(averagedEarningsMap[key] / totalDaysInMonth);
  }
  master.earningsMap = averagedEarningsMap;

  const allowanceMap = {};
  for (let i = 0; i < totalDaysInMonth; i++) {
    const list = dailyOtherAllowances[i] || [];
    for (const item of list) {
      if (item.name) {
        allowanceMap[item.name] = (allowanceMap[item.name] || 0) + (Number(item.amount) || 0) / totalDaysInMonth;
      }
    }
  }
  const averagedOtherAllowances = Object.entries(allowanceMap).map(([name, amount]) => ({
    name,
    amount: roundAmount(amount)
  }));

  const deductionMap = {};
  for (let i = 0; i < totalDaysInMonth; i++) {
    const list = dailyOtherDeductions[i] || [];
    for (const item of list) {
      if (item.name) {
        deductionMap[item.name] = (deductionMap[item.name] || 0) + (Number(item.amount) || 0) / totalDaysInMonth;
      }
    }
  }
  const averagedOtherDeductions = Object.entries(deductionMap).map(([name, amount]) => ({
    name,
    amount: roundAmount(amount)
  }));

  const requestedWorkingDays = Number(attendance?.workingDays);
  const workingDays = Math.max(requestedWorkingDays || config.defaultWorkingDays, 1);
  // If the sync payload provides paidDays (which now includes weekoffs + holidays), use it.
  // If only presentDays is available (manual entry), compute paidDays by adding weekoffs and
  // holidays so that those off-days are correctly treated as paid days.
  const rawPaidDays = isHourly ? workingDays : (() => {
    if (attendance?.paidDays != null) return Number(attendance.paidDays);
    const present = Number(attendance?.presentDays ?? 0);
    const weeklyOffs = Number(attendance?.weeklyOffDays ?? 0);
    const holidays = Number(attendance?.holidayDays ?? 0);
    const paidLeaves = Number(attendance?.paidLeaves ?? 0);
    return present + weeklyOffs + holidays + paidLeaves || workingDays;
  })();
  const paidDays = isHourly ? workingDays : roundAmount(clamp(rawPaidDays, 0, workingDays));
  const prorate = isHourly ? 1.0 : Math.min(paidDays / workingDays, 1);
  const lop = isHourly ? 0 : roundAmount(Math.max(workingDays - paidDays, 0));

  const segments = [];
  let currentSegment = null;

  for (let d = 1; d <= totalDaysInMonth; d++) {
    const currentStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const activeParams = getEmployeeParamsForDate(currentStr);
    const key = `${activeParams.monthlyCTC}-${activeParams.pfEnabled}-${activeParams.esiEnabled}-${activeParams.gratuityEnabled}`;

    if (!currentSegment || currentSegment.key !== key) {
      if (currentSegment) {
        segments.push(currentSegment);
      }
      currentSegment = {
        key,
        startDay: d,
        endDay: d,
        activeParams,
        daysCount: 1
      };
    } else {
      currentSegment.endDay = d;
      currentSegment.daysCount += 1;
    }
  }
  if (currentSegment) {
    segments.push(currentSegment);
  }

  const lopStrategy = adjustments.lopStrategy || 'proportional';
  const customSegmentLops = adjustments.segmentLops || [];
  const segmentLops = isHourly
    ? new Array(segments.length).fill(0)
    : getSegmentLops(workingDays - paidDays, workingDays, totalDaysInMonth, lopStrategy, segments, customSegmentLops);
  const dayProrate = isHourly
    ? new Array(totalDaysInMonth).fill(1.0)
    : getDayProrateArray(totalDaysInMonth, workingDays, paidDays, lopStrategy, customSegmentLops, segments);

  let otherEarnings = [];
  if (Array.isArray(adjustments.otherEarnings) && adjustments.otherEarnings.length > 0) {
    otherEarnings = adjustments.otherEarnings.map(item => ({
      name: item.name,
      amount: roundAmount(item.amount)
    }));
  } else {
    const otherEarningsMap = {};
    for (let d = 0; d < totalDaysInMonth; d++) {
      const list = dailyOtherAllowances[d] || [];
      for (const item of list) {
        if (item.name) {
          otherEarningsMap[item.name] = (otherEarningsMap[item.name] || 0) + (Number(item.amount) || 0) * dayProrate[d] / totalDaysInMonth;
        }
      }
    }
    otherEarnings = Object.entries(otherEarningsMap).map(([name, amount]) => ({
      name,
      amount: roundAmount(amount)
    }));
  }

  let otherDeductions = [];
  if (Array.isArray(adjustments.otherDeductions) && adjustments.otherDeductions.length > 0) {
    otherDeductions = adjustments.otherDeductions.map(item => ({
      name: item.name,
      amount: roundAmount(item.amount)
    }));
  } else {
    otherDeductions = averagedOtherDeductions.map(item => ({
      name: item.name,
      amount: roundAmount(Number(item.amount) || 0)
    }));
  }

  const isMatchingFrequency = (freq, mNum) => {
    if (!freq || freq === 'monthly') return true;
    const m = Number(mNum) || Number(attendance?.month) || Number(adjustments?.month) || (new Date().getMonth() + 1);
    if (freq === 'quarterly') return m % 3 === 0;
    if (freq === 'semi_annually') return m % 6 === 0;
    if (freq === 'annually') return m % 12 === 0;
    return true;
  };

  const hasDynamicComponents = config.salaryComponents && config.salaryComponents.length > 0;
  let earnings = {};

  if (hasDynamicComponents) {
    earnings = {
      otherEarnings: [...otherEarnings],
      overtime: roundAmount(adjustments.overtime),
    };
    config.salaryComponents.forEach(c => {
      if (c.type === 'earning') {
        let sumEarningVal = 0;
        for (let d = 0; d < totalDaysInMonth; d++) {
          const ds = dailyStructures[d];
          const dailyVal = ds.earningsMap?.[c.id] ?? ds[c.id] ?? 0;
          sumEarningVal += (dailyVal / totalDaysInMonth) * dayProrate[d];
        }
        let proratedVal = roundAmount(sumEarningVal);
        if (!isMatchingFrequency(c.frequency, monthNum)) {
          proratedVal = 0;
        }
        earnings[c.id] = proratedVal;
        
        if (c.id === 'basic') earnings.basic = proratedVal;
        else if (c.id === 'hra') earnings.hra = proratedVal;
        else if (c.id === 'flexi') earnings.flexiAmount = proratedVal;
        else if (c.id === 'broadband') earnings.broadband = proratedVal;
        else if (c.id === 'petrol') earnings.petrol = proratedVal;
        else if (c.id === 'lta') earnings.lta = proratedVal;
        else if (c.id === 'special') earnings.specialAllowance = proratedVal;
        else if (c.id === 'conveyance') earnings.conveyance = proratedVal;
        else if (c.id === 'medical') earnings.medicalAllowance = proratedVal;
      }
    });

    const averagedEarningsMap = {};
    config.salaryComponents.forEach(c => {
      if (c.type === 'earning') {
        averagedEarningsMap[c.id] = earnings[c.id] || 0;
      }
    });
    earnings.earningsMap = averagedEarningsMap;

    earnings.totalEarnings = roundAmount(
      config.salaryComponents
        .filter(c => c.type === 'earning')
        .reduce((sum, c) => {
          const standardEarningIds = ['basic', 'hra', 'flexi', 'broadband', 'petrol', 'lta', 'special', 'conveyance', 'medical'];
          if (!standardEarningIds.includes(c.id)) return sum;
          return sum + (earnings[c.id] || 0);
        }, 0) +
      earnings.overtime +
      sumNamedAmounts(earnings.otherEarnings) +
      Object.entries(averagedEarningsMap)
        .filter(([key]) => !['basic', 'hra', 'flexi', 'broadband', 'petrol', 'lta', 'special', 'conveyance', 'medical'].includes(key))
        .reduce((sum, [, val]) => sum + val, 0)
    );
  } else {
    const sumDailyComponent = (compField) => {
      let sum = 0;
      for (let d = 0; d < totalDaysInMonth; d++) {
        sum += (dailyStructures[d][compField] / totalDaysInMonth) * dayProrate[d];
      }
      return roundAmount(sum);
    };

    earnings = {
      basic: sumDailyComponent('basicMaster'),
      hra: sumDailyComponent('hraMaster'),
      flexiAmount: sumDailyComponent('flexi'),
      broadband: sumDailyComponent('broadband'),
      petrol: sumDailyComponent('petrol'),
      lta: sumDailyComponent('lta'),
      specialAllowance: sumDailyComponent('specialAllowance'),
      overtime: roundAmount(adjustments.overtime),
      conveyance: sumDailyComponent('conveyance'),
      medicalAllowance: sumDailyComponent('medicalAllowance'),
      otherEarnings,
    };
    earnings.totalEarnings = roundAmount(
      Object.values(earnings).filter((value) => typeof value === 'number').reduce((sum, value) => sum + value, 0) +
      sumNamedAmounts(earnings.otherEarnings)
    );
  }

  let sumPfEmployee = 0;
  let sumPfEmployer = 0;
  let sumEsiEmployee = 0;
  let sumEsiEmployer = 0;
  let sumGratuity = 0;
  for (let d = 0; d < totalDaysInMonth; d++) {
    const ds = dailyStructures[d];
    const dP = dayProrate[d];

    // 1. PF daily proration
    sumPfEmployee += (ds.pfEmployee / totalDaysInMonth) * dP;
    sumPfEmployer += (ds.pfEmployer / totalDaysInMonth) * dP;

    // 2. Gratuity daily proration
    sumGratuity += (ds.gratuity / totalDaysInMonth) * dP;

    // 3. ESI daily calculation on daily gross wages (excluding overtime)
    let dailyGrossForEsi = 0;
    if (hasDynamicComponents) {
      config.salaryComponents.forEach(c => {
        if (c.type === 'earning') {
          const dailyVal = ds.earningsMap?.[c.id] ?? ds[c.id] ?? 0;
          dailyGrossForEsi += (dailyVal / totalDaysInMonth) * dP;
        }
      });
    } else {
      const dailyBasic = (ds.basicMaster / totalDaysInMonth) * dP;
      const dailyHra = (ds.hraMaster / totalDaysInMonth) * dP;
      const dailyFlexi = (ds.flexi / totalDaysInMonth) * dP;
      const dailyBroadband = (ds.broadband / totalDaysInMonth) * dP;
      const dailyPetrol = (ds.petrol / totalDaysInMonth) * dP;
      const dailyLta = (ds.lta / totalDaysInMonth) * dP;
      const dailySpecial = (ds.specialAllowance / totalDaysInMonth) * dP;
      const dailyConveyance = (ds.conveyance / totalDaysInMonth) * dP;
      const dailyMedical = (ds.medicalAllowance / totalDaysInMonth) * dP;

      dailyGrossForEsi = dailyBasic + dailyHra + dailyFlexi + dailyBroadband + dailyPetrol + dailyLta + dailySpecial + dailyConveyance + dailyMedical;
    }
    dailyGrossForEsi += sumNamedAmounts(otherEarnings) / totalDaysInMonth;
 
    const dailyEsiEmployee = ds.esiApplicable ? dailyGrossForEsi * config.esiEmployeeRate : 0;
    const dailyEsiEmployer = ds.esiApplicable ? dailyGrossForEsi * config.esiEmployerRate : 0;
    sumEsiEmployee += dailyEsiEmployee;
    sumEsiEmployer += dailyEsiEmployer;
  }
  const pfEmployee = roundAmount(sumPfEmployee);
  const pfEmployer = roundAmount(sumPfEmployer);
  const gratuity = roundAmount(sumGratuity);
  const esiEmployee = roundAmount(sumEsiEmployee);
  const esiEmployer = roundAmount(sumEsiEmployer);

  const employerContributions = {
    pfEmployer,
    esiEmployer,
    gratuity,
    lwfEmployer: master.lwfEmployer,
    insuranceEmployer: master.insurance,
    nps: master.employerNPS,
    grossTotalSalary: roundAmount(
      earnings.totalEarnings +
      pfEmployer +
      gratuity +
      master.lwfEmployer +
      master.insurance +
      esiEmployer +
      master.employerNPS
    ),
  };

  const variablePay = {
    joiningBonus: roundAmount(adjustments.joiningBonus),
    loyaltyBonus: roundAmount(adjustments.loyaltyBonus),
    incentive: roundAmount(adjustments.incentive),
    specialBonus: roundAmount(adjustments.specialBonus),
    otherAllowanceArrear: roundAmount(adjustments.otherAllowanceArrear),
    performanceBonus: roundAmount(adjustments.performanceBonus),
    retentionBonus: roundAmount(adjustments.retentionBonus),
    arrear: roundAmount(adjustments.arrear),
    referralBonus: roundAmount(adjustments.referralBonus),
  };
  variablePay.totalVariablePay = roundAmount(Object.values(variablePay).reduce((sum, value) => sum + value, 0));

  const totalPayable = roundAmount(employerContributions.grossTotalSalary + variablePay.totalVariablePay);

  const averagedDeductionsMap = {};
  if (hasDynamicComponents) {
    config.salaryComponents.forEach(c => {
      if (c.type === 'deduction') {
        let sumDeductionVal = 0;
        for (let d = 0; d < totalDaysInMonth; d++) {
          const ds = dailyStructures[d];
          const dailyVal = ds.deductionsMap?.[c.id] ?? ds[c.id] ?? 0;
          sumDeductionVal += (dailyVal / totalDaysInMonth);
        }
        averagedDeductionsMap[c.id] = roundAmount(sumDeductionVal);
      }
    });
  }

  const deductions = {
    pfEmployee,
    esiEmployee,
    professionalTax: master.ptEnabled ? roundAmount(employee.deductions?.professionalTax) : 0,
    tds: roundAmount(adjustments.tds ?? (Number(employee.deductions?.tds) > 0 ? employee.deductions.tds : master.tds)),
    insuranceEmployee: roundAmount(adjustments.insuranceEmployee),
    lwfEmployee: master.lwfEmployee,
    gratuityDeduction: roundAmount(adjustments.gratuityDeduction),
    loanDeduction: roundAmount(adjustments.loanDeduction),
    advanceDeduction: roundAmount(adjustments.advanceDeduction),
    otherDeductions,
    deductionsMap: averagedDeductionsMap,
  };

  const dynamicDeductionsSum = roundAmount(Object.values(averagedDeductionsMap).reduce((sum, v) => sum + v, 0));

  deductions.totalDeductions = roundAmount(
    Object.entries(deductions)
      .filter(([key, value]) => key !== 'otherDeductions' && key !== 'deductionsMap' && typeof value === 'number')
      .reduce((sum, [, value]) => sum + value, 0) +
    sumNamedAmounts(deductions.otherDeductions) +
    dynamicDeductionsSum
  );

  const reimbursements = Array.isArray(adjustments.reimbursements) ? adjustments.reimbursements : [];
  const totalReimbursementApproved = roundAmount(reimbursements.reduce((sum, r) => sum + (Number(r.approved) || 0), 0));

  return {
    earnings,
    employerContributions,
    variablePay,
    totalPayable,
    deductions,
    reimbursements,
    totalReimbursementApproved,
    netSalary: roundAmount(Math.max(0, earnings.totalEarnings + variablePay.totalVariablePay + totalReimbursementApproved - deductions.totalDeductions)),
    lop,
    paidDays,
    workingDays,
    paidLeaves: roundAmount(attendance?.paidLeaves),
    unpaidLeaves: roundAmount(attendance?.unpaidLeaves),
    prorate: roundAmount(prorate),
    master,
    lopStrategy,
    segmentLops,
  };
};

const getSalarySplits = (employeeInput, configInput, monthNum, yearNum, paidDaysCount, workingDaysCount, adjustments = {}) => {
  const employee = (employeeInput && typeof employeeInput.toObject === 'function')
    ? employeeInput.toObject()
    : employeeInput;
  const config = normalizeConfig(configInput);
  
  const year = Number(yearNum) || new Date().getFullYear();
  const month = Number(monthNum) || (new Date().getMonth() + 1);
  const totalDaysInMonth = new Date(year, month, 0).getDate();
  
  const getYYYYMMDD = (dateVal) => {
    const dateObj = new Date(dateVal);
    if (isNaN(dateObj.getTime())) return '';
    const y = dateObj.getUTCFullYear();
    const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const getEmployeeParamsForDate = (dateStr) => {
    const revisions = [...(employee.salaryRevisions || [])].sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));
    if (revisions.length === 0) {
      return employee;
    }
    const latestRevision = revisions[revisions.length - 1];
    const latestRevDateStr = getYYYYMMDD(latestRevision.effectiveDate);
    if (dateStr >= latestRevDateStr) {
      return employee;
    }
    let activeRevision = null;
    for (let i = revisions.length - 1; i >= 0; i--) {
      const revDateStr = getYYYYMMDD(revisions[i].effectiveDate);
      if (revDateStr && revDateStr <= dateStr) {
        activeRevision = revisions[i];
        break;
      }
    }
    if (!activeRevision) {
      activeRevision = revisions[0];
    }

    const getVal = (field, def) => {
      if (activeRevision && activeRevision[field] !== undefined && activeRevision[field] !== null) {
        return activeRevision[field];
      }
      if (employee[field] !== undefined && employee[field] !== null) {
        return employee[field];
      }
      return def;
    };

    const getDeductionVal = (field, def) => {
      if (activeRevision && activeRevision.deductions && activeRevision.deductions[field] !== undefined && activeRevision.deductions[field] !== null) {
        return activeRevision.deductions[field];
      }
      if (employee.deductions && employee.deductions[field] !== undefined && employee.deductions[field] !== null) {
        return employee.deductions[field];
      }
      return def;
    };

    const getStructureVal = (field, def) => {
      if (activeRevision && activeRevision.salaryStructure && activeRevision.salaryStructure[field] !== undefined && activeRevision.salaryStructure[field] !== null) {
        return activeRevision.salaryStructure[field];
      }
      if (employee.salaryStructure && employee.salaryStructure[field] !== undefined && employee.salaryStructure[field] !== null) {
        return employee.salaryStructure[field];
      }
      return def;
    };

    let monthlyCTC = Number(activeRevision.newCTC) || Number(activeRevision.monthlyCTC) || 0;
    if (!monthlyCTC && activeRevision === revisions[0]) {
      monthlyCTC = Number(revisions[0].previousCTC) || Number(employee.monthlyCTC) || 0;
    }

    return {
      monthlyCTC,
      employmentType: getVal('employmentType', 'full-time'),
      payType: getVal('payType', 'salaried'),
      hourlyRate: getVal('hourlyRate', 0),
      pfEnabled: getVal('pfEnabled', true),
      esiEnabled: getVal('esiEnabled', true),
      ptEnabled: getVal('ptEnabled', true),
      ptState: getVal('ptState', ''),
      lwfEnabled: getVal('lwfEnabled', true),
      gratuityEnabled: getVal('gratuityEnabled', true),
      includePfInCTC: getVal('includePfInCTC', false),
      includeGratuityInCTC: getVal('includeGratuityInCTC', true),
      basicPercent: getVal('basicPercent', null),
      hraPercent: getVal('hraPercent', null),
      useSalaryComponents: getVal('useSalaryComponents', true),
      flexiAmount: getVal('flexiAmount', 0),
      broadband: getVal('broadband', 0),
      petrol: getVal('petrol', 0),
      lta: getVal('lta', 0),
      employerNPS: getVal('employerNPS', 0),
      insuranceAmount: getVal('insuranceAmount', 0),
      deductions: {
        tds: getDeductionVal('tds', 0),
        professionalTax: getDeductionVal('professionalTax', 0),
        otherDeductions: getDeductionVal('otherDeductions', []),
      },
      salaryStructure: {
        conveyance: getStructureVal('conveyance', 0),
        medicalAllowance: getStructureVal('medicalAllowance', 0),
        otherAllowances: getStructureVal('otherAllowances', []),
      },
    };
  };

  const segments = [];
  let currentSegment = null;

  for (let d = 1; d <= totalDaysInMonth; d++) {
    const currentStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const activeParams = getEmployeeParamsForDate(currentStr);
    const key = `${activeParams.monthlyCTC}-${activeParams.pfEnabled}-${activeParams.esiEnabled}-${activeParams.gratuityEnabled}`;

    if (!currentSegment || currentSegment.key !== key) {
      if (currentSegment) {
        segments.push(currentSegment);
      }
      currentSegment = {
        key,
        startDay: d,
        endDay: d,
        activeParams,
        daysCount: 1
      };
    } else {
      currentSegment.endDay = d;
      currentSegment.daysCount += 1;
    }
  }
  if (currentSegment) {
    segments.push(currentSegment);
  }

  const isHourly = employee.payType === 'hourly';
  const hoursWorked = isHourly ? (Number(adjustments?.hoursWorked) || Number(employee.hoursWorked) || 0) : 0;

  const workingDays = isHourly ? totalDaysInMonth : Math.max(Number(workingDaysCount) || config.defaultWorkingDays, 1);
  const paidDays = isHourly ? workingDays : Math.max(Math.min(Number(paidDaysCount) ?? workingDays, workingDays), 0);
  const prorate = isHourly ? 1.0 : (workingDays > 0 ? paidDays / workingDays : 1);

  const lopStrategy = adjustments.lopStrategy || 'proportional';
  const customSegmentLops = adjustments.segmentLops || [];
  const dayProrate = isHourly
    ? new Array(totalDaysInMonth).fill(1.0)
    : getDayProrateArray(totalDaysInMonth, workingDays, paidDays, lopStrategy, customSegmentLops, segments);

  return segments.map((seg) => {
    const daySource = {
      ...seg.activeParams,
      hoursWorked: isHourly ? hoursWorked : undefined,
      pfEnabled: adjustments.pfEnabled !== undefined ? adjustments.pfEnabled : seg.activeParams.pfEnabled,
      esiEnabled: adjustments.esiEnabled !== undefined ? adjustments.esiEnabled : seg.activeParams.esiEnabled,
      ptEnabled: adjustments.ptEnabled !== undefined ? adjustments.ptEnabled : seg.activeParams.ptEnabled,
      ptState: adjustments.ptState !== undefined ? adjustments.ptState : seg.activeParams.ptState,
      lwfEnabled: adjustments.lwfEnabled !== undefined ? adjustments.lwfEnabled : seg.activeParams.lwfEnabled,
      gratuityEnabled: adjustments.gratuityEnabled !== undefined ? adjustments.gratuityEnabled : seg.activeParams.gratuityEnabled,
      includePfInCTC: adjustments.includePfInCTC !== undefined ? adjustments.includePfInCTC : seg.activeParams.includePfInCTC,
      includeGratuityInCTC: adjustments.includeGratuityInCTC !== undefined ? adjustments.includeGratuityInCTC : seg.activeParams.includeGratuityInCTC,
      basicPercent: adjustments.basicPercent !== undefined && adjustments.basicPercent !== null ? adjustments.basicPercent : seg.activeParams.basicPercent,
      hraPercent: adjustments.hraPercent !== undefined && adjustments.hraPercent !== null ? adjustments.hraPercent : seg.activeParams.hraPercent,
      // Thread month/year so getMonthlyPT can apply the MH February rule
      _month: month,
      _year: year,
    };
    
    const dayMaster = buildMasterSalaryStructure(daySource, config);
    const segmentRatio = seg.daysCount / totalDaysInMonth;

    let segmentBasicSum = 0;
    let segmentPfEmployeeSum = 0;
    let segmentPfEmployerSum = 0;
    let segmentEsiEmployeeSum = 0;
    let segmentEsiEmployerSum = 0;
    let segmentGratuitySum = 0;
    let segmentProrateSum = 0;

    for (let day = seg.startDay; day <= seg.endDay; day++) {
      const dP = dayProrate[day - 1];
      segmentProrateSum += dP;
      
      const dailyBasic = (dayMaster.basicMaster / totalDaysInMonth) * dP;
      segmentBasicSum += dailyBasic;

      const dailyPfEmployee = (dayMaster.pfEmployee / totalDaysInMonth) * dP;
      const dailyPfEmployer = (dayMaster.pfEmployer / totalDaysInMonth) * dP;
      segmentPfEmployeeSum += dailyPfEmployee;
      segmentPfEmployerSum += dailyPfEmployer;

      const dailyGratuity = (dayMaster.gratuity / totalDaysInMonth) * dP;
      segmentGratuitySum += dailyGratuity;

      const dailyGrossForEsi = (dayMaster.totalEarnings / totalDaysInMonth) * dP;
      const dailyEsiEmployee = dayMaster.esiApplicable ? dailyGrossForEsi * config.esiEmployeeRate : 0;
      const dailyEsiEmployer = dayMaster.esiApplicable ? dailyGrossForEsi * config.esiEmployerRate : 0;
      segmentEsiEmployeeSum += dailyEsiEmployee;
      segmentEsiEmployerSum += dailyEsiEmployer;
    }

    const segmentProrateRatio = segmentProrateSum / totalDaysInMonth;

    const basic = roundAmount(segmentBasicSum);
    const hra = roundAmount(dayMaster.hraMaster * segmentProrateRatio);
    const flexi = roundAmount(dayMaster.flexi * segmentProrateRatio);
    const broadband = roundAmount(dayMaster.broadband * segmentProrateRatio);
    const petrol = roundAmount(dayMaster.petrol * segmentProrateRatio);
    const lta = roundAmount(dayMaster.lta * segmentProrateRatio);
    const specialAllowance = roundAmount(dayMaster.specialAllowance * segmentProrateRatio);
    const conveyance = roundAmount(dayMaster.conveyance * segmentProrateRatio);
    const medicalAllowance = roundAmount(dayMaster.medicalAllowance * segmentProrateRatio);

    const pfEmployee = roundAmount(segmentPfEmployeeSum);
    const pfEmployer = roundAmount(segmentPfEmployerSum);
    
    const esiEmployee = roundAmount(segmentEsiEmployeeSum);
    const esiEmployer = roundAmount(segmentEsiEmployerSum);

    const gratuity = roundAmount(segmentGratuitySum);
    const lwfEmployee = roundAmount(dayMaster.lwfEmployee * segmentRatio);
    const lwfEmployer = roundAmount(dayMaster.lwfEmployer * segmentRatio);
    const insurance = roundAmount(dayMaster.insurance * segmentRatio);
    const nps = roundAmount(dayMaster.employerNPS * segmentRatio);
    
    const totalEarnings = roundAmount(basic + hra + flexi + broadband + petrol + lta + specialAllowance + conveyance + medicalAllowance);

    return {
      startDate: new Date(Date.UTC(year, month - 1, seg.startDay)),
      endDate: new Date(Date.UTC(year, month - 1, seg.endDay)),
      daysCount: seg.daysCount,
      monthlyCTC: dayMaster.monthlyCTC,
      basic,
      hra,
      flexi,
      broadband,
      petrol,
      lta,
      specialAllowance,
      conveyance,
      medicalAllowance,
      pfEmployee,
      pfEmployer,
      esiEmployee,
      esiEmployer,
      gratuity,
      lwfEmployee,
      lwfEmployer,
      insurance,
      nps,
      totalEarnings,
    };
  });
};

// =============================================================================
// STATUTORY GRATUITY ENTITLEMENT (Payment of Gratuity Act, 1972 — Section 4)
// =============================================================================
// IMPORTANT: This is NOT the monthly CTC-provisioning gratuity (basicMaster ×
// 4.81%) used for salary structuring — that calculation is untouched above.
// This function computes the actual one-time gratuity payable at separation
// (Full & Final Settlement) under statute.
//
// Formula: (Basic + DA) × 15/26 × completed years of service
//
// Years-of-service rounding rule:
//   Per Section 2A of the Act and the Supreme Court ruling in Mettur Beardsell
//   Ltd v. Regional Labour Commissioner (1998 ILLJ 180 Mad), after counting
//   complete years:
//     - Remaining months < 6  → discarded (round down)
//     - Remaining months >= 6 → treated as a full year (round up)
//   Employers who prefer always-round-down can adjust the final amount
//   manually in the Full & Final Settlement (Gap 2b).
//
// Eligibility: minimum 5 years of continuous service (Section 4(1)).
//
// Statutory cap: ₹20,00,000 — Payment of Gratuity (Amendment) Act, 2018.
//   Source: Ministry of Labour & Employment notification S.O. 1420(E), 29 Mar 2018.
//   (Note: The government has announced but not yet notified a further increase;
//   ₹20 lakh is the currently enforceable ceiling as of FY 2025-26.)
//
// DA note: Most private-sector employers in India pay 0 DA (DA is merged into
// Basic in the CTC structure). This function accepts a single `basicPlusDa`
// parameter — callers should pass Basic alone if DA is nil.

/**
 * @param {Date|string} joiningDate
 * @param {Date|string} separationDate — date of leaving; pass new Date() for active employees
 * @param {number}      basicPlusDa    — monthly (Basic + DA) at time of separation
 * @returns {{
 *   eligible: boolean,
 *   completedYears: number,
 *   completedMonths: number,
 *   roundedYears: number,
 *   entitlement: number,
 *   cappedEntitlement: number,
 *   isCapped: boolean,
 *   note: string
 * }}
 */
const calculateGratuityEntitlement = (joiningDate, separationDate, basicPlusDa) => {
  const GRATUITY_CAP = 2000000; // ₹20,00,000 — S.O. 1420(E), 29 Mar 2018
  const MIN_SERVICE_YEARS = 5;  // Section 4(1), Payment of Gratuity Act 1972

  const joining    = new Date(joiningDate);
  const separation = new Date(separationDate || Date.now());

  // Validate inputs
  if (
    isNaN(joining.getTime()) ||
    isNaN(separation.getTime()) ||
    separation <= joining
  ) {
    return {
      eligible: false,
      completedYears: 0,
      completedMonths: 0,
      roundedYears: 0,
      entitlement: 0,
      cappedEntitlement: 0,
      isCapped: false,
      note: 'Invalid dates — joining date must be before separation date.',
    };
  }

  // Compute precise service duration
  let years  = separation.getFullYear() - joining.getFullYear();
  let months = separation.getMonth()   - joining.getMonth();
  let days   = separation.getDate()    - joining.getDate();

  // Normalise negative days into months
  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(separation.getFullYear(), separation.getMonth(), 0);
    days += prevMonth.getDate();
  }
  // Normalise negative months into years
  if (months < 0) {
    years  -= 1;
    months += 12;
  }

  const totalMonths = years * 12 + months;

  // 6-month rounding rule (see header comment for legal basis)
  const roundedYears = years + (months >= 6 ? 1 : 0);
  const roundingNote = months >= 6
    ? `${months} months in final year ≥ 6 → rounded up to full year.`
    : months > 0
      ? `${months} months in final year < 6 → discarded.`
      : '';

  if (years < MIN_SERVICE_YEARS) {
    const yearsRemaining = MIN_SERVICE_YEARS - years;
    const monthsRemaining = months > 0 ? (12 - months) : 0;
    const note = monthsRemaining > 0
      ? `Ineligible. Requires ${yearsRemaining} year(s) and ${monthsRemaining} more month(s) of service.`
      : `Ineligible. Requires ${yearsRemaining} more year(s) of service.`;
    return {
      eligible: false,
      completedYears: years,
      completedMonths: totalMonths,
      roundedYears: 0,
      entitlement: 0,
      cappedEntitlement: 0,
      isCapped: false,
      note,
    };
  }

  // Statutory formula: (Basic + DA) × 15/26 × roundedYears
  const gross       = Number(basicPlusDa) || 0;
  const entitlement = roundAmount(gross * 15 / 26 * roundedYears);
  const capped      = Math.min(entitlement, GRATUITY_CAP);
  const isCapped    = entitlement > GRATUITY_CAP;

  const note = [
    `Eligible. ${years} completed year(s), ${months} month(s).`,
    roundingNote,
    isCapped ? `Entitlement (₹${entitlement.toLocaleString('en-IN')}) exceeds statutory cap — capped at ₹20,00,000.` : '',
  ].filter(Boolean).join(' ');

  return {
    eligible: true,
    completedYears: years,
    completedMonths: totalMonths,
    roundedYears,
    entitlement,
    cappedEntitlement: capped,
    isCapped,
    note,
  };
};

module.exports = {
  DEFAULT_PAYROLL_CONFIG,
  roundAmount,
  sumNamedAmounts,
  normalizeConfig,
  getMonthlyCTCValue,
  calculateHRAExemption,
  calculateTaxForRegime,
  calculateTaxDetails,
  buildMasterSalaryStructure,
  buildPayrollSnapshot,
  getSalarySplits,
  calculateGratuityEntitlement,
};
