const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
    action: { type: String, required: true }, // e.g. 'COMPANY_CREATED', 'MODULE_TOGGLED'
    entity: { type: String, default: '' },     // e.g. 'Company', 'User', 'Module'
    entityId: { type: mongoose.Schema.Types.ObjectId },
    performedBy: {
        id: { type: mongoose.Schema.Types.ObjectId },
        name: { type: String },
        email: { type: String },
    },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
