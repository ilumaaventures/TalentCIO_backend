const mongoose = require('mongoose');

const leaveRequestSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    leaveType: {
        type: String,
        required: true
        // Note: Validation against active policies is handled in leaveController,
        // not hardcoded here, so custom leave types from LeaveConfig will work.
    },
    startDate: {
        type: Date,
        required: true
    },
    endDate: {
        type: Date,
        required: true
    },
    isHalfDay: {
        type: Boolean,
        default: false
    },
    halfDaySession: {
        type: String,
        enum: ['First Half', 'Second Half', null],
        default: null
    },
    reason: {
        type: String,
        required: true
    },
    documents: [{
        type: String // URLs to uploaded files
    }],
    status: {
        type: String,
        enum: ['Pending', 'Approved', 'Rejected', 'Cancelled'],
        default: 'Pending'
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    rejectionReason: String,

    // Calculated fields
    daysCount: {
        type: Number,
        required: true,
        min: 0.5
    },

    // Audit Trail
    auditLog: [{
        action: String, // 'Applied', 'Approved', 'Rejected', 'Cancelled'
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
        comment: String
    }]
}, { timestamps: true });

// Performance Indexes
leaveRequestSchema.index({ companyId: 1, user: 1, createdAt: -1 });
leaveRequestSchema.index({ user: 1, createdAt: -1 });
leaveRequestSchema.index({ status: 1, user: 1 }); // For team approvals (pending status + subordinate ids)
leaveRequestSchema.index({ companyId: 1, status: 1, startDate: 1 });

module.exports = mongoose.model('LeaveRequest', leaveRequestSchema);
