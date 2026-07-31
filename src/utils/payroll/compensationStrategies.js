const { roundAmount } = require('./prorationUtils');

const getMonthlyCTCValue = (source = {}) => {
  const monthlyCTC = Number(source.monthlyCTC);
  if (Number.isFinite(monthlyCTC) && monthlyCTC > 0) return monthlyCTC;

  const annualCTC = Number(source.annualCTC);
  if (Number.isFinite(annualCTC) && annualCTC > 0) return annualCTC / 12;

  const salaryCTC = Number(source.salaryStructure?.ctc);
  if (Number.isFinite(salaryCTC) && salaryCTC > 0) return salaryCTC;

  return 0;
};

const resolveStrategyMonthlyCTC = (source = {}) => {
  let monthlyCTC = roundAmount(getMonthlyCTCValue(source));
  const compType = source.compensationType || source.payType || 'monthly_salary';

  switch (compType) {
    case 'hourly': {
      const hours = source.hoursWorked !== undefined ? Number(source.hoursWorked) : 160;
      monthlyCTC = roundAmount((Number(source.hourlyRate) || 0) * hours);
      break;
    }
    case 'daily_wage': {
      const days = source.hoursWorked !== undefined ? Number(source.hoursWorked) : 26;
      const rate = Number(source.dailyRate) || 0;
      if (rate > 0) monthlyCTC = roundAmount(rate * days);
      break;
    }
    case 'weekly_wage':
    case 'weekly_salary': {
      const rate = Number(source.weeklyRate) || 0;
      if (rate > 0) monthlyCTC = roundAmount(rate * 4);
      break;
    }
    case 'flat_project':
    case 'project_based': {
      const fee = Number(source.projectFee) || 0;
      if (fee > 0) monthlyCTC = fee;
      break;
    }
    case 'milestone':
    case 'milestone_based': {
      const fee = Number(source.milestoneAmount) || 0;
      if (fee > 0) monthlyCTC = fee;
      break;
    }
    case 'piece_rate': {
      const rateCardEntry = (source.rateCard || []).find(r => r.paymentType === 'per_unit' || r.paymentType === 'UNIT') || (source.rateCard || [])[0];
      if (rateCardEntry && rateCardEntry.rate) {
        monthlyCTC = roundAmount(Number(rateCardEntry.rate) * (Number(source.hoursWorked) || 1));
      }
      break;
    }
    default:
      break;
  }

  return { monthlyCTC, compType };
};

module.exports = {
  getMonthlyCTCValue,
  resolveStrategyMonthlyCTC,
};
