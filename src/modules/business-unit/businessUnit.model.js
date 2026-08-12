const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

const businessUnitSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    headOfUnit: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    description: String
}, { timestamps: true });

businessUnitSchema.index({ companyId: 1, isDeleted: 1 });

businessUnitSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('BusinessUnit', businessUnitSchema);
