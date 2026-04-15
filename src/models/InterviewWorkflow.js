const mongoose = require('mongoose');

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
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } // Optional designated individual evaluator
    }],

    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }

}, { timestamps: true });
 
InterviewWorkflowSchema.index({ name: 1, companyId: 1 }, { unique: true });

module.exports = mongoose.model('InterviewWorkflow', InterviewWorkflowSchema);
