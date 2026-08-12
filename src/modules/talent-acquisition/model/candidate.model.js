const mongoose = require('mongoose');
const { buildInitialDynamicPhaseState } = require('../utils/phaseTemplateUtils');
const softDeletePlugin = require('../../../common/utils/softDeletePlugin');

const phaseHistorySchema = new mongoose.Schema({
    phaseId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    phaseName: {
        type: String,
        required: true,
        trim: true
    },
    phaseOrder: {
        type: Number,
        required: true
    },
    status: {
        type: String,
        default: ''
    },
    decision: {
        type: String,
        default: 'None'
    },
    enteredAt: {
        type: Date,
        default: Date.now
    },
    exitedAt: {
        type: Date,
        default: null
    },
    assignedTo: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    notes: {
        type: String,
        default: ''
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
});

const candidateSchema = new mongoose.Schema({
    hiringRequestId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'HiringRequest',
        required: true,
        index: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    applicantId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Applicant',
        index: true
    },
    publicApplicationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PublicApplication',
        index: true
    },
    profileSnapshot: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },

    // Resume Information
    resumeUrl: {
        type: String,
        required: true
    },
    resumePublicId: {
        type: String,
        required: true
    },
    uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    uploadedAt: {
        type: Date,
        default: Date.now
    },

    // Candidate Basic Information
    candidateName: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    mobile: {
        type: String,
        required: true,
        trim: true
    },

    // Source Information
    source: {
        type: String,
        required: true
    },
    profilePulledBy: {
        type: String,
        trim: true
    },
    calledBy: {
        type: String,
        trim: true
    },
    rate: {
        type: Number,
        min: 0
    },
    referralName: {
        type: String,
        trim: true
    },

    // Compensation Details
    currentCTC: {
        type: Number,
        min: 0
    },
    expectedCTC: {
        type: Number,
        min: 0
    },

    // Competing Offer Details
    inHandOffer: {
        type: Boolean,
        default: false
    },
    offerCompany: {
        type: String,
        trim: true
    },
    offerCTC: {
        type: Number,
        min: 0
    },
    offerJoiningDate: {
        type: Date
    },

    preference: {
        type: String,
        enum: ['Highly Recommended', 'Recommended', 'Neutral / Average', 'Not Recommended', 'Very Poor']
    },

    // Experience & Qualification
    totalExperience: {
        type: Number,
        required: false,
        default: 0,
        min: 0
    },
    qualification: {
        type: String,
        trim: true
    },
    currentCompany: {
        type: String,
        trim: true
    },
    pastExperience: [{
        companyName: {
            type: String
        },
        experienceYears: {
            type: Number
        },
        role: {
            type: String,
            trim: true
        }
    }],
    mustHaveSkills: [{
        skill: { type: String },
        experience: { type: Number, min: 0 }
    }],
    niceToHaveSkills: [{
        skill: { type: String },
        experience: { type: Number, min: 0 }
    }],

    // Location Details
    currentLocation: {
        type: String,
        trim: true
    },
    preferredLocation: {
        type: String,
        trim: true
    },

    // Availability
    tatToJoin: {
        type: Number,
        min: 0
    },
    noticePeriod: {
        type: Number,
        min: 0
    },
    lastWorkingDay: {
        type: Date
    },

    // Status Tracking
    status: {
        type: String,
        enum: ['Total Sourced', 'Interested', 'Interview Scheduled', 'Shortlisted', 'Profile Shared', 'Offer Released', 'Not Interested', 'Not Relevant', 'Not Picking', 'In Interview', 'High expectation', 'Long Notice period', 'Location Not suitable', ''],
        default: 'Total Sourced',
        required: false
    },
    statusHistory: [{
        status: {
            type: String,
            enum: ['Total Sourced', 'Interested', 'Interview Scheduled', 'Shortlisted', 'Profile Shared', 'Offer Released', 'Not Interested', 'Not Relevant', 'Not Picking', 'In Interview', 'High expectation', 'Long Notice period', 'Location Not suitable', ''],
        },
        changedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        changedAt: {
            type: Date,
            default: Date.now
        },
        remark: String
    }],

    // Interview Tracking
    interviewRounds: [{
        levelName: { // e.g., '1', '2', 'L1 - Technical', 'HR Round'
            type: String,
            required: true
        },
        assignAfterStage: {
            // Accepts a fixed stage name ('Total Sourced', 'Interested', 'Shortlisted',
            // 'Profile Shared', 'Offer Released') OR the levelName of another interview
            // round, enabling round-to-round chaining in the recruitment pipeline.
            type: String,
            default: 'Shortlisted'
        },
        phase: { // Tracks whether this round belongs to Phase 1 or Phase 2
            type: Number,
            default: 1
        },
        assignedTo: [{ // Users assigned to evaluate this round
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        }],
        status: { // State of this specific round
            type: String,
            enum: ['Pending', 'Scheduled', 'Passed', 'Failed', 'Skipped', 'Left in between', 'Shortlisted', 'Rejected', 'Did not Turn up'],
            default: 'Pending'
        },
        scheduledDate: Date,
        feedback: String,
        rating: { // Numeric rating out of 10 when evaluators provide one
            type: Number,
            min: 1,
            max: 10
        },
        evaluatedBy: { // User who actually submitted the pass/fail
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        evaluatedAt: Date,
        skillRatings: [{
            skill: { type: String, required: true },
            rating: { type: Number, min: 0, max: 10, default: 0 },
            category: { type: String, enum: ['Must-Have', 'Nice-To-Have', 'Additional'], default: 'Additional' }
        }],
        customFields: [{
            key: { type: String, trim: true },
            value: { type: String, trim: true }
        }],
        emailTemplateId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmailTemplate',
            default: null
        },
        emailAccountId: { type: String, trim: true, default: null },
        cc: { type: String, trim: true, default: '' },
        bcc: { type: String, trim: true, default: '' },
        customSubject: { type: String, default: '' },
        customHtmlBody: { type: String, default: '' },
        mailSent: { type: Boolean, default: false },
        mailSentAt: { type: Date, default: null },
        lastMailDetails: {
            sentAt: Date,
            subject: String,
            htmlBody: String,
            senderEmail: String,
            candidateEmail: String,
            cc: String,
            bcc: String,
            interviewers: [{ name: String, email: String }]
        }
    }],

    // Hiring Decision
    decision: {
        type: String,
        enum: ['Shortlisted', 'Profile Shared', 'Rejected', 'On Hold', 'Did Not Turn Up', 'Left in between', 'None', '']
    },

    profileShared: {
        type: Boolean,
        default: false
    },

    // Phase 2 Client Decision
    phase2Decision: {
        type: String,
        enum: ['Shortlisted', 'Selected', 'Rejected', 'On Hold', 'Left in between', 'None', '']
    },

    phase2InterviewerFeedback: {
        type: String,
        trim: true
    },

    phase2InterviewStatus: {
        type: String,
        enum: ['Scheduled', 'Rejected', 'Shortlisted', 'Did not Turn up', 'Left in between', 'None', ''],
        default: 'None'
    },

    // Phase 3 Offer & Onboarding Decision
    phase3Decision: {
        type: String,
        enum: ['Offer Sent', 'Offer Accepted', 'Offer Declined', 'Joined', 'No Show', 'None', ''],
        default: 'None'
    },

    remark: {
        type: String,
        trim: true
    },

    internalRemark: {
        type: String,
        trim: true
    },

    // Tracking Reopened Candidates
    isTransferred: { type: Boolean, default: false },
    transferredFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'HiringRequest' },
    isTransferredToOnboarding: { type: Boolean, default: false },

    // Skill Ratings
    skillRatings: [{
        skill: { type: String, required: true },
        rating: { type: Number, min: 0, max: 10, default: 0 },
        category: { type: String, enum: ['Must-Have', 'Nice-To-Have', 'Additional'], default: 'Additional' }
    }],

    phaseHistory: {
        type: [phaseHistorySchema],
        default: []
    },
    currentPhaseId: {
        type: mongoose.Schema.Types.ObjectId,
        index: true
    },
    currentPhaseOrder: {
        type: Number,
        index: true
    },
    currentPhaseStatus: {
        type: String,
        default: ''
    },
    currentPhaseName: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

