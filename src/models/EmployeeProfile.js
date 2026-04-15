const mongoose = require('mongoose');

const AddressSchema = new mongoose.Schema({
    type: { type: String, enum: ['Current', 'Permanent', 'Mailing'] },
    street: String,
    addressLine2: String,
    city: String,
    state: String,
    zipCode: String,
    country: String,
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
        mobileNumber: String,
        alternateNumber: String,
        emergencyNumber: String,
        landlineNumber: String,
        addresses: [AddressSchema],
        emergencyContact: {
            name: String,
            relation: String,
            phone: String,
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
        expiryDate: Date,
        verificationStatus: { type: String, enum: ['Pending', 'Verified', 'Rejected'], default: 'Pending' }
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

    // --- Metadata ---
    tags: [String],
    isConfidential: { type: Boolean, default: false } // VIP profile

}, { timestamps: true });

module.exports = mongoose.model('EmployeeProfile', employeeProfileSchema);
