const mongoose = require('mongoose');

const pmsPipSchema = new mongoose.Schema({
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
    required: true,
  },
  initiatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  cycleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsCycle',
  },
  title: { type: String, required: true },
  reason: { type: String, required: true },
  status: {
    type: String,
    enum: ['draft', 'active', 'extended', 'successful', 'failed', 'cancelled'],
    default: 'draft',
    index: true,
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  extendedUntil: { type: Date },
  objectives: [
    {
      description: { type: String, required: true },
      successCriteria: { type: String, required: true },
      baseline: { type: String, default: '' },
      target: { type: String, default: '' },
      targetDate: { type: Date },
      status: {
        type: String,
        enum: ['pending', 'in_progress', 'met', 'unmet'],
        default: 'pending',
      },
    },
  ],
  checkpoints: [
    {
      checkpointDate: { type: Date, required: true },
      notes: { type: String, default: '' },
      conductedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      employeeFeedback: { type: String, default: '' },
      isSatisfactory: { type: Boolean, default: false },
    },
  ],
  supportActions: [{ type: String }],
  finalOutcomeSummary: { type: String, default: '' },
  decisionHistory: [
    {
      action: { type: String, required: true },
      date: { type: Date, default: Date.now },
      actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      notes: { type: String, default: '' },
    },
  ],
}, { timestamps: true });

pmsPipSchema.index({ companyId: 1, employeeId: 1, status: 1 });

module.exports = mongoose.model('PmsPip', pmsPipSchema);
