const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

const taskCommentSchema = new mongoose.Schema({
    task: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Task',
        required: true,
        index: true
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    message: {
        type: String,
        required: true,
        trim: true
    },
    mentions: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    attachments: [{
        name: { type: String, trim: true },
        url: { type: String, trim: true },
        fileType: { type: String, trim: true },
        size: { type: Number, default: 0 }
    }],
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    }
}, { timestamps: true });

taskCommentSchema.index({ task: 1, createdAt: -1 });
taskCommentSchema.index({ companyId: 1, isDeleted: 1 });

taskCommentSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('TaskComment', taskCommentSchema);
