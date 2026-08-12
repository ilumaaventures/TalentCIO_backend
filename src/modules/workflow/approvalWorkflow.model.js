const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

const ApprovalWorkflowSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },

    // Levels of approval
    levels: [{
        levelCheck: { type: Number, required: true }, // 1, 2, 3...
        role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true },
        approvers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Multiple users
        isFinal: { type: Boolean, default: false }
    }],

    module: { type: String, enum: ['TA', 'Helpdesk'], default: 'TA' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }

}, { timestamps: true });
 
ApprovalWorkflowSchema.index({ name: 1, companyId: 1 }, { unique: true });

ApprovalWorkflowSchema.index({ companyId: 1, isDeleted: 1 });

ApprovalWorkflowSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ApprovalWorkflow', ApprovalWorkflowSchema);
