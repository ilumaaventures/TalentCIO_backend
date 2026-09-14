const mongoose = require('mongoose');

const targetSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  title: { type: String, required: true },
  targetType: {
    type: String,
    enum: ['revenue', 'deals_won', 'leads_qualified', 'calls_completed', 'meetings_completed'],
    default: 'revenue',
  },
  period: {
    type: String,
    enum: ['monthly', 'quarterly', 'yearly'],
    default: 'monthly',
  },
  year: { type: Number, required: true },
  month: { type: Number },
  quarter: { type: Number },
  targetValue: { type: Number, required: true },
  currentValue: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' },
  assignedType: { type: String, enum: ['user', 'team', 'territory'], default: 'user' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  teamName: { type: String },
  territoryName: { type: String },
}, { timestamps: true });

targetSchema.virtual('achievementPercent').get(function () {
  if (!this.targetValue || this.targetValue === 0) return 0;
  return Math.min(100, Math.round((this.currentValue / this.targetValue) * 100));
});

targetSchema.index({ companyId: 1, userId: 1, year: 1, month: 1 });

targetSchema.set('toJSON', { virtuals: true });
targetSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('CrmTarget', targetSchema);
