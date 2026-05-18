const mongoose = require('mongoose');

const permissionDelegationSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    delegatorUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    delegateUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    permissionKeys: [{
        type: String,
        trim: true
    }],
    resourceScopes: {
        hiringRequestIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'HiringRequest'
        }],
        candidateIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Candidate'
        }],
        clientNames: [{
            type: String,
            trim: true
        }]
    },
    validFrom: {
        type: Date,
        required: true
    },
    validTo: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'active', 'revoked', 'expired'],
        default: 'pending',
        index: true
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    notes: {
        type: String,
        default: ''
    }
}, { timestamps: true });

permissionDelegationSchema.index({ companyId: 1, delegateUserId: 1, status: 1, validFrom: 1, validTo: 1 });
permissionDelegationSchema.index({ companyId: 1, delegatorUserId: 1, status: 1, validFrom: 1, validTo: 1 });

module.exports = mongoose.model('PermissionDelegation', permissionDelegationSchema);
