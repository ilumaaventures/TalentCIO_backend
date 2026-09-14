const mongoose = require('mongoose');

const customFieldSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  entityType: {
    type: String,
    enum: ['lead', 'contact', 'account', 'deal', 'activity'],
    required: true,
  },
  fieldName: { type: String, required: true },
  fieldKey: { type: String, required: true },
  fieldType: {
    type: String,
    enum: ['text', 'number', 'currency', 'date', 'select', 'multiselect', 'checkbox', 'url', 'email', 'phone'],
    default: 'text',
  },
  options: [{ type: String }],
  isRequired: { type: Boolean, default: false },
  defaultValue: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

customFieldSchema.index({ companyId: 1, entityType: 1, fieldKey: 1 }, { unique: true });

module.exports = mongoose.model('CrmCustomField', customFieldSchema);
