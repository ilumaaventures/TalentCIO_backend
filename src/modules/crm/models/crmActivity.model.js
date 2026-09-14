const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['call', 'meeting', 'task', 'email', 'whatsapp', 'note', 'stage_change', 'status_change', 'qualification'],
    required: true,
  },
  subject: { type: String, required: true },
  description: { type: String, default: '' },
  outcome: {
    type: String,
    enum: ['Connected', 'Left Voicemail', 'No Answer', 'Busy', 'Scheduled Meeting', 'Completed', 'Cancelled', 'Sent', 'Replied', 'Other'],
    default: 'Completed',
  },
  durationMinutes: { type: Number, default: 0 },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  performedByName: { type: String },

  // Polymorphic References
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmLead', index: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmContact', index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmAccount', index: true },
  dealId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmDeal', index: true },

  metadata: { type: Map, of: mongoose.Schema.Types.Mixed },
  performedAt: { type: Date, default: Date.now },
}, { timestamps: true });

activitySchema.index({ companyId: 1, performedBy: 1, performedAt: -1 });

module.exports = mongoose.model('CrmActivity', activitySchema);
