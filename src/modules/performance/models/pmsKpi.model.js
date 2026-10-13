const mongoose = require('mongoose');

const pmsKpiSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  kraId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsKra',
    required: true,
    index: true,
  },
  cycleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsCycle',
    index: true,
  },
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true },
  description: { type: String, default: '' },
  scope: {
    type: String,
    enum: ['individual', 'team', 'department', 'company'],
    default: 'individual',
  },
  measurementUnit: {
    type: String,
    enum: ['percentage', 'number', 'currency', 'hours', 'days', 'score', 'custom'],
    default: 'percentage',
  },
  measurementDirection: {
    type: String,
    enum: ['higher_is_better', 'lower_is_better', 'target_range'],
    default: 'higher_is_better',
  },
  baselineValue: { type: Number, default: 0 },
  targetValue: { type: Number, required: true },
  actualValue: { type: Number, default: 0 },
  acceptableRangeMin: { type: Number, default: 0 },
  acceptableRangeMax: { type: Number, default: 0 },
  weightage: { type: Number, default: 20, min: 0, max: 100 },
  achievementPercentage: { type: Number, default: 0 },
  calculatedScore: { type: Number, default: 0 },
  measurementFrequency: {
    type: String,
    enum: ['monthly', 'quarterly', 'half_yearly', 'annual', 'custom'],
    default: 'quarterly',
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'submitted', 'verified', 'approved'],
    default: 'active',
  },
  evidence: [
    {
      fileUrl: { type: String },
      fileName: { type: String },
      comment: { type: String },
      submittedAt: { type: Date, default: Date.now },
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
  ],
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: { type: Date },
  verificationComment: { type: String, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

pmsKpiSchema.index({ companyId: 1, kraId: 1 });
pmsKpiSchema.index({ companyId: 1, employeeId: 1, cycleId: 1 });

module.exports = mongoose.model('PmsKpi', pmsKpiSchema);
