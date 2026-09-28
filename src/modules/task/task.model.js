const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

const taskSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    taskKey: {
        type: String,
        trim: true,
        index: true
    },
    key: {
        type: String,
        trim: true,
        index: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    module: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Module',
        required: true,
        index: true
    },
    assignees: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    reporter: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    parentTask: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Task',
        default: null,
        index: true
    },
    blockedBy: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Task'
    }],
    description: {
        type: String,
        default: ''
    },
    priority: {
        type: String,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'URGENT'],
        default: 'MEDIUM'
    },
    status: {
        type: String,
        enum: ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'BLOCKED'],
        default: 'TODO'
    },
    storyPoints: {
        type: Number,
        default: null,
        min: 0
    },
    labels: [{
        type: String,
        trim: true
    }],
    order: {
        type: Number,
        default: 0
    },
    reopenCount: {
        type: Number,
        default: 0
    },
    startDate: {
        type: Date,
        default: null
    },
    dueDate: {
        type: Date,
        default: null
    },
    estimatedHours: {
        type: Number,
        default: 0
    },
    completedAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

// Performance Indexes
taskSchema.index({ module: 1, companyId: 1, status: 1 });
taskSchema.index({ assignees: 1, companyId: 1, status: 1 });
taskSchema.index({ companyId: 1, isDeleted: 1 });
taskSchema.index({ companyId: 1, parentTask: 1 });
taskSchema.index({ companyId: 1, status: 1, order: 1 });
taskSchema.index({ companyId: 1, taskKey: 1 });
taskSchema.index({ companyId: 1, key: 1 });
taskSchema.index({ companyId: 1, dueDate: 1, status: 1 });

taskSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Task', taskSchema);
