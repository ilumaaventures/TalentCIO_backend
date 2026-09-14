const mongoose = require('mongoose');

const workflowActionSchema = new mongoose.Schema({
  actionType: {
    type: String,
    enum: ['create_task', 'send_email', 'send_whatsapp', 'assign_user', 'change_status', 'add_tag', 'notify_manager'],
    required: true,
  },
  params: { type: Map, of: mongoose.Schema.Types.Mixed },
});

const workflowSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  description: { type: String },
  triggerEvent: {
    type: String,
    enum: [
      'lead_created',
      'lead_qualified',
      'deal_created',
      'deal_stage_changed',
      'deal_won',
      'followup_overdue',
      'lead_inactive_14d'
    ],
    required: true,
  },
  conditions: [
    {
      field: String,
      operator: { type: String, enum: ['equals', 'not_equals', 'greater_than', 'less_than', 'contains'] },
      value: String,
    }
  ],
  actions: [workflowActionSchema],
  isActive: { type: Boolean, default: true },
  executionCount: { type: Number, default: 0 },
  lastTriggeredAt: { type: Date },
}, { timestamps: true });

workflowSchema.index({ companyId: 1, triggerEvent: 1, isActive: 1 });

module.exports = mongoose.model('CrmWorkflow', workflowSchema);
