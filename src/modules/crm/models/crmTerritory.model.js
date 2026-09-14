const mongoose = require('mongoose');

const territorySchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  name: { type: String, required: true, trim: true },
  leadRep: { type: String, trim: true, default: 'Unassigned' },
  regions: { type: String, trim: true, default: '' },
}, { timestamps: true });

territorySchema.index({ companyId: 1, name: 1 });

module.exports = mongoose.model('CrmTerritory', territorySchema);
