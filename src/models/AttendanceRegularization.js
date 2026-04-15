const mongoose = require('mongoose');

const attendanceRegularizationSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    type: {
        type: String,
        enum: ['IN', 'OUT', 'BOTH'],
        required: true
    },
    requestedClockIn: {
        type: Date
    },
    requestedClockOut: {
        type: Date
    },
    reason: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['PENDING', 'APPROVED', 'REJECTED'],
        default: 'PENDING'
    },
    manager: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    rejectionReason: {
        type: String
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    }
}, { timestamps: true });

// Index for efficient lookups
attendanceRegularizationSchema.index({ user: 1, date: 1, status: 1 });
attendanceRegularizationSchema.index({ manager: 1, status: 1 });
attendanceRegularizationSchema.index({ companyId: 1, status: 1 });

module.exports = mongoose.model('AttendanceRegularization', attendanceRegularizationSchema);
