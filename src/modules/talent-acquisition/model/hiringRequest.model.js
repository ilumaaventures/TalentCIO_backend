const mongoose = require('mongoose');
const softDeletePlugin = require('../../../common/utils/softDeletePlugin');

const phaseStatusOptionSchema = new mongoose.Schema({
    value: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    color: { type: String, default: '#3B82F6' },
    isDefault: { type: Boolean, default: false }
}, { _id: false });

const phaseDecisionOptionSchema = new mongoose.Schema({
    value: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    color: { type: String, default: '#10B981' },
    type: {
        type: String,
        enum: ['advance', 'hold', 'reject'],
        required: true
    },
    nextPhaseOrder: { type: Number }
}, { _id: false });

const hiringRequestPhaseSchema = new mongoose.Schema({
    phaseId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    order: { type: Number, required: true },
    color: { type: String, default: '#3B82F6' },
    statusOptions: {
        type: [phaseStatusOptionSchema],
        default: []
    },
    decisionOptions: {
        type: [phaseDecisionOptionSchema],
        default: []
    },
    allowedActions: {
        type: [String],
        default: []
    }
});

const candidateCardVisibilitySchema = new mongoose.Schema({
    phaseOrder: { type: Number, required: true },
    visibleCardKeys: {
        type: [String],
        default: []
    }
}, { _id: false });

const candidateDropdownVisibilitySchema = new mongoose.Schema({
    filterStatus: { type: Boolean, default: true },
    filterDecision: { type: Boolean, default: true },
    rowStatus: { type: Boolean, default: true },
    rowDecision: { type: Boolean, default: true }
}, { _id: false });

const HiringRequestSchema = new mongoose.Schema({
    requestId: { type: String, required: true },

    // 0. Client Details
    client: { type: String, required: true },
    clientConfidential: { type: Boolean, default: false },

    // 1. Role Information
    roleDetails: {
        title: { type: String, required: true },
        department: { type: String, required: true },
        reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        employmentType: {
            type: String,
            enum: ['Full-time', 'Intern', 'Contract', 'Freelance'],
            required: true
        }
    },

    // 2. Purpose of Hiring
    purpose: {
        type: String,
        enum: ['Replacement', 'New Position', 'Project-based', 'Business Expansion'],
        required: true
    },

    replacementDetails: {
        employeeName: String,
        employeeId: String
    },

    // 3. Job Requirement Summary
    requirements: {
        mustHaveSkills: {
            technical: [String],
            softSkills: [String]
        },
        niceToHaveSkills: [String],
        experienceMin: Number,
        experienceMax: Number,
        location: { type: String },
        shift: String,
        workPlace: {
            type: String,
            enum: ['Company Office', 'Client Site']
        },
        clientWorkLocation: [String],
        workMode: {
            type: String,
            enum: ['Work from Office', 'Hybrid', 'Remote']
        },
        workingDaysPerWeek: {
            type: Number
        }
    },

    // 4. Hiring Details
    hiringDetails: {
        openPositions: { type: Number, default: 1 },
        originalOpenPositions: { type: Number, default: 1 },
        closedPositions: { type: Number, default: 0 },
        expectedJoiningDate: Date,
        budgetRange: {
            min: Number,
            max: Number,
            currency: { type: String, default: 'INR' },
            isOpen: { type: Boolean, default: false }
        },
        priority: { type: String, enum: ['High', 'Medium', 'Low'], default: 'Medium' }
    },

    // 5. Ownership & Recruitment Team
    requestor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ownership: {
        hiringManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        interviewPanel: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] // Optional at this stage
    },
    recruitmentTeam: {
        hiringManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        assignedRecruiters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
    },
    assignedUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    analyticsViewers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],

    // 6. Approval Workflow & Status
    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow' }, // Track selected workflow
    interviewWorkflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewWorkflow' }, // Default interview template
    status: {
        type: String,
        enum: ['Draft', 'Submitted', 'Pending_L1', 'Pending_Final', 'Approved', 'Rejected', 'On_Hold', 'Closed', 'Pending_Approval', 'Pending Approval', 'Pending'],
        default: 'Draft'
    },
    isPublic: { type: Boolean, default: false },
    isResourceGatewayPublic: { type: Boolean, default: false },
    wasEverPublished: { type: Boolean, default: false },
    publicJobTitle: { type: String, trim: true },
    publicJobDescription: { type: String },

    approvals: {
        l1: {
            status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
            approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            date: Date,
            comments: String
        },
        final: {
            status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
            approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            date: Date,
            comments: String
        }
    },

    // Dynamic Approval Workflow
    approvalChain: [{
        level: Number,
        role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
        roleName: String, // Snapshot of role name
        status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
        approvers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // List of authorized approvers
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // The actual user who approved
        specificApprover: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        actionBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        date: Date,
        comments: String
    }],
    currentApprovalLevel: { type: Number, default: 1 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    jobDescription: { type: String },
    jobDescriptionFile: { type: String }, // Cloudinary URL

    // Tracking Reopened Requisitions
    previousRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'HiringRequest' },
    reopenedToId: { type: mongoose.Schema.Types.ObjectId, ref: 'HiringRequest' },
    closedAt: { type: Date },
    phaseTemplateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PhaseTemplate'
    },
    phases: {
        type: [hiringRequestPhaseSchema],
        default: []
    },
    useDynamicPhases: {
        type: Boolean,
        default: false
    },
    candidateCardVisibility: {
        type: [candidateCardVisibilitySchema],
        default: []
    },
    candidateDropdownVisibility: {
        type: candidateDropdownVisibilitySchema,
        default: () => ({})
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    }
}, { timestamps: true });

