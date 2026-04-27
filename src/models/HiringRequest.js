const mongoose = require('mongoose');

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
        location: { type: String, enum: ['Onsite', 'Remote', 'Hybrid'] },
        shift: String
    },

    // 4. Hiring Details
    hiringDetails: {
        openPositions: { type: Number, default: 1 },
        expectedJoiningDate: Date,
        budgetRange: {
            min: Number,
            max: Number,
            currency: { type: String, default: 'INR' },
            isOpen: { type: Boolean, default: false }
        },
        priority: { type: String, enum: ['High', 'Medium', 'Low'], default: 'Medium' }
    },

    // 5. Ownership
    ownership: {
        hiringManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        recruiter: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        interviewPanel: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] // Optional at this stage
    },

    // 6. Approval Workflow & Status
    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalWorkflow' }, // Track selected workflow
    interviewWorkflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewWorkflow' }, // Default interview template
    status: {
        type: String,
        enum: ['Draft', 'Submitted', 'Pending_L1', 'Pending_Final', 'Approved', 'Rejected', 'On_Hold', 'Closed', 'Pending_Approval'],
        default: 'Draft'
    },
    isPublic: { type: Boolean, default: false },
    isResourceGatewayPublic: { type: Boolean, default: false },
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
HiringRequestSchema.index({ isPublic: 1, status: 1, createdAt: -1 });
HiringRequestSchema.index({ isResourceGatewayPublic: 1, status: 1, createdAt: -1 });

// Audit Logs for this specific request
const HRRAuditLogSchema = new mongoose.Schema({
    hiringRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'HiringRequest' },
    action: String,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    details: Object,
    timestamp: { type: Date, default: Date.now }
});

module.exports = {
    HiringRequest: mongoose.model('HiringRequest', HiringRequestSchema),
    HRRAuditLog: mongoose.model('HRRAuditLog', HRRAuditLogSchema)
};
