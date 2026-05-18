const mongoose = require('mongoose');

const accessPolicySchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    module: {
        type: String,
        required: true,
        default: 'TA',
        enum: ['TA']
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        default: ''
    },
    resourceType: {
        type: String,
        required: true,
        enum: ['HiringRequest', 'Candidate']
    },
    actions: [{
        type: String,
        trim: true
    }],
    targetRoles: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Role'
    }],
    targetUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    conditions: {
        assignedClientOnly: {
            type: Boolean,
            default: false
        },
        departments: [{
            type: String,
            trim: true
        }],
        priorities: [{
            type: String,
            trim: true
        }]
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

accessPolicySchema.index({ companyId: 1, module: 1, resourceType: 1, isActive: 1 });
accessPolicySchema.index({ companyId: 1, targetRoles: 1, isActive: 1 });
accessPolicySchema.index({ companyId: 1, targetUsers: 1, isActive: 1 });

module.exports = mongoose.model('AccessPolicy', accessPolicySchema);
