const mongoose = require('mongoose');

const pmsAppraisalSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  cycleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PmsCycle',
    required: true,
    index: true,
  },
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  currentStageIndex: {
    type: Number,
    default: 0,
  },
  currentStageKey: {
    type: String,
    default: 'self_review',
    index: true,
  },
  status: {
    type: String,
    enum: [
      'not_started',
      'self_review_pending',
      'self_review_submitted',
      'manager_review_pending',
      'manager_review_submitted',
      'dept_head_review_pending',
      'department_head_review_pending',
      'hr_evaluation_pending',
      'calibration_pending',
      'final_approval_pending',
      'approved',
      'under_approval',
      'revision_requested',
      'rejected',
      'published',
      'acknowledged',
      'disputed',
    ],
    default: 'self_review_pending',
    index: true,
  },

  // --- Self-Appraisal Section ---
  selfAppraisal: {
    kraRatings: [
      {
        kraId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsKra' },
        name: String,
        weightage: Number,
        selfRating: Number,
        selfComments: String,
        achievementDetails: String,
      },
    ],
    kpiRatings: [
      {
        kpiId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsKpi' },
        kraId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsKra', default: null },
        name: String,
        code: String,
        targetValue: Number,
        actualValue: Number,
        weightage: { type: Number, default: 0 },
        unit: { type: String, default: '%' },
        measurementType: { type: String, default: 'number' },
        measurementDirection: { type: String, default: 'higher_is_better' },
        achievementPercent: Number,
        selfRating: Number,
        selfComments: String,
        evidenceUrl: { type: String, default: '' },
        evidenceNote: { type: String, default: '' },
      },
    ],
    goalRatings: [
      {
        goalId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsGoal' },
        title: String,
        progress: Number,
        selfRating: Number,
        selfComments: String,
      },
    ],
    competencyRatings: [
      {
        competencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsCompetency' },
        name: String,
        expectedProficiency: Number,
        selfRating: Number,
        selfComments: String,
      },
    ],
    accomplishments: { type: String, default: '' },
    challenges: { type: String, default: '' },
    careerAspirations: { type: String, default: '' },
    submittedAt: { type: Date },
    isDraft: { type: Boolean, default: true },
    isSubmitted: { type: Boolean, default: false },
  },

  // --- Manager Appraisal Section ---
  managerAppraisal: {
    kraRatings: [
      {
        kraId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsKra' },
        name: String,
        weightage: Number,
        managerRating: Number,
        managerComments: String,
      },
    ],
    kpiRatings: [
      {
        kpiId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsKpi' },
        kraId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsKra', default: null },
        name: String,
        code: String,
        targetValue: Number,
        actualValue: Number,
        verifiedActualValue: { type: Number, default: null },
        weightage: { type: Number, default: 0 },
        unit: { type: String, default: '%' },
        measurementType: { type: String, default: 'number' },
        measurementDirection: { type: String, default: 'higher_is_better' },
        managerRating: Number,
        managerComments: String,
        evidenceVerified: { type: Boolean, default: null },
        evidenceComments: { type: String, default: '' },
      },
    ],
    goalRatings: [
      {
        goalId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsGoal' },
        title: String,
        managerRating: Number,
        managerComments: String,
      },
    ],
    competencyRatings: [
      {
        competencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsCompetency' },
        name: String,
        managerRating: Number,
        managerComments: String,
      },
    ],
    strengths: { type: String, default: '' },
    areasOfImprovement: { type: String, default: '' },
    promotionRecommendation: {
      recommended: { type: Boolean, default: false },
      proposedDesignation: { type: String, default: '' },
      notes: { type: String, default: '' },
    },
    trainingNeeds: [{ type: String }],
    overallComments: { type: String, default: '' },
    submittedAt: { type: Date },
    isDraft: { type: Boolean, default: true },
    isSubmitted: { type: Boolean, default: false },
  },

  // --- 360 Feedback Reviewers ---
  peerReviews: [
    {
      reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      relationship: {
        type: String,
        enum: ['peer', 'direct_report', 'cross_functional', 'other'],
        default: 'peer',
      },
      status: {
        type: String,
        enum: ['nominated', 'approved', 'declined', 'submitted'],
        default: 'nominated',
      },
      isAnonymous: { type: Boolean, default: true },
      ratings: [
        {
          competencyId: { type: mongoose.Schema.Types.ObjectId, ref: 'PmsCompetency' },
          name: String,
          rating: Number,
          comments: String,
        },
      ],
      strengthsFeedback: { type: String, default: '' },
      developmentFeedback: { type: String, default: '' },
      submittedAt: { type: Date },
    },
  ],

  // --- Scoring & Normalized Calculation ---
  scores: {
    rawKraScore: { type: Number, default: 0 },
    rawKpiScore: { type: Number, default: 0 },
    rawGoalScore: { type: Number, default: 0 },
    rawCompetencyScore: { type: Number, default: 0 },
    rawPeerScore: { type: Number, default: 0 },
    selfOverallScore: { type: Number, default: 0 },
    managerOverallScore: { type: Number, default: 0 },
    calculatedFinalScore: { type: Number, default: 0 }, // Out of 5 or 100
    normalizedScore: { type: Number, default: 0 }, // 0 to 100
    calibratedScore: { type: Number },
    ratingBand: { type: String, default: '' }, // e.g. "Meets Expectations"
    scoreBreakdown: mongoose.Schema.Types.Mixed,
  },

  // --- Calibration / Moderation ---
  calibration: {
    originalScore: { type: Number },
    calibratedScore: { type: Number },
    calibratedRatingBand: { type: String },
    calibratedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    calibratedAt: { type: Date },
    reason: { type: String, default: '' },
    isAdjusted: { type: Boolean, default: false },
  },

  // --- Approval Chain ---
  approvalChain: [
    {
      step: { type: Number, default: 1 },
      approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      roleTitle: { type: String, default: 'Manager' },
      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'changes_requested'],
        default: 'pending',
      },
      comment: { type: String, default: '' },
      actionDate: { type: Date },
    },
  ],

  // --- Department Head Review Section ---
  departmentHeadEvaluation: {
    deptHeadRating: { type: Number },
    deptHeadComments: { type: String, default: '' },
    evaluatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    evaluatedAt: { type: Date },
  },

  // --- HR Evaluation Section ---
  hrEvaluation: {
    hrRating: { type: Number },
    hrComments: { type: String, default: '' },
    evaluatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    evaluatedAt: { type: Date },
  },

  // --- Final Leadership Approval ---
  finalApproval: {
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    comments: { type: String, default: '' },
  },

  // --- Revision Request ---
  revisionRequest: {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    requestedAt: { type: Date },
    targetStage: { type: String, default: 'self_review' },
    reason: { type: String, default: '' },
  },

  // --- Review Delegation ---
  delegation: {
    isDelegated: { type: Boolean, default: false },
    delegatedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    delegatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    delegatedAt: { type: Date },
    validUntil: { type: Date },
    reason: { type: String, default: '' },
  },

  // --- Complete Audited Workflow History ---
  workflowHistory: [
    {
      stageKey: { type: String, required: true },
      stageLabel: { type: String, default: '' },
      action: {
        type: String,
        enum: ['submitted', 'approved', 'revision_requested', 'rejected', 'calibrated', 'published', 'reopened', 'delegated', 'reassigned', 'acknowledged', 'disputed'],
        required: true,
      },
      actedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      actedByRole: { type: String, default: '' },
      comments: { type: String, default: '' },
      ratingsSnapshot: mongoose.Schema.Types.Mixed,
      actionDate: { type: Date, default: Date.now },
    },
  ],

  // --- Publishing & Acknowledgement ---
  isPublished: { type: Boolean, default: false },
  publishedAt: { type: Date },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acknowledgement: {
    isAcknowledged: { type: Boolean, default: false },
    acknowledgedAt: { type: Date },
    isDisputed: { type: Boolean, default: false },
    disputeReason: { type: String, default: '' },
    employeeComments: { type: String, default: '' },
  },

  // --- Automated Reminders & Escalations ---
  remindersSent: [
    {
      reminderType: { type: String, required: true },
      sentTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      sentAt: { type: Date, default: Date.now },
      stageKey: { type: String },
    },
  ],
}, { timestamps: true });

pmsAppraisalSchema.index({ companyId: 1, cycleId: 1, employeeId: 1 }, { unique: true });
pmsAppraisalSchema.index({ companyId: 1, managerId: 1, status: 1 });
pmsAppraisalSchema.index({ companyId: 1, currentStageKey: 1, status: 1 });
pmsAppraisalSchema.index({ companyId: 1, 'delegation.delegatedTo': 1 });
pmsAppraisalSchema.index({ companyId: 1, status: 1 });
pmsAppraisalSchema.index({ companyId: 1, cycleId: 1, status: 1 });
pmsAppraisalSchema.index({ companyId: 1, isPublished: 1, 'scores.calculatedFinalScore': -1 });
pmsAppraisalSchema.index({ companyId: 1, updatedAt: -1 });

module.exports = mongoose.model('PmsAppraisal', pmsAppraisalSchema);
