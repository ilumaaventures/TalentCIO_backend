const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

const NamedAmountSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  amount: { type: Number, default: 0 },
}, { _id: false });

const VariableCompItemSchema = new mongoose.Schema({
  paymentType: { type: String, trim: true },
  reference: { type: String, default: '' },
  client: { type: String, default: '' },
  quantity: { type: Number, default: 1 },
  rate: { type: Number, default: 0 },
  amount: { type: Number, required: true },
  remarks: { type: String, default: '' }
}, { _id: false });

const ReimbursementItemSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  claimed: { type: Number, default: 0 },
  approved: { type: Number, default: 0 },
  billUrl: { type: String, default: '' }
}, { _id: false });

const PayrollSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  employeeCode: {
    type: String,
    trim: true,
    default: ''
  },
  month: {
    type: Number,
    required: true,
    min: 1,
    max: 12
  },
  year: {
    type: Number,
    required: true
  },
  paymentDate: {
    type: Date,
    default: null
  },
  paymentMethod: {
    type: String,
    default: 'Bank Transfer'
  },
  transactionId: {
    type: String,
    default: ''
  },

  // Attendance & Time Inputs
  workingDays: { type: Number, default: 30 },
  paidDays: { type: Number, default: 30 },
  paidLeaves: { type: Number, default: 0 },
  unpaidLeaves: { type: Number, default: 0 },
  lop: { type: Number, default: 0 },
  hoursWorked: { type: Number, default: 0 },
  attendanceSource: { type: String, enum: ['hrms', 'manual', 'default'], default: 'hrms' },
  payType: { type: String, enum: ['salaried', 'hourly'], default: 'salaried' },
  hourlyRate: { type: Number, default: 0 },
  compensationType: {
    type: String,
    default: 'monthly_salary',
    enum: [
      'monthly_salary',
      'hourly',
      'daily_wage',
      'weekly_salary',
      'piece_rate',
      'project_based',
      'milestone_based',
      'attendance_based',
      'timesheet_based',
      'commission_only',
      'salary_plus_commission',
      'retainer'
    ]
  },
  periodInput: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Earnings
  earnings: {
    basic: { type: Number, default: 0 },
    hra: { type: Number, default: 0 },
    flexiAmount: { type: Number, default: 0 },
    broadband: { type: Number, default: 0 },
    petrol: { type: Number, default: 0 },
    lta: { type: Number, default: 0 },
    specialAllowance: { type: Number, default: 0 },
    overtime: { type: Number, default: 0 },
    conveyance: { type: Number, default: 0 },
    medicalAllowance: { type: Number, default: 0 },
    otherEarnings: [NamedAmountSchema],
    variableCompensation: [VariableCompItemSchema],
    earningsMap: { type: mongoose.Schema.Types.Mixed, default: {} },
    totalEarnings: { type: Number, required: true, default: 0 }
  },

  // Employer Contributions
  employerContributions: {
    pfEmployer: { type: Number, default: 0 },
    esiEmployer: { type: Number, default: 0 },
    gratuity: { type: Number, default: 0 },
    lwfEmployer: { type: Number, default: 0 },
    insuranceEmployer: { type: Number, default: 0 },
    nps: { type: Number, default: 0 },
    grossTotalSalary: { type: Number, default: 0 }
  },

  // Variable Pay
  variablePay: {
    joiningBonus: { type: Number, default: 0 },
    loyaltyBonus: { type: Number, default: 0 },
    incentive: { type: Number, default: 0 },
    specialBonus: { type: Number, default: 0 },
    otherAllowanceArrear: { type: Number, default: 0 },
    totalVariablePay: { type: Number, default: 0 }
  },

  totalPayable: { type: Number, default: 0 },

  // Deductions
  deductions: {
    pfEmployee: { type: Number, default: 0 },
    esiEmployee: { type: Number, default: 0 },
    professionalTax: { type: Number, default: 0 },
    tds: { type: Number, default: 0 },
    insuranceEmployee: { type: Number, default: 0 },
    lwfEmployee: { type: Number, default: 0 },
    gratuityDeduction: { type: Number, default: 0 },
    loanDeduction: { type: Number, default: 0 },
    advanceDeduction: { type: Number, default: 0 },
    otherDeductions: [NamedAmountSchema],
    deductionsMap: { type: mongoose.Schema.Types.Mixed, default: {} },
    totalDeductions: { type: Number, required: true, default: 0 }
  },

  netSalary: { type: Number, required: true, default: 0 },

  status: {
    type: String,
    enum: ['draft', 'processed', 'approved', 'paid', 'cancelled'],
    default: 'draft',
    index: true
  },

  // Full and Final settlement details
  isFullAndFinal: { type: Boolean, default: false },
  settlementType: { type: String, enum: ['monthly', 'full_and_final'], default: 'monthly' },
  fnfDetails: {
    lastWorkingDay: Date,
    tenureYears: Number,
    leaveEncashmentDays: Number,
    leaveEncashmentAmount: Number,
    gratuityPayout: Number,
    noticeShortfallDeduction: Number,
    loanRecoveryDeduction: Number,
    comments: String
  },

  // Snapshot of employee state at computation time
  employeeSnapshot: {
    employeeId: String,
    employeeCode: String,
    firstName: String,
    lastName: String,
    fullName: String,
    email: String,
    department: String,
    designation: String,
    joiningDate: Date,
    monthlyCTC: Number,
    annualCTC: Number,
    pfEnabled: Boolean,
    tdsEnabled: Boolean,
    esiEnabled: Boolean,
    ptEnabled: Boolean,
    lwfEnabled: Boolean,
    gratuityEnabled: Boolean,
    includePfInCTC: Boolean,
    includeGratuityInCTC: Boolean,
    basicPercent: Number,
    hraPercent: Number,
    ptState: String,
    taxRegime: String,
    compensationType: String,
    payFrequency: String,
    attendanceMode: String
  },

  reimbursements: [ReimbursementItemSchema],
  totalReimbursementApproved: { type: Number, default: 0 },

  notes: { type: String, default: '' },
  remarks: { type: String, default: '' },

  auditLog: [{
    status: { type: String },
    changedBy: { type: String },
    changedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
    netSalary: { type: Number },
    notes: { type: String }
  }]
}, { timestamps: true });

// Compound index to guarantee uniqueness per company, employee, month, and year (active records)
PayrollSchema.index(
  { companyId: 1, user: 1, month: 1, year: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

PayrollSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Payroll', PayrollSchema);
