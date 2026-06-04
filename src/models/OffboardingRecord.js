const mongoose = require('mongoose');
const softDeletePlugin = require('../utils/softDeletePlugin');

const clearanceSchema = new mongoose.Schema({
    it: { type: Boolean, default: false },
    finance: { type: Boolean, default: false },
    hr: { type: Boolean, default: false },
    admin: { type: Boolean, default: false },
    manager: { type: Boolean, default: false },
    completedAt: { type: Date, default: null }
}, { _id: false });

const fnfDetailsSchema = new mongoose.Schema({
    basicSalaryDue: { type: Number, default: 0 },
    leaveEncashment: { type: Number, default: 0 },
    bonusDue: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    netPayable: { type: Number, default: 0 },
    settledAt: { type: Date, default: null },
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { _id: false });

const documentIssuedSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['Relieving Letter', 'Experience Letter', 'Full & Final Settlement', 'NOC', 'Payslip Bundle', 'Other'],
        required: true
    },
    sentAt: { type: Date, default: null },
    sentTo: { type: String, default: '' },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    emailAccountId: { type: String, default: '' },
    emailAccountLabel: { type: String, default: '' },
    emailTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailTemplate', default: null },
    emailTemplateName: { type: String, default: '' },
    emailSubject: { type: String, default: '' },
    cloudinaryUrl: { type: String, default: '' },
    profileDocumentCategory: { type: String, default: '' },
    profileDocumentTitle: { type: String, default: '' },
    notes: { type: String, default: '' }
}, { _id: false });

const offboardingRecordSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true
    },
    exitType: {
        type: String,
        enum: ['Resignation', 'Termination', 'Retirement', 'End of Contract', 'Mutual Separation', 'Absconding'],
        required: true
    },
    status: {
        type: String,
        enum: ['Initiated', 'In Progress', 'Clearance Pending', 'Completed'],
        default: 'Initiated'
    },
    initiatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    initiatedAt: {
        type: Date,
        default: Date.now
    },
    lastWorkingDay: {
        type: Date,
        required: true
    },
    noticePeriodServed: {
        type: Boolean,
        default: false
    },
    exitInterviewDone: {
        type: Boolean,
        default: false
    },
    exitInterviewNotes: {
        type: String,
        default: ''
    },
    clearance: {
        type: clearanceSchema,
        default: () => ({})
    },
    fnfDetails: {
        type: fnfDetailsSchema,
        default: () => ({})
    },
    documentsIssued: {
        type: [documentIssuedSchema],
        default: []
    },
    hrRemarks: {
        type: String,
        default: ''
    },
    isActive: {
        type: Boolean,
        default: true
    },
    completedAt: {
        type: Date,
        default: null
    },
    completedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, { timestamps: true });

offboardingRecordSchema.index({ companyId: 1 });
offboardingRecordSchema.index({ userId: 1 });
offboardingRecordSchema.index({ status: 1 });
offboardingRecordSchema.index({ lastWorkingDay: 1 });

offboardingRecordSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('OffboardingRecord', offboardingRecordSchema);
