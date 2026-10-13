const mongoose = require('mongoose');

const pmsSettingSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true,
    index: true,
  },
  ratingScales: [
    {
      name: { type: String, default: 'Standard 5-Point Scale' },
      scaleType: { type: String, enum: ['1-5', '1-4', '1-10', 'custom'], default: '1-5' },
      isDefault: { type: Boolean, default: true },
      bands: [
        {
          score: { type: Number, required: true },
          label: { type: String, required: true },
          description: { type: String, default: '' },
          minPercent: { type: Number, default: 0 },
          maxPercent: { type: Number, default: 100 },
          color: { type: String, default: '#3b82f6' },
        },
      ],
    },
  ],
  defaultWeightageModel: {
    kraWeight: { type: Number, default: 40 },
    kpiWeight: { type: Number, default: 20 },
    goalWeight: { type: Number, default: 20 },
    competencyWeight: { type: Number, default: 20 },
  },
  bellCurveTargetDistribution: [
    {
      label: { type: String, required: true },
      targetPercentage: { type: Number, required: true },
    },
  ],
  continuousFeedbackSettings: {
    allowPeerRecognition: { type: Boolean, default: true },
    publicWallEnabled: { type: Boolean, default: true },
    anonymousFeedbackDefault: { type: Boolean, default: true },
    minResponsesForDisclosure: { type: Number, default: 3 },
    allowEmployeeNominate360: { type: Boolean, default: true },
    requireManagerApprovalFor360: { type: Boolean, default: true },
  },
  approvalWorkflow: {
    requireManagerReview: { type: Boolean, default: true },
    requireHrEvaluation: { type: Boolean, default: true },
    requireAdminApproval: { type: Boolean, default: true },
    stages: [
      {
        key: { type: String, required: true },
        label: { type: String, required: true },
        assigneeType: {
          type: String,
          enum: ['employee', 'reporting_manager', 'department_head', 'hr_group', 'company_admin', 'specific_user', 'system'],
          default: 'reporting_manager',
        },
        specificUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        isRequired: { type: Boolean, default: true },
        canEditRatings: { type: Boolean, default: false },
        order: { type: Number, required: true },
      },
    ],
    allowRevisions: { type: Boolean, default: true },
    rejectionBehavior: {
      type: String,
      enum: ['return_to_employee', 'return_to_manager', 'reject_cycle'],
      default: 'return_to_employee',
    },
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('PmsSetting', pmsSettingSchema);
