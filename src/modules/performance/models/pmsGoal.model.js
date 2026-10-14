const mongoose = require('mongoose');

const pmsGoalSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  cycleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsCycle',
    required: true,
    index: true,
  },
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  scope: {
    type: String,
    enum: ['individual', 'team', 'department', 'strategic', 'company'],
    default: 'individual',
  },
  parentGoalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsGoal',
    default: null,
  },
  linkedKraId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsKra',
    default: null,
  },
  linkedKpiId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsKpi',
    default: null,
  },
  weightage: { type: Number, default: 20, min: 0, max: 100 },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
  },
  startDate: { type: Date },
  dueDate: { type: Date },
  progress: { type: Number, default: 0, min: 0, max: 100 },
  status: {
    type: String,
    enum: [
      'draft',
      'pending_approval',
      'approved',
      'in_progress',
      'achieved',
      'partially_achieved',
      'missed',
      'cancelled',
    ],
    default: 'draft',
    index: true,
  },
  keyResults: [
    {
      title: { type: String, required: true },
      baseline: { type: Number, default: 0 },
      target: { type: Number, required: true },
      current: { type: Number, default: 0 },
      unit: { type: String, default: '%' },
      completed: { type: Boolean, default: false },
    },
  ],
  approvalStatus: {
    status: {
      type: String,
      enum: ['draft', 'pending', 'approved', 'rejected'],
      default: 'draft',
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewComment: { type: String, default: '' },
  },
  checkIns: [
    {
      progress: { type: Number, required: true },
      notes: { type: String, default: '' },
      blockers: { type: String, default: '' },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  collaborators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

pmsGoalSchema.index({ companyId: 1, employeeId: 1, cycleId: 1 });
pmsGoalSchema.index({ companyId: 1, parentGoalId: 1 });

module.exports = mongoose.model('PmsGoal', pmsGoalSchema);
