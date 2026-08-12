const mongoose = require('mongoose');
const softDeletePlugin = require('../../../common/utils/softDeletePlugin');

const onboardingPolicyBinSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    originalId: { type: String, required: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    publicId: { type: String },
    isRequired: { type: Boolean, default: false }
}, { timestamps: true });

onboardingPolicyBinSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('OnboardingPolicyBin', onboardingPolicyBinSchema);
