const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true
    },
    firstName: String,
    lastName: String,
    roles: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Role'
    }],
    isActive: {
        type: Boolean,
        default: true
    },
    department: String,
    employmentType: {
        type: String,
        enum: ['Full Time', 'Part Time', 'Contract', 'Intern', 'Consultant', 'Freelance', 'Probation'],
        default: 'Full Time'
    },
    profilePicture: {
        type: String,
        default: ''
    },
    workLocation: {
        type: String,
        default: 'Headquarters' // Default value
    },
    employeeCode: String,
    reportingManagers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    joiningDate: Date,
    employeeProfile: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeProfile'
    },
    dossierStatus: {
        type: String,
        enum: ['Incomplete', 'Pending Verification', 'Verified'],
        default: 'Incomplete'
    },
    tokenVersion: {
        type: Number,
        default: 0
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    isPasswordResetRequired: {
        type: Boolean,
        default: true
    },
    otp: {
        type: String,
        default: null
    },
    otpExpires: {
        type: Date,
        default: null
    }
}, { timestamps: true });

userSchema.index({ companyId: 1, isActive: 1 });
userSchema.index({ companyId: 1, department: 1 });
userSchema.index({ companyId: 1, reportingManagers: 1 });
userSchema.index({ companyId: 1, email: 1 }, { unique: true });
userSchema.index({ companyId: 1, employeeCode: 1 }, { unique: true, sparse: true });

// Encrypt password before save and handle token invalidation
userSchema.pre('save', async function () {
    // 1. Password Encryption
    if (this.isModified('password')) {
        try {
            const salt = await bcrypt.genSalt(10);
            this.password = await bcrypt.hash(this.password, salt);
        } catch (err) {
            throw err;
        }
    }

    // 2. Token Invalidation (Logout on detail update)
    // If any of these fields are modified, increment tokenVersion to log the user out
    const securityFields = ['firstName', 'lastName', 'email', 'password', 'roles', 'isActive'];
    const isSecurityModified = securityFields.some(field => this.isModified(field));

    if (isSecurityModified && !this.isNew) {
        this.tokenVersion = (this.tokenVersion || 0) + 1;
        console.log(`[AUTH] tokenVersion incremented for ${this.email} due to security field change.`);
    }
});

userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
