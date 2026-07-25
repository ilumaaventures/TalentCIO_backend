const mongoose = require('mongoose');

/**
 * Stores payroll result notifications received from MyBills after a payroll
 * is marked as paid. Keyed by company + employeeCode + month + year so a
 * re-dispatch from MyBills safely overwrites without creating duplicates.
 */
const payrollResultSchema = new mongoose.Schema({
    companyId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    employeeCode:    { type: String, required: true },
    month:           { type: Number, required: true, min: 1, max: 12 },
    year:            { type: Number, required: true },
    status:          { type: String, default: 'paid', enum: ['paid'] },

    netSalary:       { type: Number, default: 0 },
    grossSalary:     { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    paidDate:        { type: Date },

    breakdown: {
        basic: { type: Number, default: 0 },
        hra:   { type: Number, default: 0 },
        pf:    { type: Number, default: 0 },
        esi:   { type: Number, default: 0 },
        tds:   { type: Number, default: 0 },
        pt:    { type: Number, default: 0 },
        lwf:   { type: Number, default: 0 },
    },

    receivedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// One record per employee per payroll period — idempotent re-dispatch is safe
payrollResultSchema.index(
    { companyId: 1, employeeCode: 1, month: 1, year: 1 },
    { unique: true }
);

module.exports = mongoose.model('PayrollResult', payrollResultSchema);
