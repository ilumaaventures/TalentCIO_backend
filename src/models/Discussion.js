const mongoose = require('mongoose');

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
        enum: ['inprogress', 'on-hold', 'mark as complete'],
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
    supervisor: {
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

discussionSchema.index({ supervisor: 1, companyId: 1, createdAt: -1 });

module.exports = mongoose.model('Discussion', discussionSchema);
