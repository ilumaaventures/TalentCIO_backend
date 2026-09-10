const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

const clientUserSchema = new mongoose.Schema({
    clientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client',
        required: true,
        index: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    firstName: {
        type: String,
        required: true,
        trim: true
    },
    lastName: {
        type: String,
        trim: true,
        default: ''
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    phone: {
        type: String,
        trim: true,
        default: ''
    },
    password: {
        type: String,
        default: null
    },
    role: {
        type: String,
        enum: ['ClientAdmin', 'ClientInterviewer', 'ClientViewer'],
        default: 'ClientViewer',
        required: true
    },
    status: {
        type: String,
        enum: ['Invited', 'Active', 'Suspended'],
        default: 'Invited',
        index: true
    },
    inviteToken: {
        type: String,
        default: null,
        sparse: true,
        index: true
    },
    inviteExpires: {
        type: Date,
        default: null
    },
    resetPasswordToken: {
        type: String,
        default: null
    },
    resetPasswordExpires: {
        type: Date,
        default: null
    },
    tokenVersion: {
        type: Number,
        default: 0
    },
    lastLoginAt: {
        type: Date,
        default: null
    },
    isPrimaryContact: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Compound unique: email is unique per client & tenant company
clientUserSchema.index({ companyId: 1, clientId: 1, email: 1 }, { unique: true });
clientUserSchema.index({ companyId: 1, isDeleted: 1 });

clientUserSchema.pre('save', async function () {
    if (this.isModified('password') && this.password) {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
    }

    if (this.isModified('password') && !this.isNew) {
        this.tokenVersion = (this.tokenVersion || 0) + 1;
    }
});

clientUserSchema.methods.matchPassword = async function (enteredPassword) {
    if (!this.password) return false;
    return bcrypt.compare(enteredPassword, this.password);
};

clientUserSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ClientUser', clientUserSchema);
