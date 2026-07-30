const mongoose = require('mongoose');

const salaryComponentSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['earning', 'deduction'], default: 'earning' },
  taxable: { type: Boolean, default: false },
  linkedTo: { type: String, enum: ['ctc_percent', 'basic_percent', 'fixed', 'remainder'], default: 'fixed' },
  linkValue: { type: Number, default: 0 },
  frequency: { type: String, default: 'monthly' }
});

const payrollConfigSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true },
  basicPercent: { type: Number, default: 0.5 },
  hraPercent: { type: Number, default: 0.5 },
  pfCalculationType: { type: String, enum: ['percent', 'fixed'], default: 'percent' },
  pfRate: { type: Number, default: 0.12 },
  pfEmployerRate: { type: Number, default: 0.12 },
  pfCap: { type: Number, default: 15000 },
  pfAmountEmployee: { type: Number, default: 1800 },
  pfAmountEmployer: { type: Number, default: 1800 },
  esiEmployeeRate: { type: Number, default: 0.0075 },
  esiEmployerRate: { type: Number, default: 0.0325 },
  esiBasicThreshold: { type: Number, default: 21000 },
  lwfEmployee: { type: Number, default: 15 },
  lwfEmployer: { type: Number, default: 35 },
  gratuityRate: { type: Number, default: 0.0481 },
  defaultWorkingDays: { type: Number, default: 30 },
  ltaMaxPercent: { type: Number, default: 0.0833 },
  defaultInsurance: { type: Number, default: 0 },
  standardMonthlyHours: { type: Number, default: 160 },
  compensationTypeDefaults: { type: mongoose.Schema.Types.Mixed, default: {} },
  salaryComponents: { type: [salaryComponentSchema], default: [] }
}, { timestamps: true });

module.exports = mongoose.model('PayrollConfig', payrollConfigSchema);
