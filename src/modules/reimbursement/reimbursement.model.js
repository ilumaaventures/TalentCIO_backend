const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

// Mirrors announcementAttachmentSchema from announcement.model.js
const receiptAttachmentSchema = new mongoose.Schema({
    url:          { type: String, trim: true, default: '' },
    name:         { type: String, trim: true, default: '' },
    publicId:     { type: String, trim: true, default: '' },
    resourceType: { type: String, enum: ['image', 'raw'], default: 'raw' },
    mimeType:     { type: String, trim: true, default: '' },
    size:         { type: Number, default: 0 },
    uploadedAt:   { type: Date, default: Date.now }
}, { _id: false });

// Itemized expense row schema matching "Date | Description | Category Type | Amount | Receipt Attached (Y/N)"
const expenseItemSchema = new mongoose.Schema({
    expenseDate:       { type: Date, required: true },
    description:       { type: String, required: true, trim: true },
    category:          { type: String, required: true, trim: true },
    otherCategoryName: { type: String, trim: true, default: '' },
    amount:            { type: Number, required: true, min: 0 },
    hasReceipt:        { type: Boolean, default: false }
}, { _id: false });

// One entry per approval level action — mirrors leaveRequest auditLog style
const approvalTrailSchema = new mongoose.Schema({
    level:    { type: Number, required: true },
    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action:   { type: String, enum: ['Approved', 'Rejected'], required: true },
    comment:  { type: String, default: '' },
    actedAt:  { type: Date, default: Date.now }
}, { _id: false });

const auditLogSchema = new mongoose.Schema({
    action:  String, // 'Submitted', 'Approved', 'Rejected', 'Cancelled', 'Reimbursed'
    by:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at:      { type: Date, default: Date.now },
    comment: String
}, { _id: false });

const reimbursementSchema = new mongoose.Schema({
    employee: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'User',
        required: true
    },
    companyId: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Company',
        required: true,
        index:    true
    },

    // Employee & Form metadata snapshot
    department:        { type: String, trim: true, default: '' },
    employeeCode:      { type: String, trim: true, default: '' },

    // Primary summary fields
    category:          { type: String, required: true, trim: true },
    otherCategoryName: { type: String, trim: true, default: '' },
    amount:            { type: Number, required: true, min: 0 },
    currency:          { type: String, default: 'INR', trim: true },
    expenseDate:       { type: Date, required: true },
    description:       { type: String, required: true, trim: true, maxlength: 2000 },

    // Itemized table of expenses
    items: {
        type:    [expenseItemSchema],
        default: []
    },

    // Declaration & Signature confirmation
    declarationAccepted: { type: Boolean, default: true },
    employeeSignature:   { type: String, trim: true, default: '' },

    // Multiple receipt uploads via Cloudinary
    receipts: {
        type:    [receiptAttachmentSchema],
        default: []
    },

    // Flexible status that tracks multi-level workflow
    status: {
        type:    String,
        enum:    ['Pending', 'L1 Approved', 'L2 Approved', 'Approved', 'Rejected', 'Reimbursed', 'Cancelled'],
        default: 'Pending'
    },

    // Which level of the workflow is currently awaiting action (1-indexed)
    currentLevel: { type: Number, default: 1 },

    // Snapshot reference to the ApprovalWorkflow used at submission time
    approvalWorkflow: {
        type: mongoose.Schema.Types.ObjectId,
        ref:  'ApprovalWorkflow',
        default: null
    },

    // Detailed trail of every approval/rejection action
    approvalTrail: {
        type:    [approvalTrailSchema],
        default: []
    },

    // Payment details filled by Finance when marking as Reimbursed
    paymentReference: { type: String, trim: true, default: '' },
    paymentDate:      { type: Date, default: null },
    paymentNote:      { type: String, trim: true, default: '' },

    // Audit log — same pattern as leaveRequest.model.js
    auditLog: {
        type:    [auditLogSchema],
        default: []
    }
}, { timestamps: true });

// Primary query patterns
reimbursementSchema.index({ companyId: 1, employee: 1, createdAt: -1 });
reimbursementSchema.index({ companyId: 1, status: 1, currentLevel: 1 });
reimbursementSchema.index({ companyId: 1, status: 1, createdAt: -1 });

reimbursementSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Reimbursement', reimbursementSchema);
