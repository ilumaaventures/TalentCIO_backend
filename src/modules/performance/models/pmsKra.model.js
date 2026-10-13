const mongoose = require('mongoose');

const pmsKraSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true },
  description: { type: String, default: '' },
  category: {
    type: String,
    enum: [
      'Productivity & Delivery',
      'Quality of Work',
      'Customer Satisfaction',
      'Revenue & Sales',
      'Operational Efficiency',
      'Team Collaboration',
      'Leadership & Mentorship',
      'Learning & Development',
      'General',
    ],
    default: 'Productivity & Delivery',
  },
  applicableDepartments: [{ type: String, trim: true }],
  applicableDesignations: [{ type: String, trim: true }],
  applicableEmployees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  weightage: {
    type: Number,
    min: 0,
    max: 100,
    default: 20,
  },
  measurementMethod: { type: String, default: '' },
  targetDefinition: { type: String, default: '' },
  isTemplate: { type: Boolean, default: false },
  isMandatory: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ['active', 'inactive', 'draft'],
    default: 'active',
  },
  cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsCycle' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

pmsKraSchema.index({ companyId: 1, isTemplate: 1, status: 1 });
pmsKraSchema.index({ companyId: 1, cycleId: 1 });

module.exports = mongoose.model('PmsKra', pmsKraSchema);
