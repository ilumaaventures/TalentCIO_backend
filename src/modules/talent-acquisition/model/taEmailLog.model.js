const mongoose = require('mongoose');

const taEmailLogSchema = new mongoose.Schema({
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
    senderEmail: {
        type: String,
        trim: true,
        default: ''
    },
    senderName: {
        type: String,
        trim: true,
        default: ''
    },
    fromAddress: {
        type: String,
        trim: true,
        default: ''
    },
    fromName: {
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
        default: ''
    },
    hiringRequestId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'HiringRequest',
        default: null,
        index: true
    },
    hiringRequestTitle: {
        type: String,
        trim: true,
        default: ''
    },
    candidateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Candidate',
        default: null,
        index: true
    },
    recipientName: {
        type: String,
        trim: true,
        default: '',
        index: true
    },
    recipientEmail: {
        type: String,
        trim: true,
        default: '',
        index: true
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
    templateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmailTemplate',
        default: null,
        index: true
    },
    templateName: {
        type: String,
        trim: true,
        default: 'General Mail',
        index: true
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
    status: {
        type: String,
        enum: ['Sent', 'Failed', 'Pending'],
        default: 'Sent',
        index: true
    },
    batchId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
        index: true
    },
    batchTotalCount: {
        type: Number,
        default: 1
    },
    attachments: [{
        filename: { type: String, default: '' },
        path: { type: String, default: '' },
        url: { type: String, default: '' },
        contentType: { type: String, default: '' },
        size: { type: Number, default: 0 }
    }],
    errorReason: {
        type: String,
        trim: true,
        default: ''
    },
    sentAt: {
        type: Date,
        default: Date.now,
        index: true
    }
}, { timestamps: true });

taEmailLogSchema.index({ companyId: 1, sentAt: -1 });
taEmailLogSchema.index({ companyId: 1, hiringRequestId: 1, sentAt: -1 });
taEmailLogSchema.index({ companyId: 1, candidateId: 1, sentAt: -1 });
taEmailLogSchema.index({ companyId: 1, status: 1, sentAt: -1 });
taEmailLogSchema.index({ companyId: 1, recipientEmail: 1, sentAt: -1 });

module.exports = mongoose.model('TAEmailLog', taEmailLogSchema);
