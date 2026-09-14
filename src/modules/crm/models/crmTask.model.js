const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  dueDate: { type: Date, required: true, index: true },
  priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  status: { type: String, enum: ['Pending', 'In Progress', 'Completed', 'Cancelled'], default: 'Pending', index: true },
  category: { type: String, enum: ['Call', 'Email', 'Meeting', 'Review', 'Demo', 'Follow-up', 'Preparation', 'Other'], default: 'Follow-up' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Related Entity
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmLead', index: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmContact', index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmAccount', index: true },
  dealId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrmDeal', index: true },

  completedAt: { type: Date },
}, { timestamps: true });

taskSchema.index({ companyId: 1, assignedTo: 1, status: 1 });

module.exports = mongoose.model('CrmTask', taskSchema);
