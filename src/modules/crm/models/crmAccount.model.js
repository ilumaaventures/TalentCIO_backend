const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true, trim: true, index: true },
  industry: { type: String, default: 'Technology' },
  website: { type: String, trim: true },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  address: {
    street: String,
    city: String,
    state: String,
    country: { type: String, default: 'India' },
    postalCode: String,
  },
  companySize: { type: String, default: '51-200' },
  annualRevenue: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  accountType: { type: String, enum: ['Prospect', 'Customer', 'Partner', 'Vendor'], default: 'Prospect' },
  customerStatus: { type: String, enum: ['Active', 'Onboarding', 'Churned', 'At Risk'], default: 'Active' },
  healthScore: { type: String, enum: ['healthy', 'attention_needed', 'at_risk'], default: 'healthy' },
  tags: [{ type: String }],
  notes: { type: String },
  customFields: { type: Map, of: mongoose.Schema.Types.Mixed },
  lastActivityAt: { type: Date, default: Date.now },

  // Synergy link to TalentCIO Client (when deal is won and client is provisioned)
  talentcioClientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
}, { timestamps: true });

accountSchema.index({ companyId: 1, name: 1 });
accountSchema.index({ companyId: 1, customerStatus: 1 });
accountSchema.index({ companyId: 1, ownerId: 1 });

module.exports = mongoose.model('CrmAccount', accountSchema);
