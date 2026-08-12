const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

const roleSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    permissions: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Permission'
    }],
    inheritsFrom: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Role'
    }],
    isSystem: {
        type: Boolean,
        default: false
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

// Ensure role names are unique
// Ensure role names are unique per company
roleSchema.index({ name: 1, companyId: 1 }, { unique: true });
roleSchema.index({ companyId: 1, isDeleted: 1 });
roleSchema.index({ companyId: 1, inheritsFrom: 1 });

roleSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Role', roleSchema);