// Performance Indexes
HiringRequestSchema.index({ companyId: 1, requestId: 1 }, { unique: true });
HiringRequestSchema.index({ companyId: 1, status: 1, createdAt: -1 });
HiringRequestSchema.index({ createdBy: 1, companyId: 1, createdAt: -1 });
HiringRequestSchema.index({ companyId: 1, assignedUsers: 1, createdAt: -1 });
HiringRequestSchema.index({ companyId: 1, analyticsViewers: 1, createdAt: -1 });
HiringRequestSchema.index({ isPublic: 1, status: 1, createdAt: -1 });
HiringRequestSchema.index({ isResourceGatewayPublic: 1, status: 1, createdAt: -1 });
HiringRequestSchema.index({ companyId: 1, isDeleted: 1 });

HiringRequestSchema.plugin(softDeletePlugin);

HiringRequestSchema.pre('save', function (next) {
    if (!this.requestor && this.createdBy) {
        this.requestor = this.createdBy;
    }
    if (!this.createdBy && this.requestor) {
        this.createdBy = this.requestor;
    }
    if (!this.ownership) {
        this.ownership = {};
    }
    if (!this.recruitmentTeam) {
        this.recruitmentTeam = {};
    }
    if (this.ownership.hiringManager && !this.recruitmentTeam.hiringManager) {
        this.recruitmentTeam.hiringManager = this.ownership.hiringManager;
    }
    if (this.recruitmentTeam.hiringManager && !this.ownership.hiringManager) {
        this.ownership.hiringManager = this.recruitmentTeam.hiringManager;
    }
    if (typeof next === 'function') {
        next();
    }
});

// Audit Logs for this specific request
const HRRAuditLogSchema = new mongoose.Schema({
    hiringRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'HiringRequest' },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
    action: String,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resourceType: { type: String, default: 'HiringRequest' },
    resourceId: { type: mongoose.Schema.Types.ObjectId },
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Candidate' },
    permissionKey: { type: String, default: '' },
    scope: { type: String, default: 'tenant' },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    ipAddress: { type: String, default: '' },
    correlationId: { type: String, default: '' },
    delegation: { type: mongoose.Schema.Types.Mixed, default: null },
    details: Object,
    timestamp: { type: Date, default: Date.now }
});

module.exports = {
    HiringRequest: mongoose.model('HiringRequest', HiringRequestSchema),
    HRRAuditLog: mongoose.model('HRRAuditLog', HRRAuditLogSchema)
};
