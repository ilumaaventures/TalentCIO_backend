const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const superAdminUserSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: {
        type: String,
        enum: ['Super Admin', 'Support Admin', 'Finance Admin'],
        default: 'Support Admin'
    },
    permissions: {
        manageCompanies: { type: Boolean, default: false },
        managePlans: { type: Boolean, default: false },
        viewAnalytics: { type: Boolean, default: true },
        manageUsers: { type: Boolean, default: false },
        viewLogs: { type: Boolean, default: true },
    },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date },
    avatar: { type: String, default: '' },
}, { timestamps: true });

// Combined hook for password hashing and permissions
superAdminUserSchema.pre('save', async function () {
    // 1. Hash password if changed
    if (this.isModified('password')) {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
    }

    // 2. Set permissions based on role if role changed or permissions missing
    if (this.isModified('role') || !this.permissions) {
        if (this.role === 'Super Admin') {
            this.permissions = { manageCompanies: true, managePlans: true, viewAnalytics: true, manageUsers: true, viewLogs: true };
        } else if (this.role === 'Finance Admin') {
            this.permissions = { manageCompanies: false, managePlans: true, viewAnalytics: true, manageUsers: false, viewLogs: true };
        } else if (this.role === 'Support Admin') {
            this.permissions = { manageCompanies: false, managePlans: false, viewAnalytics: true, manageUsers: false, viewLogs: true };
        }
    }
});

superAdminUserSchema.methods.matchPassword = async function (entered) {
    return await bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model('SuperAdminUser', superAdminUserSchema);
