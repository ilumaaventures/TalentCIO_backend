const mongoose = require('mongoose');

const workLogSchema = new mongoose.Schema({
    task: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Task',
        required: true
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    hours: {
        type: Number,
        required: true,
        min: 0
    },
    description: String,
    status: {
        type: String,
        enum: ['PENDING', 'APPROVED', 'REJECTED'],
        default: 'PENDING'
    },
    rejectionReason: String,
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    }
}, { timestamps: true });

workLogSchema.index({ companyId: 1, user: 1, date: -1 });
workLogSchema.index({ companyId: 1, date: 1 });
workLogSchema.index({ task: 1, companyId: 1, date: -1 });

module.exports = mongoose.model('WorkLog', workLogSchema);
