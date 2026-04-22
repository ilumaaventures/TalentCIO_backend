const mongoose = require('mongoose');

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
        enum: ['Interested', 'Not Interested', 'Not Relevant', 'Not Picking', 'In Interview', ''],
        required: false
    },
    statusHistory: [{
        status: {
            type: String,
            enum: ['Interested', 'Not Interested', 'Not Relevant', 'Not Picking', 'In Interview', ''],
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
            enum: ['Pending', 'Scheduled', 'Passed', 'Failed', 'Skipped'],
            default: 'Pending'
        },
        scheduledDate: Date,
        feedback: String,
        rating: { // Numeric rating out of 10 (only for Passed rounds)
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
        }]
    }],

    // Hiring Decision
    decision: {
        type: String,
        enum: ['Shortlisted', 'Rejected', 'On Hold', 'None', '']
    },

    // Phase 2 Client Decision
    phase2Decision: {
        type: String,
        enum: ['Shortlisted', 'Selected', 'Rejected', 'On Hold', 'None', '']
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
    }]
}, {
    timestamps: true
});

// Compound index to ensure unique email per hiring request
candidateSchema.index({ hiringRequestId: 1, email: 1 }, { unique: true });

// Performance Indexes
candidateSchema.index({ hiringRequestId: 1, status: 1 });
candidateSchema.index({ hiringRequestId: 1, decision: 1 });
candidateSchema.index({ hiringRequestId: 1, phase2Decision: 1 });
candidateSchema.index({ hiringRequestId: 1, phase3Decision: 1 });
candidateSchema.index({ companyId: 1, createdAt: -1 });
candidateSchema.index({ companyId: 1, 'interviewRounds.assignedTo': 1 });



module.exports = mongoose.model('Candidate', candidateSchema);
