const mongoose = require('mongoose');
const softDeletePlugin = require('../../../common/utils/softDeletePlugin');

const designationSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    department: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Department',
        default: null
    },
    level: {
        type: String,
        trim: true,
        default: ''
    },
    description: {
        type: String,
        trim: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

designationSchema.index({ companyId: 1, isDeleted: 1 });
designationSchema.index({ companyId: 1, department: 1 });

designationSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Designation', designationSchema);
