const mongoose = require('mongoose');

const AddressSchema = new mongoose.Schema({
    type: { type: String, enum: ['Current', 'Permanent', 'Mailing'] },
    line1: String,
    addressLine2: String,
    city: String,
    state: String,
    zipCode: String,
    country: String,
    phone: String,
    isSameAsCurrent: { type: Boolean, default: false }
});

const WorkHistorySchema = new mongoose.Schema({
    companyName: String,
    designation: String,
    startDate: Date,
    endDate: Date,
    reasonForLeaving: String,
    totalExperience: String // e.g. "2 years 4 months"
});

const EducationSchema = new mongoose.Schema({
    institution: String,
    courseName: String, // B.Tech / M.Tech / MCA / BCA
    university: String,
    degree: String,
    fieldOfStudy: String,
    startDate: Date,
    endDate: Date,
    grade: String, // A+ / A / B+ / B etc.
    rank: String,
    collegeRank: String,
    fromDate: Date,
    toDate: Date
});

const ChildSchema = new mongoose.Schema({
    name: String,
    dob: Date
});

const DocumentVersionSchema = new mongoose.Schema({
    versionNumber: { type: Number, required: true },
    title: String,
    fileName: String,
    url: String,
    uploadDate: Date,
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verificationStatus: {
        type: String,
        enum: ['Pending', 'Pending Review', 'Verified', 'Rejected'],
        default: 'Pending Review'
    },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: Date,
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: Date,
    rejectionReason: String,
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: Date,
    revocationReason: String,
    archivedAt: { type: Date, default: Date.now },
    archiveReason: String
}, { _id: false });

const employeeProfileSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },

    // --- Personal Information ---
    personal: {
        firstName: String, // Redundant but helpful for forms
        middleName: String,
        lastName: String,
        fullName: String,
        dob: Date,
        gender: { type: String, enum: ['Male', 'Female', 'Other', 'Prefer not to say'] },
        maritalStatus: { type: String, enum: ['Single', 'Married', 'Divorced', 'Widowed'] },
        dateOfMarriage: Date,
        bloodGroup: String,
        nationality: String,
        shirtSize: String, // For swag
        photo: String, // URL
        joiningDate: Date,

        // Extended Attributes
        disabilityStatus: { type: Boolean, default: false },
        disabilityDetails: String,
        medicalConditions: { type: String, select: false }, // Confidential

        hobbies: [String]
    },

    // --- Identity & Confidential ---
    identity: {
        aadhaarNumber: { type: String, select: false }, // Private by default
        panNumber: { type: String, select: false },
        passportNumber: { type: String, select: false },
        passportExpiry: Date,
        visaStatus: String,
        visaExpiryDate: Date
    },

    // --- Contact Details ---
    contact: {
        personalEmail: String,
        workEmail: String,
        mobileNumber: String,
        alternateNumber: String,
        emergencyNumber: String,
        landlineNumber: String,
        addresses: [AddressSchema],
        emergencyContact: {
            name: String,
            relation: String,
            phone: String,
            alternatePhone: String,
            email: String
        }
    },

    // --- Family Details (New for HRIS) ---
    family: {
        fatherName: String,
        fatherDob: Date,
        fatherOccupation: String,
        motherName: String,
        motherDob: Date,
        motherOccupation: String,
        parentsMaritalStatus: { type: String, enum: ['Single', 'Married', 'Divorced', 'Widowed', 'Separated'] },
        totalSiblings: Number,
        spouseName: String,
        spouseDob: Date,
        children: [ChildSchema]
    },

    // --- Employment Details ---
    employment: {
        designation: String,
        department: String,
        businessUnit: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessUnit' },
        reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        joiningDate: Date,
        confirmationDate: Date,
        status: { type: String, enum: ['Active', 'On Notice', 'Terminated', 'Resigned', 'Retired'] },
        noticePeriodDays: Number,
        workLocation: { type: String, enum: ['Office', 'Remote', 'Hybrid'] },
        branch: String,
        employmentType: {
            type: String,
            enum: ['Full Time', 'Part Time', 'Contract', 'Intern', 'Consultant', 'Freelance', 'Probation'],
            default: 'Full Time'
        }
    },

    // --- Compensation & Benefits ---
    compensation: {
        ctc: { type: Number, select: false }, // Confidential
        salaryBreakup: Map, // Flexible key-value structure
        bankDetails: {
            accountNumber: { type: String, select: false },
            ifscCode: String,
            bankName: String,
            accountHolderName: String,
            branchAddress: String
        },
        pfAccountNumber: String,
        uanNumber: String
    },

    // --- Documents ---
    documents: [{
        category: { type: String, enum: ['ID Proof', 'Education', 'Offer Letter', 'Payslips', 'Tax', 'Other', 'Employment', 'Resume', 'Appointment Letter', 'Relieving Letter', 'Bank'] },
        title: String,
        fileName: String, // Original filename from upload
        url: String,
        uploadDate: { type: Date, default: Date.now },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        expiryDate: Date,
        verificationStatus: {
            type: String,
            enum: ['Pending', 'Pending Review', 'Verified', 'Rejected'],
            default: 'Pending Review'
        },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        verifiedAt: Date,
        rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        rejectedAt: Date,
        rejectionReason: String,
        revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        revokedAt: Date,
        revocationReason: String,
        deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        deletedAt: Date,
        versionNumber: { type: Number, default: 1 },
        isDeleted: { type: Boolean, default: false },
        versionHistory: [DocumentVersionSchema]
    }],
    documentSubmissionStatus: {
        type: String,
        enum: ['Draft', 'Submitted', 'Approved', 'Changes Requested'],
        default: 'Draft'
    },

    // --- History & Skills ---
    education: [EducationSchema],
    experience: [WorkHistorySchema],
    skills: {
        technical: [String],
        behavioral: [String],
        learningInterests: [String]
    },

    // --- HRIS Submission ---
    hris: {
        isDeclared: { type: Boolean, default: false },
        declarationDate: Date,
        submittedAt: Date,
        lastUpdatedAt: Date,
        status: {
            type: String,
            enum: ['Draft', 'Pending Approval', 'Approved', 'Rejected'],
            default: 'Draft'
        },
        rejectionReason: String,
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        approvalDate: Date
    },

    // --- Staging Area for Pending Updates ---
    pendingUpdates: { type: mongoose.Schema.Types.Mixed, default: null },

    // --- Metadata ---
    tags: [String],
    isConfidential: { type: Boolean, default: false } // VIP profile

}, { timestamps: true });

employeeProfileSchema.pre('save', async function () {
    let joiningDate = null;
    
    if (this.isModified('personal.joiningDate')) {
        joiningDate = this.personal.joiningDate;
    } else if (this.isModified('employment.joiningDate')) {
        joiningDate = this.employment.joiningDate;
    }
    
    if (joiningDate) {
        this.personal.joiningDate = joiningDate;
        this.employment.joiningDate = joiningDate;
        
        // Sync to User model
        try {
            const User = mongoose.model('User');
            await User.updateOne({ _id: this.user }, { $set: { joiningDate } });
        } catch (err) {
            console.error('Error syncing joiningDate to User model:', err);
        }
    }
});

module.exports = mongoose.model('EmployeeProfile', employeeProfileSchema);
