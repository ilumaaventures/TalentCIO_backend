const mongoose = require('mongoose');

const impersonationSessionSchema = new mongoose.Schema({
    tier: {
        type: String,
        enum: ['company_admin', 'super_admin'],
        required: true
    },
    actorType: {
        type: String,
        enum: ['User', 'SuperAdminUser'],
        required: true
    },
    actorId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        refPath: 'actorType'
    },
    targetUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true
    },
    reason: {
        type: String,
        trim: true,
        maxlength: 500,
        default: ''
    },
    startedAt: {
        type: Date,
        default: Date.now
    },
    expiresAt: {
        type: Date,
        required: true
    },
    endedAt: {
        type: Date,
        default: null
    },
    endedReason: {
        type: String,
        enum: ['manual', 'expired', 'revoked', null],
        default: null
    },
    ipAddress: {
        type: String,
        default: ''
    },
    tokenJti: {
        type: String,
        index: true
    }
}, { timestamps: true });

impersonationSessionSchema.index({ actorId: 1, endedAt: 1 });

module.exports = mongoose.model('ImpersonationSession', impersonationSessionSchema);
