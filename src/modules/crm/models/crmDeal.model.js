const mongoose = require('mongoose');

const dealSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  title: { type: String, required: true, trim: true, index: true },
  value: { type: Number, required: true, default: 0 },
  currency: { type: String, default: 'INR' },
  pipelineId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmPipeline', required: true, index: true },
  stage: { type: String, required: true, default: 'New Lead' },
  probability: { type: Number, default: 20, min: 0, max: 100 },
  status: { type: String, enum: ['Open', 'Won', 'Lost'], default: 'Open', index: true },
  expectedCloseDate: { type: Date, required: true },
  actualCloseDate: { type: Date },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmAccount', index: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmContact', index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  leadSource: { type: String, default: 'Website' },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmCampaign' },
  priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },

  // Sales Forecast Category
  forecastCategory: {
    type: String,
    enum: ['Pipeline', 'Best Case', 'Commit', 'Closed', 'Omitted'],
    default: 'Pipeline',
  },

  // Deal Risk Intelligence
  riskLevel: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Low' },
  riskReasons: [{ type: String }],
  daysInCurrentStage: { type: Number, default: 0 },
  stageChangedAt: { type: Date, default: Date.now },

  winLossReason: { type: String },
  competitor: { type: String },
  description: { type: String },
  tags: [{ type: String }],
  customFields: { type: Map, of: mongoose.Schema.Types.Mixed },
  lastActivityAt: { type: Date, default: Date.now },
  nextFollowUpAt: { type: Date },

  // Cross-System Delivery Project ID (when deal is Won and converted to a TalentCIO Project)
  talentcioProjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
}, { timestamps: true });

dealSchema.virtual('weightedValue').get(function () {
  return (this.value * (this.probability || 0)) / 100;
});

// Alias for backwards compatibility with frontends expecting companyId as the account
dealSchema.virtual('company').get(function () {
  return this.accountId;
});

dealSchema.index({ companyId: 1, status: 1 });
dealSchema.index({ companyId: 1, pipelineId: 1, stage: 1 });
dealSchema.index({ companyId: 1, ownerId: 1, status: 1 });

dealSchema.set('toJSON', { virtuals: true });
dealSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('CrmDeal', dealSchema);
