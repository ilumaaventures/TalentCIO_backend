const mongoose = require('mongoose');

const leaveBucketSchema = new mongoose.Schema({
    bucketId: { type: String }, // e.g. "2026-08"
    creditedDate: { type: Date, default: Date.now },
    creditMonth: { type: Number, required: true }, // 1-12
    creditYear: { type: Number, required: true },  // e.g. 2026
    creditAmount: { type: Number, required: true, default: 0 },
    utilizedAmount: { type: Number, default: 0 },
    remainingAmount: { type: Number, required: true, default: 0 },
    validityMonths: { type: Number, default: 2 }, // 2 months validity
    expiryMonth: { type: Number, required: true }, // e.g. creditMonth + 2
    expiryYear: { type: Number, required: true },
    expiryDate: { type: Date },
    isExpired: { type: Boolean, default: false },
    notes: { type: String }
}, { _id: true, timestamps: true });

const leaveBalanceSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    leaveType: {
        type: String,
        required: true // CL, SL, EL, or any custom type from LeaveConfig
    },
    year: {
        type: Number,
        required: true
    },
    openingBalance: {
        type: Number,
        default: 0
    },
    accrued: {
        type: Number,
        default: 0
    },
    utilized: {
        type: Number,
        default: 0
    },
    expired: {
        type: Number,
        default: 0
    },
    encashed: {
        type: Number,
        default: 0
    },
    closingBalance: {
        type: Number,
        default: 0
    },
    // Rolling monthly lots / buckets for FIFO consumption and rolling 2-month expiry
    buckets: {
        type: [leaveBucketSchema],
        default: []
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    }
}, { timestamps: true });

// Performance Indexes
leaveBalanceSchema.index({ user: 1, year: 1 });
// Compound index to ensure one balance record per type per user per year per company
leaveBalanceSchema.index({ user: 1, leaveType: 1, year: 1, companyId: 1 }, { unique: true });

module.exports = mongoose.model('LeaveBalance', leaveBalanceSchema);
