const mongoose = require('mongoose');
const softDeletePlugin = require('../utils/softDeletePlugin');

const queryTypeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    assignedRole: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
    assignedPerson: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    enableEscalation: { type: Boolean, default: false },
    escalationDays: { type: Number, default: 2 },
    escalationRole: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
    escalationPerson: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
    autoResponse: { type: String, default: "" }
}, { timestamps: true });
 
queryTypeSchema.index({ name: 1, companyId: 1 }, { unique: true });

queryTypeSchema.index({ companyId: 1, isDeleted: 1 });

queryTypeSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('QueryType', queryTypeSchema);
