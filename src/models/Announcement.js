const mongoose = require('mongoose');
const softDeletePlugin = require('../utils/softDeletePlugin');

const announcementReactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    type: {
        type: String,
        enum: ['like', 'celebrate', 'support'],
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

const announcementCommentSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    text: {
        type: String,
        required: true,
        trim: true,
        maxlength: 1200
    }
}, { timestamps: true });

const announcementAttachmentSchema = new mongoose.Schema({
    url: {
        type: String,
        trim: true,
        default: ''
    },
    name: {
        type: String,
        trim: true,
        default: ''
    },
    publicId: {
        type: String,
        trim: true,
        default: ''
    },
    resourceType: {
        type: String,
        enum: ['image', 'raw'],
        default: 'raw'
    },
    mimeType: {
        type: String,
        trim: true,
        default: ''
    },
    size: {
        type: Number,
        default: 0
    },
    uploadedAt: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

const announcementSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    title: {
        type: String,
        required: true,
        trim: true,
        maxlength: 160
    },
    summary: {
        type: String,
        trim: true,
        maxlength: 240,
        default: ''
    },
    content: {
        type: String,
        required: true,
        trim: true,
        maxlength: 8000
    },
    category: {
        type: String,
        enum: ['General', 'HR', 'Policy', 'Product', 'Celebration', 'Alert'],
        default: 'General'
    },
    status: {
        type: String,
        enum: ['draft', 'published'],
        default: 'draft'
    },
    pinned: {
        type: Boolean,
        default: false
    },
    audienceType: {
        type: String,
        enum: ['all', 'departments', 'employmentTypes', 'specificUsers'],
        default: 'all'
    },
    audienceDepartments: [{
        type: String,
        trim: true
    }],
    audienceEmploymentTypes: [{
        type: String,
        trim: true
    }],
    audienceUserIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    publishedAt: {
        type: Date,
        default: null
    },
    expiresAt: {
        type: Date,
        default: null
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    attachment: {
        type: announcementAttachmentSchema,
        default: null
    },
    reactions: {
        type: [announcementReactionSchema],
        default: []
    },
    comments: {
        type: [announcementCommentSchema],
        default: []
    }
}, { timestamps: true });

announcementSchema.index({ companyId: 1, status: 1, pinned: -1, publishedAt: -1, createdAt: -1 });
announcementSchema.index({ companyId: 1, audienceType: 1, expiresAt: 1, isDeleted: 1 });
announcementSchema.index({ 'comments.userId': 1 });
announcementSchema.index({ 'reactions.userId': 1 });

announcementSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Announcement', announcementSchema);
