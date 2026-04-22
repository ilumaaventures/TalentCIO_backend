const mongoose = require('mongoose');

const publicApplicationSchema = new mongoose.Schema({
    hiringRequestId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'HiringRequest',
        required: true,
        index: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    applicantId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Applicant',
        index: true
    },

    candidateName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    mobile: { type: String, required: true, trim: true },
    currentCTC: { type: Number, min: 0 },
    expectedCTC: { type: Number, min: 0 },
    noticePeriod: { type: Number, min: 0 },
    coverNote: { type: String, trim: true, maxlength: 500 },

    resumeUrl: { type: String, required: true },
    resumePublicId: { type: String, required: true },
    profileSnapshot: {
        headline: String,
        summary: String,
        totalExperienceYears: Number,
        skills: [String],
        currentCity: String,
        linkedinUrl: String,
        githubUrl: String,
        portfolioUrl: String,
        workExperience: [{
            jobTitle: String,
            companyName: String,
            startYear: Number,
            endYear: Number,
            isCurrent: Boolean
        }],
        education: [{
            degree: String,
            institution: String,
            endYear: Number
        }],
        certifications: [{
            name: String,
            issuingOrganization: String
        }]
    },

    reviewStatus: {
        type: String,
        enum: ['Pending Review', 'Shortlisted', 'Rejected', 'Transferred'],
        default: 'Pending Review'
    },
    reviewNote: { type: String, trim: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },

    transferredCandidateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Candidate'
    },
    transferredAt: { type: Date },
    transferredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    source: { type: String, default: 'Public Job Board' },
}, { timestamps: true });

publicApplicationSchema.index({ hiringRequestId: 1, email: 1 }, { unique: true });
publicApplicationSchema.index({ hiringRequestId: 1, reviewStatus: 1 });
publicApplicationSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model('PublicApplication', publicApplicationSchema);
