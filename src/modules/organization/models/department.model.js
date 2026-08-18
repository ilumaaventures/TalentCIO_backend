const mongoose = require('mongoose');
const softDeletePlugin = require('../../../common/utils/softDeletePlugin');

const departmentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    code: {
        type: String,
        trim: true,
        uppercase: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    parentDepartment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Department',
        default: null
    },
    businessUnit: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'BusinessUnit',
        default: null
    },
    head: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
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

departmentSchema.index({ companyId: 1, isDeleted: 1 });
departmentSchema.index({ companyId: 1, parentDepartment: 1 });
departmentSchema.index({ companyId: 1, businessUnit: 1 });

departmentSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Department', departmentSchema);
