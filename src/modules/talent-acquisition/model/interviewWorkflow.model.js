const mongoose = require('mongoose');
const softDeletePlugin = require('../../../common/utils/softDeletePlugin');

const InterviewWorkflowSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },

    // Levels of interview rounds
    rounds: [{
        levelCheck: { type: Number, required: true }, // 1, 2, 3...
        levelName: { type: String, required: true }, // e.g., 'L1 - Technical', 'HR Round'
        role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' }, // Optional recommended role for evaluators
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Optional designated individual evaluator
        emailTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailTemplate', default: null },
        emailAccountId: { type: String, trim: true, default: null },
        cc: { type: String, trim: true, default: '' },
        bcc: { type: String, trim: true, default: '' },
        customFields: [{
            key: { type: String, trim: true },
            value: { type: String, trim: true }
        }]
    }],

    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }

}, { timestamps: true });
 
InterviewWorkflowSchema.index({ name: 1, companyId: 1 }, { unique: true });

InterviewWorkflowSchema.index({ companyId: 1, isDeleted: 1 });

InterviewWorkflowSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('InterviewWorkflow', InterviewWorkflowSchema);