// Only active candidates should participate in requisition-level duplicate enforcement.
candidateSchema.index(
    { hiringRequestId: 1, email: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: { $ne: true }
        }
    }
);

candidateSchema.index(
    { hiringRequestId: 1, mobile: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: { $ne: true },
            mobile: { $exists: true, $ne: '' }
        }
    }
);

// Performance Indexes
candidateSchema.index({ hiringRequestId: 1, status: 1 });
candidateSchema.index({ hiringRequestId: 1, decision: 1 });
candidateSchema.index({ hiringRequestId: 1, profileShared: 1 });
candidateSchema.index({ hiringRequestId: 1, phase2Decision: 1 });
candidateSchema.index({ hiringRequestId: 1, phase3Decision: 1 });
candidateSchema.index({ companyId: 1, createdAt: -1 });
candidateSchema.index({ companyId: 1, uploadedBy: 1, createdAt: -1 });
candidateSchema.index({ companyId: 1, 'interviewRounds.assignedTo': 1 });
candidateSchema.index({ currentPhaseId: 1, hiringRequestId: 1 });
candidateSchema.index({ currentPhaseOrder: 1, hiringRequestId: 1 });
candidateSchema.index({ companyId: 1, currentPhaseId: 1 });
candidateSchema.index({ companyId: 1, isDeleted: 1 });

candidateSchema.methods.getCurrentPhaseEntry = function getCurrentPhaseEntry() {
    return this.phaseHistory.find((phase) => !phase.exitedAt);
};

candidateSchema.pre('save', async function candidatePreSave() {
    if (!this.isNew || (Array.isArray(this.phaseHistory) && this.phaseHistory.length > 0)) {
        return;
    }

    const { HiringRequest } = require('./hiringRequest.model');
    const hiringRequest = await HiringRequest.findOne({
        _id: this.hiringRequestId,
        companyId: this.companyId
    }).select('useDynamicPhases phases assignedUsers');

    if (!hiringRequest) {
        return;
    }

    const initialDynamicState = buildInitialDynamicPhaseState(
        hiringRequest,
        Array.isArray(hiringRequest.assignedUsers) ? hiringRequest.assignedUsers : []
    );

    if (initialDynamicState.phaseHistory?.length) {
        this.phaseHistory = initialDynamicState.phaseHistory;
        this.currentPhaseId = initialDynamicState.currentPhaseId;
        this.currentPhaseOrder = initialDynamicState.currentPhaseOrder;
        this.currentPhaseStatus = initialDynamicState.currentPhaseStatus;
        this.currentPhaseName = initialDynamicState.currentPhaseName;
    }
});

candidateSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Candidate', candidateSchema);
