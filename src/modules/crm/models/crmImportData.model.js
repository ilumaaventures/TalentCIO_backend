const mongoose = require('mongoose');
const softDeletePlugin = require('../../../common/utils/softDeletePlugin');

const crmImportDataSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    rowId: { type: String, trim: true, index: true },
    sNo: { type: String, trim: true, default: '' },
    companyName: { type: String, trim: true, default: '' },
    industry: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    rating: { type: String, trim: true, default: '' },
    contactPerson: { type: String, trim: true, default: '' },
    designation: { type: String, trim: true, default: '' },
    mobileNo: { type: String, trim: true, default: '' },
    emailId: { type: String, trim: true, default: '' },
    remarks: { type: String, trim: true, default: '' },
    date: { type: String, default: () => new Date().toISOString() },
    // Status value (Interested, Not Interested, New, etc.)
    status: { type: String, trim: true, default: 'New' },
    leadStatus: { type: String, trim: true, default: 'New' },
    // Source column from Excel (LinkedIn, Cold Call, Referral, etc.)
    leadSource: { type: String, trim: true, default: '' },
    isConvertedToLead: { type: Boolean, default: false },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmLead', default: null },
    isDuplicate: { type: Boolean, default: false },
    duplicateReason: { type: String, default: '' },
    importedBy: { type: String, trim: true, default: '' },
    importedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    source: { type: String, default: 'Excel Import' }, // internal: always 'Excel Import'

    // User Outreach & Performance Tracking
    callCount: { type: Number, default: 0 },
    whatsappCount: { type: Number, default: 0 },
    emailCount: { type: Number, default: 0 },
    lastContactedAt: { type: Date, default: null },
    lastContactedBy: { type: String, trim: true, default: '' },
    lastContactedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastOutcome: { type: String, trim: true, default: '' },
    lastCallType: { type: String, trim: true, default: '' },
    nextFollowUpAt: { type: Date, default: null },
  },
  { timestamps: true }
);

crmImportDataSchema.index({ companyId: 1, isDeleted: 1 });
crmImportDataSchema.index({ companyId: 1, rowId: 1 });
// Compound content-key index: prevents duplicate DB documents when the same
// company is re-imported with a different rowId (e.g., across separate uploads).
crmImportDataSchema.index(
  { companyId: 1, companyName: 1, mobileNo: 1, emailId: 1 },
  { sparse: true, background: true }
);


crmImportDataSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CrmImportData', crmImportDataSchema);
