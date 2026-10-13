const mongoose = require('mongoose');

const pmsCycleSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true },
  description: { type: String, default: '' },
  cycleType: {
    type: String,
    enum: [
      'annual',
      'half_yearly',
      'quarterly',
      'probationary',
      'custom',
      'Annual',
      'Half-Yearly',
      'Quarterly',
      'Probationary',
      'Custom',
    ],
    default: 'annual',
  },
  status: {
    type: String,
    enum: [
      'draft',
      'scheduled',
      'goal_setting',
      'in_progress',
      'self_review',
      'manager_review',
      'peer_feedback',
      'calibration',
      'approval',
      'published',
      'closed',
    ],
    default: 'draft',
    index: true,
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  timeline: {
    goalSettingStart: { type: Date },
    goalSettingEnd: { type: Date },
    selfAppraisalDeadline: { type: Date },
    managerReviewDeadline: { type: Date },
    peerFeedbackDeadline: { type: Date },
    calibrationStart: { type: Date },
    calibrationEnd: { type: Date },
    publishingDate: { type: Date },
  },
  applicableDepartments: [{ type: String, trim: true }],
  applicableDesignations: [{ type: String, trim: true }],
  applicableEmployees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  excludedEmployees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  settings: {
    ratingScale: {
      type: String,
      enum: ['1-5', '1-4', '1-10', 'custom'],
      default: '1-5',
    },
    weightageModel: {
      kraWeight: { type: Number, default: 40 },
      kpiWeight: { type: Number, default: 20 },
      goalWeight: { type: Number, default: 20 },
      competencyWeight: { type: Number, default: 20 },
    },
    allowSelfAppraisal: { type: Boolean, default: true },
    allow360Feedback: { type: Boolean, default: true },
    min360Reviewers: { type: Number, default: 2 },
    max360Reviewers: { type: Number, default: 5 },
    anonymous360: { type: Boolean, default: true },
    requireGoalApproval: { type: Boolean, default: true },
  },
  snapshots: {
    ratingScaleSnapshot: mongoose.Schema.Types.Mixed,
    weightsSnapshot: mongoose.Schema.Types.Mixed,
  },
  reopenHistory: [
    {
      reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reopenedAt: { type: Date, default: Date.now },
      reason: { type: String, required: true },
    },
  ],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

pmsCycleSchema.index({ companyId: 1, status: 1, startDate: -1 });

module.exports = mongoose.model('PmsCycle', pmsCycleSchema);
