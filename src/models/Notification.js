const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    title: {
        type: String,
        required: true
    },
    message: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['Info', 'Alert', 'Action', 'Interview', 'Approval'],
        default: 'Info'
    },
    isRead: {
        type: Boolean,
        default: false
    },
    link: {
        type: String, // Allow notifications to navigate users to specific app URLs
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed, // Store dynamic IDs like hiringRequestId, candidateId, etc.
    }
}, {
    timestamps: true
});

notificationSchema.index({ user: 1, companyId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
