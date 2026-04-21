const mongoose = require('mongoose');

const attendanceDocumentSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    month: {
        type: String, // format YYYY-MM
        required: true,
        index: true
    },
    files: [{
        url: {
            type: String,
            required: true
        },
        name: {
            type: String,
            required: true
        },
        publicId: String, // Cloudinary public_id for easy deletion
        uploadedAt: {
            type: Date,
            default: Date.now
        },
        status: {
            type: String,
            enum: ['Pending', 'Submitted', 'Approved', 'Rejected'],
            default: 'Pending'
        },
        rejectionReason: {
            type: String
        }
    }],
    remarks: String
}, { timestamps: true });

// Ensure uniqueness per user+month+company
attendanceDocumentSchema.index({ user: 1, companyId: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('AttendanceDocument', attendanceDocumentSchema);
