const mongoose = require('mongoose');
const crypto = require('crypto');

const handoffTokenSchema = new mongoose.Schema({
    token: {
        type: String,
        required: true,
        unique: true,
        default: () => crypto.randomBytes(48).toString('hex'),
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true
    },
    subdomain: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    used: {
        type: Boolean,
        default: false
    },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + (2 * 60 * 1000)),
        index: { expireAfterSeconds: 0 }
    }
}, { timestamps: true });

module.exports = mongoose.model('HandoffToken', handoffTokenSchema);
