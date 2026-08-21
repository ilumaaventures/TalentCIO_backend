const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

/**
 * Configurable expense categories per tenant.
 * Mirrors the LeaveConfig pattern — validated in the controller,
 * not hardcoded on the Reimbursement document itself.
 */
const reimbursementCategorySchema = new mongoose.Schema({
    companyId: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Company',
        required: true,
        index:    true
    },
    name:        { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 200, default: '' },
    maxAmountPerClaim: { type: Number, default: null }, // null = unlimited
    isActive:    { type: Boolean, default: true },
    sortOrder:   { type: Number, default: 0 }
}, { timestamps: true });

reimbursementCategorySchema.index({ companyId: 1, name: 1 }, { unique: true, partialFilterExpression: { isDeleted: { $ne: true } } });
reimbursementCategorySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ReimbursementCategory', reimbursementCategorySchema);
