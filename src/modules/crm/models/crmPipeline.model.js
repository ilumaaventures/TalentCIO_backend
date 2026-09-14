const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema({
  name: { type: String, required: true },
  probability: { type: Number, required: true, min: 0, max: 100 },
  color: { type: String, default: '#6366f1' },
  order: { type: Number, required: true },
  isWon: { type: Boolean, default: false },
  isLost: { type: Boolean, default: false },
});

const pipelineSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true },
  isDefault: { type: Boolean, default: false },
  stages: [stageSchema],
}, { timestamps: true });

pipelineSchema.index({ companyId: 1, isDefault: 1 });

module.exports = mongoose.model('CrmPipeline', pipelineSchema);
