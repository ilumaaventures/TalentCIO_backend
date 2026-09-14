const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, index: true },
  phone: { type: String, trim: true, index: true },
  jobTitle: { type: String, trim: true },
  department: { type: String, trim: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmAccount', index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lifecycleStage: {
    type: String,
    enum: ['Subscriber', 'Lead', 'Marketing Qualified', 'Sales Qualified', 'Opportunity', 'Customer', 'Evangelist'],
    default: 'Lead',
  },
  isPrimaryContact: { type: Boolean, default: false },
  tags: [{ type: String }],
  notes: { type: String },
  customFields: { type: Map, of: mongoose.Schema.Types.Mixed },
  lastActivityAt: { type: Date, default: Date.now },
}, { timestamps: true });

contactSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});

contactSchema.index({ companyId: 1, email: 1 });
contactSchema.index({ companyId: 1, accountId: 1 });
contactSchema.index({ companyId: 1, ownerId: 1 });

contactSchema.set('toJSON', { virtuals: true });
contactSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('CrmContact', contactSchema);
