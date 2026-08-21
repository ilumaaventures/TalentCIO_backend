const mongoose = require('mongoose');

/**
 * Validates whether a model has a case-insensitive duplicate field for the same company.
 * 
 * @param {mongoose.Model} Model 
 * @param {Object} params
 * @param {mongoose.Types.ObjectId} params.companyId
 * @param {string} params.field - Field name to check (e.g. 'name', 'title')
 * @param {string} params.value - Value to check
 * @param {mongoose.Types.ObjectId} [params.excludeId] - ID to exclude (during updates)
 * @returns {Promise<boolean>} - True if a duplicate exists
 */
const isDuplicateCaseInsensitive = async (Model, { companyId, field, value, excludeId = null }) => {
    if (!value || !companyId) return false;

    const trimmedValue = String(value).trim();
    const query = {
        companyId,
        isDeleted: false,
        [field]: { $regex: new RegExp(`^${trimmedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    };

    if (excludeId) {
        query._id = { $ne: excludeId };
    }

    const existing = await Model.findOne(query).select('_id').lean();
    return Boolean(existing);
};

module.exports = {
    isDuplicateCaseInsensitive
};
