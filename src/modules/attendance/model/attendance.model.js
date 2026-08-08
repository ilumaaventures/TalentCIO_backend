const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    clockIn: {
        type: Date
    },
    clockOut: {
        type: Date
    },
    clockInIST: String, // Explicit IST time string
    clockOutIST: String, // Explicit IST time string
    attendanceMode: {
        type: String,
        enum: ['clock_in_out', 'present_only'],
        default: 'clock_in_out'
    },
    shiftCode: String,
    shiftName: String,
    shiftType: {
        type: String,
        enum: ['general', 'any']
    },
    shiftStartTime: String,
    shiftEndTime: String,
    maxWorkingHours: Number,
    autoCheckoutAt: Date,
    autoCheckoutReason: String,
    status: {
        type: String,
        enum: ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE'],
        default: 'ABSENT'
    },
    ipAddress: String, // Clock-in IP
    clockOutIpAddress: String, // Clock-out IP
    location: {
        lat: Number,
        lng: Number,
        accuracy: Number
    },
    clockOutLocation: {
        lat: Number,
        lng: Number,
        accuracy: Number
    },
    userAgent: String,
    notes: String,
    approvalStatus: {
        type: String,
        enum: ['PENDING', 'APPROVED', 'REJECTED'],
        default: 'PENDING'
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    rejectionReason: String,
    timesheetSyncError: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Ensure one entry per user per day per company
attendanceSchema.index({ companyId: 1, user: 1, date: 1 }, { unique: true });

// Dashboard: "today's attendance" filter with company scoping
attendanceSchema.index({ companyId: 1, date: 1 });

// Daily auto-checkout scans records by date across all companies.
attendanceSchema.index({ date: 1, clockIn: 1, clockOut: 1 });

// Dashboard: present/absent count with company scoping
attendanceSchema.index({ companyId: 1, date: 1, status: 1 });

// Dashboard: pending approvals per company
attendanceSchema.index({ companyId: 1, approvalStatus: 1 });

// Attendance page: user's own history sorted by date
attendanceSchema.index({ user: 1, date: -1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
