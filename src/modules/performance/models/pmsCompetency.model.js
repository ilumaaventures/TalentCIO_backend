const mongoose = require('mongoose');

const pmsCompetencySchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true },
  category: {
    type: String,
    enum: [
      'Core Organizational',
      'Functional & Technical',
      'Leadership & People Management',
      'Behavioral & Interpersonal',
      'Communication & Collaboration',
      'Problem Solving & Innovation',
    ],
    default: 'Core Organizational',
  },
  description: { type: String, default: '' },
  applicableDepartments: [{ type: String, trim: true }],
  applicableDesignations: [{ type: String, trim: true }],
  expectedProficiency: { type: Number, default: 3, min: 1, max: 5 },
  observableBehaviors: [{ type: String, trim: true }],
  ratingScaleMax: { type: Number, default: 5 },
  weightage: { type: Number, default: 10 },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

pmsCompetencySchema.index({ companyId: 1, category: 1, isActive: 1 });

module.exports = mongoose.model('PmsCompetency', pmsCompetencySchema);
