const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
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
  alternatePhone: { type: String, trim: true },
  companyName: { type: String, trim: true, default: '' },
  jobTitle: { type: String, trim: true },
  website: { type: String, trim: true },
  address: {
    street: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    country: { type: String, trim: true, default: 'India' },
    postalCode: { type: String, trim: true, default: '' },
  },
  source: {
    type: String,
    trim: true,
    default: 'Website',
  },
  status: {
    type: String,
    enum: ['New', 'Contacted', 'Qualified', 'Unqualified', 'Nurturing', 'Converted', 'Lost'],
    default: 'New',
    index: true,
  },
  priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  temperature: { type: String, enum: ['Cold', 'Warm', 'Hot'], default: 'Warm' },
  score: { type: Number, default: 50, min: 0, max: 100 },
  estimatedValue: { type: Number, default: 0 },
  expectedPurchaseDate: { type: Date },
  budget: { type: String, trim: true },
  requirements: { type: String, trim: true },
  preferredContactMethod: { type: String, trim: true, default: 'Phone' },
  currency: { type: String, default: 'INR' },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  team: { type: String, default: 'Direct Sales' },
  territory: { type: String, default: 'National' },

  // BANT Qualification Framework
  qualification: {
    need: { type: String, default: '' },
    budget: { type: String, default: '' },
    authority: { type: String, default: '' },
    timeline: { type: String, default: '' },
    interestLevel: { type: String, enum: ['Low', 'Medium', 'High', 'Very High'], default: 'Medium' },
    buyingIntent: { type: String, enum: ['Informational', 'Evaluating', 'Decision Stage', 'Ready to Buy'], default: 'Evaluating' },
  },

  // Conversion Tracking
  isConverted: { type: Boolean, default: false },
  convertedDate: { type: Date },
  convertedContactId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmContact' },
  convertedAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmAccount' },
  convertedDealId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmDeal' },

  customFields: { type: Map, of: mongoose.Schema.Types.Mixed },
  tags: [{ type: String }],
  notes: { type: String },
  lastActivityAt: { type: Date, default: Date.now },
  nextFollowUpAt: { type: Date },
}, { timestamps: true });

leadSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});

leadSchema.index({ companyId: 1, email: 1 });
leadSchema.index({ companyId: 1, status: 1 });
leadSchema.index({ companyId: 1, ownerId: 1 });

leadSchema.set('toJSON', { virtuals: true });
leadSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('CrmLead', leadSchema);
