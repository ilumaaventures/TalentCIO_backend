const mongoose = require('mongoose');

const sequenceStepSchema = new mongoose.Schema({
  dayDelay: { type: Number, required: true, default: 0 },
  actionType: { type: String, enum: ['email', 'call_task', 'whatsapp', 'reminder'], required: true },
  title: { type: String, required: true },
  templateSubject: { type: String },
  templateBody: { type: String },
});

const sequenceSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  description: { type: String },
  status: { type: String, enum: ['Active', 'Draft', 'Paused'], default: 'Active' },
  steps: [sequenceStepSchema],
  enrolledCount: { type: Number, default: 0 },
  completedCount: { type: Number, default: 0 },
  responseRate: { type: Number, default: 0 },
}, { timestamps: true });

sequenceSchema.index({ companyId: 1, status: 1 });

module.exports = mongoose.model('CrmSequence', sequenceSchema);
