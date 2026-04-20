const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    text: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const helpdeskQuerySchema = new mongoose.Schema({
    queryId: {
        type: String,
        unique: true,
        required: true
    },
    subject: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        required: true
    },
    queryType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'QueryType',
        required: true
    },
    priority: {
        type: String,
        enum: ['Low', 'Medium', 'High', 'Urgent'],
        default: 'Medium'
    },
    status: {
        type: String,
        enum: ['New', 'In Progress', 'Resolved', 'Closed', 'Escalated', 'Pending'],
        default: 'New'
    },
    raisedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    originalAssignee: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    comments: [commentSchema],
    escalatedAt: {
        type: Date
    },
    resolvedAt: {
        type: Date
    },
    closedAt: {
        type: Date
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    }
}, {
    timestamps: true
});

// Indexes for performance
helpdeskQuerySchema.index({ status: 1, createdAt: 1 });
helpdeskQuerySchema.index({ companyId: 1, status: 1, createdAt: -1 });
helpdeskQuerySchema.index({ raisedBy: 1, companyId: 1, createdAt: -1 });
helpdeskQuerySchema.index({ assignedTo: 1, companyId: 1, status: 1 });

// Pre-save hook to generate robust queryId
helpdeskQuerySchema.pre('validate', async function () {
    if (this.isNew && !this.queryId) {
        // format: HD-DATE-RANDOM
        // Date segment: last 6 digits of timestamp
        // Random segment: 3 chars
        const dateSegment = Date.now().toString().slice(-6);
        const randomSegment = Math.random().toString(36).substring(2, 5).toUpperCase();
        this.queryId = `HD-${dateSegment}-${randomSegment}`;
    }
});

module.exports = mongoose.model('HelpdeskQuery', helpdeskQuerySchema);
