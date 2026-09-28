const mongoose = require('mongoose');

const taskActivitySchema = new mongoose.Schema({
    task: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Task',
        required: true,
        index: true
    },
    field: {
        type: String,
        required: true
    },
    oldValue: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    newValue: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    changedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    }
}, { timestamps: true });

taskActivitySchema.index({ task: 1, createdAt: -1 });
taskActivitySchema.index({ companyId: 1, task: 1, createdAt: -1 });
taskActivitySchema.index({ changedBy: 1, createdAt: -1 });
taskActivitySchema.index({ companyId: 1, field: 1, createdAt: -1 });

module.exports = mongoose.model('TaskActivity', taskActivitySchema);
