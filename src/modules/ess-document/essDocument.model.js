const mongoose = require('mongoose');
const softDeletePlugin = require('../../common/utils/softDeletePlugin');

/**
 * Exactly mirrors announcementAttachmentSchema from announcement.model.js.
 * Reused here so the same Cloudinary storage and client-side preview logic works.
 */
const essDocumentFileSchema = new mongoose.Schema({
    url:          { type: String, trim: true, default: '' },
    name:         { type: String, trim: true, default: '' },
    publicId:     { type: String, trim: true, default: '' },
    resourceType: { type: String, enum: ['image', 'raw'], default: 'raw' },
    mimeType:     { type: String, trim: true, default: '' },
    size:         { type: Number, default: 0 },
    uploadedAt:   { type: Date, default: Date.now }
}, { _id: false });

/**
 * Mirrors announcementAcknowledgementSchema — per-employee read tracking.
 */
const acknowledgementSchema = new mongoose.Schema({
    userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    acknowledgedAt: { type: Date, default: Date.now }
}, { _id: false });

/**
 * Visibility control: 'All' = whole company, 'Department' = target departments,
 * 'Custom' = hand-picked specific users.
 */
const visibilitySchema = new mongoose.Schema({
    type:              { type: String, enum: ['All', 'Department', 'Custom'], default: 'All' },
    targetDepartments: [{ type: String, trim: true }],
    targetUserIds:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { _id: false });

const essDocumentSchema = new mongoose.Schema({
    companyId: {
        type:     mongoose.Schema.Types.ObjectId,
        ref:      'Company',
        required: true,
        index:    true
    },
    title: {
        type:      String,
        required:  true,
        trim:      true,
        maxlength: 160
    },
    description: {
        type:      String,
        trim:      true,
        maxlength: 1000,
        default:   ''
    },
    category: {
        type:    String,
        enum:    ['Policy', 'Form', 'Circular', 'Other'],
        default: 'Other'
    },
    file:       { type: essDocumentFileSchema, default: null },
    visibility: { type: visibilitySchema, default: () => ({ type: 'All' }) },

    requiresAcknowledgement: { type: Boolean, default: false },
    acknowledgements: {
        type:    [acknowledgementSchema],
        default: []
    },

    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isActive:   { type: Boolean, default: true }
}, { timestamps: true });

essDocumentSchema.index({ companyId: 1, category: 1, isActive: 1, isDeleted: 1 });
essDocumentSchema.index({ companyId: 1, isActive: 1, createdAt: -1 });
essDocumentSchema.index({ 'acknowledgements.userId': 1 });

essDocumentSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('EssDocument', essDocumentSchema);
