const mongoose = require('mongoose');

const pmsKpiTemplateSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
      index: true,
    },
    departmentName: {
      type: String,
      default: '',
      trim: true,
    },
    designation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Designation',
      default: null,
      index: true,
    },
    designationName: {
      type: String,
      default: '',
      trim: true,
    },
    kraId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PmsKra',
      required: true,
      index: true,
    },
    measurementType: {
      type: String,
      enum: ['percentage', 'number', 'currency', 'days', 'rating', 'yes_no'],
      default: 'percentage',
    },
    unit: {
      type: String,
      default: '%',
      trim: true,
    },
    targetValue: {
      type: Number,
      required: true,
      default: 100,
    },
    weightage: {
      type: Number,
      required: true,
      default: 20,
      min: 0,
      max: 100,
    },
    ratingMethod: {
      type: String,
      enum: ['automatic', 'manual'],
      default: 'automatic',
    },
    measurementDirection: {
      type: String,
      enum: ['higher_is_better', 'lower_is_better', 'target_range'],
      default: 'higher_is_better',
    },
    ratingScale: {
      type: String,
      default: '1-5',
      trim: true,
    },
    effectiveStartDate: {
      type: Date,
      default: null,
    },
    effectiveEndDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['draft', 'active', 'inactive'],
      default: 'active',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

pmsKpiTemplateSchema.index({ companyId: 1, department: 1, designation: 1, status: 1 });
pmsKpiTemplateSchema.index({ companyId: 1, kraId: 1, status: 1 });

module.exports = mongoose.model('PmsKpiTemplate', pmsKpiTemplateSchema);
