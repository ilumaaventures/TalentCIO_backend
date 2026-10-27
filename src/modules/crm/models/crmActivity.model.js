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
    trim: true,
    default: 'Completed',
  },
  durationMinutes: { type: Number, default: 0 },
  callType: { type: String, trim: true, default: 'Cold Call' },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  performedByName: { type: String },
  contactPerson: { type: String, trim: true },
  contactPhone: { type: String, trim: true },
  contactDesignation: { type: String, trim: true },
  contactEmail: { type: String, trim: true },
  contactPersons: [
    {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      designation: { type: String, trim: true },
      email: { type: String, trim: true },
      callType: { type: String, trim: true, default: 'Cold Call' },
      durationMinutes: { type: Number, default: 0 },
      outcome: { type: String, default: 'Connected' },
      notes: { type: String, default: '' },
    },
  ],

  // Polymorphic References
  importDataId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmImportData', index: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmLead', index: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmContact', index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmAccount', index: true },
  dealId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmDeal', index: true },

  attachments: [
    {
      filename: { type: String },
      name: { type: String },
      size: { type: Number },
      contentType: { type: String },
      url: { type: String, default: '' },
    },
  ],

  metadata: { type: Map, of: mongoose.Schema.Types.Mixed },
  performedAt: { type: Date, default: Date.now },
}, { timestamps: true });

activitySchema.index({ companyId: 1, performedBy: 1, performedAt: -1 });
activitySchema.index({ companyId: 1, importDataId: 1, performedAt: -1 });

module.exports = mongoose.model('CrmActivity', activitySchema);
