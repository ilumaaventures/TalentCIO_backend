const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  source: { type: String, default: 'Google Ads' },
  medium: { type: String, default: 'CPC' },
  budget: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' },
  startDate: { type: Date },
  endDate: { type: Date },
  status: { type: String, enum: ['Active', 'Planned', 'Completed', 'Paused'], default: 'Active' },
  targetAudience: { type: String },
  leadsGenerated: { type: Number, default: 0 },
  dealsWon: { type: Number, default: 0 },
  revenueGenerated: { type: Number, default: 0 },
}, { timestamps: true });

campaignSchema.virtual('roi').get(function () {
  if (!this.budget || this.budget === 0) return 0;
  return (((this.revenueGenerated - this.budget) / this.budget) * 100).toFixed(1);
});

campaignSchema.index({ companyId: 1, status: 1 });

campaignSchema.set('toJSON', { virtuals: true });
campaignSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('CrmCampaign', campaignSchema);
