const { getMonthlyPT } = require('../professionalTaxSlabs');
const { roundAmount, sumNamedAmounts, clamp, getSegmentLops, getDayProrateArray } = require('./prorationUtils');
const { calculateHRAExemption, calculateTaxForRegime, calculateTaxDetails } = require('./taxCalculator');
const { getMonthlyCTCValue, resolveStrategyMonthlyCTC } = require('./compensationStrategies');
const { computeStatutoryComponents } = require('./statutoryEngine');

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
  standardMonthlyHours: 160,
  compensationTypeDefaults: {},
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
    standardMonthlyHours: getNum(cfg.standardMonthlyHours, DEFAULT_PAYROLL_CONFIG.standardMonthlyHours),
    compensationTypeDefaults: cfg.compensationTypeDefaults || DEFAULT_PAYROLL_CONFIG.compensationTypeDefaults,
    salaryComponents: cfg.salaryComponents || null,
  };
};

const buildMasterSalaryStructure = (source = {}, configInput = {}) => {
  const config = normalizeConfig(configInput);
  const { monthlyCTC: computedMonthlyCTC, compType } = resolveStrategyMonthlyCTC(source);
  let monthlyCTC = computedMonthlyCTC;

  const isIntern = source.employmentType === 'intern' || compType === 'stipend_intern';
  const isHourly = source.payType === 'hourly' || compType === 'hourly';
  const isFlat = source.payType === 'flat' || compType === 'flat_project' || compType === 'project_based';
  const isNonSalariedType = ['hourly', 'daily_wage', 'piece_rate', 'flat_project', 'project_based', 'milestone', 'milestone_based', 'commission_only', 'stipend_intern', 'retainer', 'timesheet_based'].includes(compType);

  const useComponents = source.useSalaryComponents !== false && !isIntern && !isHourly && !isFlat && !isNonSalariedType;

  // Toggles integration — non-salaried contractor strategies turn off standard statutory by default unless user toggles on
  const pfEnabled = !isIntern && !isHourly && !isFlat && !isNonSalariedType && source.pfEnabled !== false;
  const esiEnabled = !isIntern && !isHourly && !isFlat && !isNonSalariedType && source.esiEnabled !== false;
  const ptEnabled = !isIntern && !isHourly && !isFlat && source.ptEnabled !== false;
  const lwfEnabled = !isIntern && !isHourly && !isFlat && !isNonSalariedType && source.lwfEnabled !== false;
  const gratuityEnabled = !isIntern && !isHourly && !isFlat && !isNonSalariedType && source.gratuityEnabled !== false;
  const includePfInCTC = pfEnabled && source.includePfInCTC === true;
  const includeGratuityInCTC = gratuityEnabled && source.includeGratuityInCTC !== false;

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

  const { pfEmployer, pfEmployee, pfBase, gratuity, lwfEmployer, lwfEmployee } = computeStatutoryComponents({
    pfEnabled,
    gratuityEnabled,
    lwfEnabled,
    monthlyCTC,
    basicMaster,
    config,
    includePfInCTC,
    includeGratuityInCTC
  });

  const insurance = monthlyCTC > 0 ? roundAmount(source.insuranceAmount ?? config.defaultInsurance) : 0;
  const employerNPS = roundAmount(source.employerNPS);

  const otherAllowances = source.salaryStructure?.otherAllowances || source.otherAllowances || [];
  const otherAllowancesSum = roundAmount(otherAllowances.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));

  let flexi = 0, broadband = 0, petrol = 0, lta = 0, ltaCap = 0, conveyance = 0, medicalAllowance = 0, specialAllowance = 0;

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

  const pass1TotalEarnings = hasDynamicComponents
    ? roundAmount(Object.values(earningsMap).reduce((sum, v) => sum + v, 0) + otherAllowancesSum)
    : roundAmount(basicMaster + hraMaster + flexi + broadband + petrol + lta + specialAllowance + conveyance + medicalAllowance + otherAllowancesSum);

  const esiApplicable = esiEnabled && (pass1TotalEarnings <= config.esiBasicThreshold);
  const esiEmployer = roundAmount(esiApplicable ? basicMaster * config.esiEmployerRate : 0);
  const esiEmployee = roundAmount(esiApplicable ? basicMaster * config.esiEmployeeRate : 0);

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

  const grossSalary = totalEarnings;
  const totalEmployerContributions = roundAmount(
    pfEmployer + esiEmployer + gratuity + lwfEmployer + insurance + employerNPS
  );

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

  const master = buildMasterSalaryStructure({ ...employee, _month: month }, config);
  const totalDays = new Date(year, month, 0).getDate();
  const workingDays = Number(attendance?.workingDays) || config.defaultWorkingDays || totalDays;
  const paidDaysRaw = Number(attendance?.paidDays);
  const paidDays = Number.isFinite(paidDaysRaw) ? Math.min(paidDaysRaw, workingDays) : workingDays;
  const lopDays = Math.max(0, workingDays - paidDays);

  const prorationRatio = workingDays > 0 ? Math.min(paidDays / workingDays, 1) : 1;

  const proratedBasic = roundAmount(master.basicMaster * prorationRatio);
  const proratedHra = roundAmount(master.hraMaster * prorationRatio);
  const proratedSpecial = roundAmount(master.specialAllowance * prorationRatio);
  const proratedFlexi = roundAmount(master.flexi * prorationRatio);
  const proratedBroadband = roundAmount(master.broadband * prorationRatio);
  const proratedPetrol = roundAmount(master.petrol * prorationRatio);
  const proratedLta = roundAmount(master.lta * prorationRatio);
  const proratedConveyance = roundAmount(master.conveyance * prorationRatio);
  const proratedMedical = roundAmount(master.medicalAllowance * prorationRatio);

  const customAllowances = employee.salaryStructure?.customAllowances || employee.customAllowances || [];
  const proratedCustomAllowances = customAllowances.map(a => ({
    name: a.name,
    amount: roundAmount((Number(a.amount) || 0) * prorationRatio)
  }));
  const customAllowancesSum = roundAmount(proratedCustomAllowances.reduce((sum, a) => sum + a.amount, 0));

  const totalProratedEarnings = roundAmount(
    proratedBasic + proratedHra + proratedSpecial + proratedFlexi +
    proratedBroadband + proratedPetrol + proratedLta + proratedConveyance +
    proratedMedical + customAllowancesSum
  );

  let pfEmployee = 0, pfEmployer = 0;
  if (master.pfEnabled && master.basicMaster > 0 && master.monthlyCTC > 0) {
    if (config.pfCalculationType === 'fixed') {
      pfEmployer = roundAmount(config.pfAmountEmployer);
      pfEmployee = roundAmount(config.pfAmountEmployee);
    } else {
      const proratedPfBase = Math.min(proratedBasic, config.pfCap);
      pfEmployee = roundAmount(proratedPfBase * config.pfRate);
      pfEmployer = roundAmount(proratedPfBase * config.pfEmployerRate);
    }
  }

  const esiApplicable = master.esiEnabled && (totalProratedEarnings <= config.esiBasicThreshold);
  const esiEmployee = roundAmount(esiApplicable ? totalProratedEarnings * config.esiEmployeeRate : 0);
  const esiEmployer = roundAmount(esiApplicable ? totalProratedEarnings * config.esiEmployerRate : 0);

  const ptEnabled = master.ptEnabled;
  const manualPT = Number(employee.deductions?.professionalTax) || 0;
  const computedPT = (ptEnabled && employee.ptState) ? getMonthlyPT(employee.ptState, totalProratedEarnings, month) : 0;
  const professionalTax = ptEnabled ? (manualPT > 0 ? manualPT : computedPT) : 0;

  const lwfEmployer = (master.lwfEnabled && master.monthlyCTC > 0) ? roundAmount(config.lwfEmployer) : 0;
  const lwfEmployee = (master.lwfEnabled && master.monthlyCTC > 0) ? roundAmount(config.lwfEmployee) : 0;
  const gratuity = master.gratuityEnabled ? roundAmount(proratedBasic * config.gratuityRate) : 0;

  const tds = master.tds;

  const customDeductions = employee.deductions?.customDeductions || employee.customDeductions || [];
  const customDeductionsSum = roundAmount(customDeductions.reduce((sum, d) => sum + (Number(d.amount) || 0), 0));

  const totalDeductions = roundAmount(
    pfEmployee + esiEmployee + professionalTax + tds + lwfEmployee + customDeductionsSum
  );

  const netSalary = roundAmount(Math.max(0, totalProratedEarnings - totalDeductions));

  return {
    employeeId: employee._id,
    month,
    year,
    workingDays,
    paidDays,
    lopDays,
    prorationRatio,
    basic: proratedBasic,
    hra: proratedHra,
    specialAllowance: proratedSpecial,
    flexi: proratedFlexi,
    broadband: proratedBroadband,
    petrol: proratedPetrol,
    lta: proratedLta,
    conveyance: proratedConveyance,
    medicalAllowance: proratedMedical,
    customAllowances: proratedCustomAllowances,
    customAllowancesSum,
    totalEarnings: totalProratedEarnings,
    grossSalary: totalProratedEarnings,
    pfEmployee,
    pfEmployer,
    esiEmployee,
    esiEmployer,
    professionalTax,
    tds,
    lwfEmployee,
    lwfEmployer,
    gratuity,
    customDeductions,
    customDeductionsSum,
    totalDeductions,
    netSalary,
    masterStructure: master,
  };
};

