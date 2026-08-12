const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

const projectSchema = new mongoose.Schema({
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
    client: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Client'
    },
    manager: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    members: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],

    description: String,
    isActive: {
        type: Boolean,
        default: true
    },
    status: {
        type: String,
        enum: ['Active', 'On Hold', 'Completed', 'Inactive'],
        default: 'Active'
    },
    startDate: Date,
    dueDate: Date
}, { timestamps: true });

// Performance Indexes
projectSchema.index({ companyId: 1, isActive: 1 });
projectSchema.index({ companyId: 1, status: 1 });
projectSchema.index({ companyId: 1, isDeleted: 1 });

projectSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Project', projectSchema);
