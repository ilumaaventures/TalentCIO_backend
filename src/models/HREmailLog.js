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
        required: true
    },
    recipientUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    recipientEmail: {
        type: String,
        trim: true,
        default: ''
    },
    subject: {
        type: String,
        trim: true,
        default: ''
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
    }
}, { timestamps: true });

hrEmailLogSchema.index({ companyId: 1, recipientUserId: 1, sentAt: -1 });

module.exports = mongoose.model('HREmailLog', hrEmailLogSchema);
