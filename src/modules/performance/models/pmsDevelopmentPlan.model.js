const mongoose = require('mongoose');

const pmsDevelopmentPlanSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  cycleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsCycle',
  },
  appraisalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsAppraisal',
  },
  status: {
    type: String,
    enum: ['active', 'in_progress', 'completed', 'archived'],
    default: 'active',
  },
  objectives: [
    {
      skillOrCompetency: { type: String, required: true },
      activityType: {
        type: String,
        enum: ['Training / Course', 'Mentorship / Shadowing', 'Stretch Assignment', 'Self Study', 'Certification'],
        default: 'Training / Course',
      },
      description: { type: String, default: '' },
      resourceOrLink: { type: String, default: '' },
      targetDate: { type: Date },
      completedDate: { type: Date },
      status: {
        type: String,
        enum: ['not_started', 'in_progress', 'completed'],
        default: 'not_started',
      },
      evidenceUrl: { type: String, default: '' },
      managerFeedback: { type: String, default: '' },
    },
  ],
  notes: { type: String, default: '' },
}, { timestamps: true });

pmsDevelopmentPlanSchema.index({ companyId: 1, employeeId: 1 });

module.exports = mongoose.model('PmsDevelopmentPlan', pmsDevelopmentPlanSchema);
