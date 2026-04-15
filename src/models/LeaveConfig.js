const mongoose = require('mongoose');

const leaveConfigSchema = new mongoose.Schema({
    leaveType: {
        type: String,
        required: true,
        trim: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true
    },
    description: String,
    employeeTypes: {
        type: [String],
        default: []
    },
    isPaid: {
        type: Boolean,
        default: true
    },
    accrualType: {
        type: String,
        enum: ['Monthly', 'Yearly', 'Policy', 'None'],
        default: 'Monthly'
    },
    accrualAmount: {
        type: Number,
        default: 0
    },
    carryForward: {
        type: Boolean,
        default: false
    },
    maxCarryForward: {
        type: Number,
        default: 0
    },
    maxLimitPerYear: {
        type: Number,
        default: 0
    },
    // Rules
    sandwichRule: {
        type: Boolean,
        default: false
    },
    allowNegativeBalance: {
        type: Boolean,
        default: false
    },
    proofRequiredAbove: {
        type: Number,
        default: 0 // 0 means never
    },
    allowBackdated: {
        type: Boolean,
        default: true
    },
    proRata: {
        type: Boolean,
        default: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

// Ensure leave types are unique per company
leaveConfigSchema.index({ leaveType: 1, companyId: 1 }, { unique: true });

module.exports = mongoose.model('LeaveConfig', leaveConfigSchema);
