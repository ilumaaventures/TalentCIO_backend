const mongoose = require('mongoose');

const followUpSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  title: { type: String, required: true },
  scheduledDate: { type: Date, required: true, index: true },
  type: {
    type: String,
    enum: ['call', 'email', 'whatsapp', 'meeting', 'visit'],
    default: 'call',
  },
  status: {
    type: String,
    enum: ['scheduled', 'completed', 'rescheduled', 'missed'],
    default: 'scheduled',
    index: true,
  },
  priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  notes: { type: String, default: '' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

  // Related entity
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmLead' },
  dealId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmDeal' },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmContact' },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmAccount' },

  completedAt: { type: Date },
  outcomeNotes: { type: String },
}, { timestamps: true });

followUpSchema.index({ companyId: 1, assignedTo: 1, status: 1 });
followUpSchema.index({ companyId: 1, scheduledDate: 1 });

module.exports = mongoose.model('CrmFollowUp', followUpSchema);
