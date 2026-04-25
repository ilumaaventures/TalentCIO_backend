const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const applicantSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    mobile: { type: String, trim: true },
    password: { type: String },
    authProvider: {
        type: String,
        enum: ['local', 'google'],
        default: 'local'
    },
    googleId: { type: String, unique: true, sparse: true },

    isEmailVerified: { type: Boolean, default: false },
    emailOtp: { type: String, default: null },
    emailOtpExpires: { type: Date, default: null },

    resetOtp: { type: String, default: null },
    resetOtpExpires: { type: Date, default: null },

    headline: { type: String, trim: true, maxlength: 120 },
    summary: { type: String, trim: true, maxlength: 1000 },

    currentCity: { type: String, trim: true },
    currentState: { type: String, trim: true },
    currentCountry: { type: String, trim: true, default: 'India' },
    willingToRelocate: { type: Boolean, default: false },
    preferredLocations: [{ type: String, trim: true }],

    preferredJobTypes: [{
        type: String,
        enum: ['Full-time', 'Part-time', 'Contract', 'Freelance', 'Internship', 'Remote']
    }],
    preferredDepartments: [{ type: String, trim: true }],
    jobSearchStatus: {
        type: String,
        enum: ['Actively Looking', 'Open to Opportunities', 'Not Looking'],
        default: 'Actively Looking'
    },

    currentCTC: { type: Number, min: 0 },
    expectedCTC: { type: Number, min: 0 },
    noticePeriod: { type: Number, min: 0 },
    totalExperienceYears: { type: Number, min: 0, default: 0 },

    workExperience: [{
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        jobTitle: { type: String, required: true, trim: true },
        companyName: { type: String, required: true, trim: true },
        employmentType: {
            type: String,
            enum: ['Full-time', 'Part-time', 'Contract', 'Freelance', 'Internship'],
            default: 'Full-time'
        },
        location: { type: String, trim: true },
        locationType: {
            type: String,
            enum: ['Onsite', 'Remote', 'Hybrid'],
            default: 'Onsite'
        },
        startMonth: { type: Number, min: 1, max: 12 },
        startYear: { type: Number },
        endMonth: { type: Number, min: 1, max: 12 },
        endYear: { type: Number },
        isCurrent: { type: Boolean, default: false },
        description: { type: String, trim: true, maxlength: 2000 },
        skills: [{ type: String, trim: true }]
    }],

    education: [{
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        degree: { type: String, required: true, trim: true },
        fieldOfStudy: { type: String, trim: true },
        institution: { type: String, required: true, trim: true },
        grade: { type: String, trim: true },
        startYear: { type: Number },
        endYear: { type: Number },
        isCurrent: { type: Boolean, default: false },
        description: { type: String, trim: true, maxlength: 500 }
    }],

    skills: [{
        name: { type: String, required: true, trim: true },
        level: {
            type: String,
            enum: ['Beginner', 'Intermediate', 'Advanced', 'Expert'],
            default: 'Intermediate'
        }
    }],

    certifications: [{
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        name: { type: String, required: true, trim: true },
        issuingOrganization: { type: String, trim: true },
        issueMonth: { type: Number, min: 1, max: 12 },
        issueYear: { type: Number },
        expiryMonth: { type: Number, min: 1, max: 12 },
        expiryYear: { type: Number },
        doesNotExpire: { type: Boolean, default: false },
        credentialId: { type: String, trim: true },
        credentialUrl: { type: String, trim: true }
    }],

    languages: [{
        language: { type: String, required: true, trim: true },
        proficiency: {
            type: String,
            enum: ['Elementary', 'Conversational', 'Professional', 'Native'],
            default: 'Professional'
        }
    }],

    linkedinUrl: { type: String, trim: true },
    githubUrl: { type: String, trim: true },
    portfolioUrl: { type: String, trim: true },
    otherLinks: [{
        label: { type: String, trim: true },
        url: { type: String, trim: true }
    }],

    resumeUrl: { type: String },
    resumePublicId: { type: String },
    resumeFileName: { type: String },
    resumeUpdatedAt: { type: Date },

    profilePhotoUrl: { type: String },
    profilePhotoPublicId: { type: String },

    profileCompletionScore: { type: Number, default: 0, min: 0, max: 100 },

    tokenVersion: { type: Number, default: 0 }
}, { timestamps: true });

applicantSchema.pre('save', async function savePassword() {
    if (!this.isModified('password') || !this.password) {
        return;
    }

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

applicantSchema.methods.matchPassword = async function matchPassword(enteredPassword) {
    if (!this.password || !enteredPassword) {
        return false;
    }

    return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('Applicant', applicantSchema);
