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
    isConvertedToLead: { type: Boolean, default: false },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmLead', default: null },
    isDuplicate: { type: Boolean, default: false },
    duplicateReason: { type: String, default: '' },
    importedBy: { type: String, trim: true, default: '' },
    importedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    source: { type: String, default: 'Excel Import' },
  },
  { timestamps: true }
);

crmImportDataSchema.index({ companyId: 1, isDeleted: 1 });
crmImportDataSchema.index({ companyId: 1, rowId: 1 });

crmImportDataSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CrmImportData', crmImportDataSchema);
