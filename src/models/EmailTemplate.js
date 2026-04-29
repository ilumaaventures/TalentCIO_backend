const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
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

emailTemplateSchema.index({ companyId: 1, isActive: 1, updatedAt: -1 });
emailTemplateSchema.index({ companyId: 1, name: 1 });

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);