const parseBoolVal = (val, def = true) => {
  if (val === false || val === 'false') return false;
  if (val === true || val === 'true') return true;
  return def;
};

const processCalculatedSalary = (calculatedSalary = {}, config = {}, annualCTC, monthlyCTC) => {
  const source = {
    ...calculatedSalary,
    annualCTC: annualCTC ? String(annualCTC) : calculatedSalary.annualCTC,
    monthlyCTC: monthlyCTC ? String(monthlyCTC) : calculatedSalary.monthlyCTC,
    compensationType: calculatedSalary.compensationType || calculatedSalary.payType || 'monthly_salary',
    attendanceMode: calculatedSalary.attendanceMode || 'attendance',
    basicPercent: calculatedSalary.basicPercent !== undefined && calculatedSalary.basicPercent !== null ? Number(calculatedSalary.basicPercent) : 50,
    hraPercent: calculatedSalary.hraPercent !== undefined && calculatedSalary.hraPercent !== null ? Number(calculatedSalary.hraPercent) : 50,
    vpfPercent: calculatedSalary.vpfPercent !== undefined && calculatedSalary.vpfPercent !== null ? Number(calculatedSalary.vpfPercent) : 0,
    pfEnabled: parseBoolVal(calculatedSalary.pfEnabled, true),
    esiEnabled: parseBoolVal(calculatedSalary.esiEnabled, true),
    ptEnabled: parseBoolVal(calculatedSalary.ptEnabled, true),
    lwfEnabled: parseBoolVal(calculatedSalary.lwfEnabled, true),
    gratuityEnabled: parseBoolVal(calculatedSalary.gratuityEnabled, true),
    tdsEnabled: parseBoolVal(calculatedSalary.tdsEnabled, true),
    includePfInCTC: parseBoolVal(calculatedSalary.includePfInCTC, false),
    includeGratuityInCTC: parseBoolVal(calculatedSalary.includeGratuityInCTC, true),
    useSalaryComponents: parseBoolVal(calculatedSalary.useSalaryComponents, true),
    ptState: calculatedSalary.ptState || 'MH',
    insuranceAmount: parseFloat(calculatedSalary.insuranceAmount) || 0,
    employerNPS: parseFloat(calculatedSalary.employerNPS) || 0,
    hourlyRate: parseFloat(calculatedSalary.hourlyRate) || 0,
    hoursWorked: parseFloat(calculatedSalary.hoursWorked) || 160,
    dailyRate: parseFloat(calculatedSalary.dailyRate) || 0,
    weeklyRate: parseFloat(calculatedSalary.weeklyRate) || 0,
    projectFee: parseFloat(calculatedSalary.projectFee) || 0,
    milestoneAmount: parseFloat(calculatedSalary.milestoneAmount) || 0,
    commissionNotes: calculatedSalary.commissionNotes || '',
    joiningBonus: parseFloat(calculatedSalary.joiningBonus) || 0,
    rateCard: Array.isArray(calculatedSalary.rateCard) ? calculatedSalary.rateCard : [],
    otherAllowances: Array.isArray(calculatedSalary.customAllowances) ? calculatedSalary.customAllowances : (Array.isArray(calculatedSalary.otherAllowances) ? calculatedSalary.otherAllowances : []),
    otherDeductions: Array.isArray(calculatedSalary.customDeductions) ? calculatedSalary.customDeductions : (Array.isArray(calculatedSalary.otherDeductions) ? calculatedSalary.otherDeductions : []),
    deductions: {
      professionalTax: calculatedSalary.ptState === 'custom' ? (parseFloat(calculatedSalary.professionalTax) || 0) : 0,
    }
  };

  // Write native booleans back onto calculatedSalary so they are stored
  // as native booleans in the Map — never as strings.
  calculatedSalary.pfEnabled = source.pfEnabled;
  calculatedSalary.esiEnabled = source.esiEnabled;
  calculatedSalary.ptEnabled = source.ptEnabled;
  calculatedSalary.lwfEnabled = source.lwfEnabled;
  calculatedSalary.gratuityEnabled = source.gratuityEnabled;
  calculatedSalary.tdsEnabled = source.tdsEnabled;
  calculatedSalary.includePfInCTC = source.includePfInCTC;
  calculatedSalary.includeGratuityInCTC = source.includeGratuityInCTC;
  calculatedSalary.useSalaryComponents = source.useSalaryComponents;

  if (config.salaryComponents) {
    config.salaryComponents.forEach(c => {
      if (c.linkedTo === 'fixed') {
        let customVal = calculatedSalary[c.id];
        if (customVal === undefined && c.id === 'flexi') {
          customVal = calculatedSalary['flexiAmount'];
        }
        if (customVal === undefined && c.id === 'medical') {
          customVal = calculatedSalary['medicalAllowance'];
        }
        source[c.id] = customVal !== undefined ? parseFloat(customVal) || 0 : (c.linkValue || 0);
      }
    });
  }

  const master = buildMasterSalaryStructure(source, config);
  if (master) {
    calculatedSalary.annualCTC = String(annualCTC || master.annualCTC || 0);
    calculatedSalary.monthlyCTC = String(Math.round(monthlyCTC || master.monthlyCTC || 0));
    calculatedSalary.basic = String(master.basicMaster);
    calculatedSalary.hra = String(master.hraMaster);
    calculatedSalary.specialAllowance = String(master.specialAllowance);
    calculatedSalary.monthlyGross = String(master.totalEarnings);

    calculatedSalary.pfEmployer = String(master.pfEmployer || 0);
    calculatedSalary.pfEmployee = String(master.pfEmployee || 0);
    calculatedSalary.gratuity = String(master.gratuity || 0);
    calculatedSalary.lwfEmployer = String(master.lwfEmployer || 0);
    calculatedSalary.lwfEmployee = String(master.lwfEmployee || 0);
    calculatedSalary.esiEmployer = String(master.esiEmployer || 0);
    calculatedSalary.esiEmployee = String(master.esiEmployee || 0);
    calculatedSalary.professionalTax = String(master.professionalTax || 0);
    calculatedSalary.tds = String(master.tds || 0);
    calculatedSalary.netTakeHome = String(master.netTakeHome || 0);

    if (master.earningsMap) {
      Object.entries(master.earningsMap).forEach(([id, val]) => {
        calculatedSalary[id] = String(val);
      });
    }
  }

  return { source, master, calculatedSalary };
};

module.exports = {
  DEFAULT_PAYROLL_CONFIG,
  normalizeConfig,
  getMonthlyCTCValue,
  calculateHRAExemption,
  calculateTaxForRegime,
  calculateTaxDetails,
  buildMasterSalaryStructure,
  buildPayrollSnapshot,
  roundAmount,
  sumNamedAmounts,
  clamp,
  getSegmentLops,
  getDayProrateArray,
  resolveStrategyMonthlyCTC,
  computeStatutoryComponents,
  processCalculatedSalary,
};
