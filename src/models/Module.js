const mongoose = require('mongoose');

const moduleSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    project: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project',
        required: true
    },
    description: String,
    status: {
        type: String,
        enum: ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD'],
        default: 'PLANNED'
    },
    startDate: Date,
    dueDate: Date,
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    }
}, { timestamps: true });

// Performance Indexes
moduleSchema.index({ project: 1, companyId: 1 });

module.exports = mongoose.model('Module', moduleSchema);
