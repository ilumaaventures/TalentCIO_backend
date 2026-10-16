const mongoose = require('mongoose');
const softDeletePlugin = require('../../../common/utils/softDeletePlugin');

const crmExcelFileSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    fileName: { type: String, required: true, trim: true },
    fileSize: { type: String, default: '' },
    fileSizeBytes: { type: Number, default: 0 },
    totalRowsFetched: { type: Number, default: 0 },
    totalCompanies: { type: Number, default: 0 },
    newCount: { type: Number, default: 0 },
    updateCount: { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    importedBy: { type: String, trim: true, default: '' },
    importedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['Completed', 'Imported', 'Partial'], default: 'Imported' },
    importMode: { type: String, default: 'all' },
    fileData: { type: String, default: '' }, // base64 or DataURL string for downloading
  },
  { timestamps: true }
);

crmExcelFileSchema.index({ companyId: 1, isDeleted: 1 });
crmExcelFileSchema.index({ companyId: 1, createdAt: -1 });

crmExcelFileSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CrmExcelFile', crmExcelFileSchema);
