const mongoose = require('mongoose');

const hrEmailAttachmentSchema = new mongoose.Schema({
    filename: { type: String, trim: true, default: '' },
    cloudinaryUrl: { type: String, trim: true, default: '' },
    publicId: { type: String, trim: true, default: '' },
    dossierDocId: { type: mongoose.Schema.Types.ObjectId, default: null }
}, { _id: false });

const hrEmailLogSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    sentBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: false
    },
    recipientUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: false,
        index: true
    },
    recipientEmail: {
        type: String,
        trim: true,
        default: ''
    },
    cc: {
        type: String,
        trim: true,
        default: ''
    },
    bcc: {
        type: String,
        trim: true,
        default: ''
    },
    subject: {
        type: String,
        trim: true,
        default: ''
    },
    body: {
        type: String,
        default: ''
    },
    type: {
        type: String,
        enum: ['onboarding', 'general', 'offboarding', 'adhoc', 'template'],
        default: 'general',
        index: true
    },
    templateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmailTemplate',
        default: null
    },
    templateName: {
        type: String,
        trim: true,
        default: ''
    },
    emailAccountId: {
        type: String,
        trim: true,
        default: 'platform'
    },
    emailAccountLabel: {
        type: String,
        trim: true,
        default: 'TalentCIO Platform'
    },
    attachments: {
        type: [hrEmailAttachmentSchema],
        default: []
    },
    dossierCategory: {
        type: String,
        trim: true,
        default: ''
    },
    dossierSaved: {
        type: Boolean,
        default: false
    },
    dossierDocIds: {
        type: [mongoose.Schema.Types.ObjectId],
        default: []
    },
    dossierSaveError: {
        type: String,
        trim: true,
        default: ''
    },
    sentAt: {
        type: Date,
        default: Date.now
    },
    notes: {
        type: String,
        trim: true,
        default: ''
    },
    status: {
        type: String,
        enum: ['Sent', 'Failed'],
        default: 'Sent',
        index: true
    },
    failureReason: {
        type: String,
        trim: true,
        default: ''
    },
    batchId: {
        type: String,
        trim: true,
        index: true
    },
    source: {
        type: String,
        trim: true,
        default: 'hr_send_page',
        index: true
    }
}, { timestamps: true });

hrEmailLogSchema.index({ companyId: 1, sentAt: -1 });
hrEmailLogSchema.index({ companyId: 1, type: 1, sentAt: -1 });
hrEmailLogSchema.index({ companyId: 1, source: 1, sentAt: -1 });
hrEmailLogSchema.index({ companyId: 1, recipientUserId: 1, sentAt: -1 });
hrEmailLogSchema.index({ companyId: 1, recipientUserId: 1, type: 1, sentAt: -1 });
hrEmailLogSchema.index({ companyId: 1, recipientEmail: 1, type: 1, sentAt: -1 });

// Note: Post-save hook for FIFO cap previously deleted logs older than 20 entries per recipient.
// Removed to ensure full compliance, permanent audit trail, and complete history in the HR Email History page.

module.exports = mongoose.model('HREmailLog', hrEmailLogSchema);
