const mongoose = require('mongoose');

const candidateSourceSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

// Ensure unique source name per company
candidateSourceSchema.index({ companyId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('CandidateSource', candidateSourceSchema);
