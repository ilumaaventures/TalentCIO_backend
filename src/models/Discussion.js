const mongoose = require('mongoose');
const softDeletePlugin = require('../utils/softDeletePlugin');

const discussionSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    discussion: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['inprogress', 'on-hold', 'mark as complete', 'planning'],
        default: 'inprogress'
    },
    dueDate: {
        type: Date
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    supervisor: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }],
    visibleToUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    participants: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    project: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project',
        default: null
    }
}, { timestamps: true });

discussionSchema.index({ supervisor: 1, companyId: 1, createdAt: -1 });
discussionSchema.index({ visibleToUsers: 1, companyId: 1, createdAt: -1 });
discussionSchema.index({ participants: 1, companyId: 1, createdAt: -1 });
discussionSchema.index({ companyId: 1, isDeleted: 1 });

discussionSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Discussion', discussionSchema);
