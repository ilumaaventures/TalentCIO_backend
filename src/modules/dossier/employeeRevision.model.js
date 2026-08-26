const mongoose = require('mongoose');

const revisionChangeSchema = new mongoose.Schema({
    module: {
        type: String,
        enum: ['employment', 'compensation', 'leave', 'attendance', 'permissions', 'other'],
        required: true
    },
    field: {
        type: String,
        required: true
    },
    fieldLabel: {
        type: String,
        default: ''
    },
    previousValue: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    revisedValue: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    previousDisplayValue: {
        type: String,
        default: ''
    },
    revisedDisplayValue: {
        type: String,
        default: ''
    }
}, { _id: false });

const employeeRevisionSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    employeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    effectiveDate: {
        type: Date,
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['scheduled', 'active', 'superseded', 'cancelled'],
        default: 'scheduled',
        index: true
    },
    reason: {
        type: String,
        default: ''
    },
    changes: {
        type: [revisionChangeSchema],
        default: []
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    approvalStatus: {
        type: String,
        enum: ['not_required', 'pending', 'approved', 'rejected'],
        default: 'not_required'
    },
    appliedAt: {
        type: Date,
        default: null
    },
    cancelledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    cancelledAt: {
        type: Date,
        default: null
    },
    cancellationReason: {
        type: String,
        default: ''
    },
    isInitialBaseline: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Compound indexes for fast query resolution
employeeRevisionSchema.index({ companyId: 1, employeeId: 1, effectiveDate: -1, createdAt: -1 });
employeeRevisionSchema.index({ companyId: 1, status: 1, effectiveDate: 1 });

module.exports = mongoose.model('EmployeeRevision', employeeRevisionSchema);
