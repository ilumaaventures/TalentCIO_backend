const mongoose = require('mongoose');

/* 
const timesheetEntrySchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true
    },
    project: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project',
        required: true
    },
    hours: {
        type: Number,
        required: true,
        min: 0,
        max: 24
    },
    description: String,
    startTime: String, // HH:mm
    endTime: String,   // HH:mm
    status: {
        type: String,
        enum: ['PENDING', 'APPROVED', 'REJECTED'],
        default: 'PENDING'
    },
    rejectionReason: String
});
*/

const timesheetSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    month: {
        type: String, // Format: "YYYY-MM"
        required: true
    },
    // entries: [timesheetEntrySchema], // DEPRECATED: Using WorkLog model as source of truth
    status: {
        type: String,
        enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
        default: 'DRAFT'
    },
    approver: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    rejectionReason: String,
    submittedAt: {
        type: Date
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    }
}, { timestamps: true });

// Ensure one timesheet per user per month per company
timesheetSchema.index({ user: 1, month: 1, companyId: 1 }, { unique: true });

module.exports = mongoose.model('Timesheet', timesheetSchema);
