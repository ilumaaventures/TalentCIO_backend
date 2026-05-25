const mongoose = require('mongoose');
const softDeletePlugin = require('../utils/softDeletePlugin');

const emailTemplateSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    scope: {
        type: String,
        enum: ['ta', 'general'],
        default: 'ta',
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    subject: {
        type: String,
        required: true,
        trim: true
    },
    htmlBody: {
        type: String,
        required: true
    },
    templateType: {
        type: String,
        enum: ['general', 'onboarding'],
        default: 'general',
        index: true
    },
    category: {
        type: String,
        enum: ['interview_invite', 'rejection', 'offer', 'shortlist', 'general'],
        default: 'general'
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

emailTemplateSchema.index({ companyId: 1, scope: 1, templateType: 1, isActive: 1, updatedAt: -1 });
emailTemplateSchema.index({ companyId: 1, scope: 1, templateType: 1, name: 1 });
emailTemplateSchema.index({ companyId: 1, isDeleted: 1 });
emailTemplateSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);
