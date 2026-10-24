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
  templateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsKpiTemplate',
    index: true,
  },
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true },
  description: { type: String, default: '' },
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    default: null,
  },
  departmentName: { type: String, default: '' },
  designation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Designation',
    default: null,
  },
  designationName: { type: String, default: '' },
  scope: {
    type: String,
    enum: ['individual', 'team', 'department', 'company'],
    default: 'individual',
  },
  measurementType: {
    type: String,
    enum: ['percentage', 'number', 'currency', 'days', 'rating', 'yes_no', 'score', 'custom'],
    default: 'percentage',
  },
  measurementUnit: {
    type: String,
    default: 'percentage',
  },
  unit: {
    type: String,
    default: '%',
  },
  measurementDirection: {
    type: String,
    enum: ['higher_is_better', 'lower_is_better', 'target_range'],
    default: 'higher_is_better',
  },
  ratingMethod: {
    type: String,
    enum: ['automatic', 'manual'],
    default: 'automatic',
  },
  ratingScale: {
    type: String,
    default: '1-5',
  },
  baselineValue: { type: Number, default: 0 },
  targetValue: { type: Number, required: true },
  actualValue: { type: Number, default: 0 },
  acceptableRangeMin: { type: Number, default: 0 },
  acceptableRangeMax: { type: Number, default: 0 },
  weightage: { type: Number, default: 20, min: 0, max: 100 },
  achievementPercentage: { type: Number, default: 0 },
  calculatedScore: { type: Number, default: 0 },
  employeeRating: { type: Number, default: null },
  employeeComments: { type: String, default: '' },
  managerRating: { type: Number, default: null },
  managerComments: { type: String, default: '' },
  weightedScore: { type: Number, default: 0 },
  measurementFrequency: {
    type: String,
    enum: ['monthly', 'quarterly', 'half_yearly', 'annual', 'custom'],
    default: 'quarterly',
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'assigned', 'in_progress', 'submitted', 'verified', 'reviewed', 'approved', 'completed'],
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
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedAt: { type: Date, default: Date.now },
  history: [
    {
      action: String,
      actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      date: { type: Date, default: Date.now },
      details: mongoose.Schema.Types.Mixed,
    },
  ],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

pmsKpiSchema.index({ companyId: 1, kraId: 1 });
pmsKpiSchema.index({ companyId: 1, employeeId: 1, cycleId: 1 });
pmsKpiSchema.index({ companyId: 1, cycleId: 1, status: 1 });

module.exports = mongoose.model('PmsKpi', pmsKpiSchema);
