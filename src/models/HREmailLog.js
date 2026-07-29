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
        enum: ['onboarding', 'general', 'offboarding'],
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
hrEmailLogSchema.index({ companyId: 1, recipientUserId: 1, type: 1, sentAt: -1 });
hrEmailLogSchema.index({ companyId: 1, recipientEmail: 1, type: 1, sentAt: -1 });

// Post-save hook to enforce FIFO cap of 20 latest emails per recipient and type
hrEmailLogSchema.post('save', async function (doc) {
    try {
        const HREmailLog = mongoose.model('HREmailLog');
        const query = {
            companyId: doc.companyId,
            type: doc.type
        };

        if (doc.recipientUserId) {
            query.$or = [
                { recipientUserId: doc.recipientUserId },
                { recipientEmail: doc.recipientEmail }
            ];
        } else {
            query.recipientEmail = doc.recipientEmail;
        }

        const count = await HREmailLog.countDocuments(query);
        if (count > 20) {
            const oldestLogs = await HREmailLog.find(query)
                .sort({ sentAt: 1 })
                .limit(count - 20)
                .select('_id')
                .lean();
            const idsToDelete = oldestLogs.map(l => l._id);
            await HREmailLog.deleteMany({ _id: { $in: idsToDelete } });
        }
    } catch (err) {
        console.error('Error in HREmailLog FIFO hook:', err);
    }
});

module.exports = mongoose.model('HREmailLog', hrEmailLogSchema);
