const mongoose = require('mongoose');

const commissionRuleSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  commissionType: { type: String, enum: ['flat_percentage', 'tiered', 'fixed_bonus'], default: 'flat_percentage' },
  basePercentage: { type: Number, default: 5 },
  tiers: [
    {
      minQuotaPercent: Number,
      bonusPercentage: Number,
    }
  ],
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const commissionRecordSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  dealId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmDeal', index: true },
  dealTitle: { type: String },
  dealValue: { type: Number, required: true },
  commissionRate: { type: Number, required: true },
  commissionAmount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['Pending', 'Approved', 'Paid', 'SyncedToPayroll'], default: 'Pending', index: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },

  // Synergy link to TalentCIO Payroll
  syncedPayrollMonth: { type: String }, // e.g. "2026-09"
  payrollBatchId: { type: mongoose.Schema.Types.ObjectId },
}, { timestamps: true });

commissionRecordSchema.index({ companyId: 1, userId: 1, status: 1 });

module.exports = {
  CrmCommissionRule: mongoose.model('CrmCommissionRule', commissionRuleSchema),
  CrmCommissionRecord: mongoose.model('CrmCommissionRecord', commissionRecordSchema),
};
