const { roundAmount } = require('./prorationUtils');

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

module.exports = {
  calculateHRAExemption,
  calculateTaxForRegime,
  calculateTaxDetails,
};
