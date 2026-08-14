const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

const celebrationSchema = new mongoose.Schema({
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
    eventKey: {
        type: String,
        required: true,
        trim: true
    },
    celebrationType: {
        type: String,
        enum: ['INDEPENDENCE_DAY', 'DIWALI', 'NEW_YEAR', 'CUSTOM'],
        default: 'INDEPENDENCE_DAY'
    },
    shownAt: {
        type: Date,
        default: Date.now
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, { timestamps: true });

celebrationSchema.index({ user: 1, eventKey: 1 }, { unique: true });
celebrationSchema.index({ companyId: 1, eventKey: 1 });
celebrationSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CelebrationAck', celebrationSchema);
