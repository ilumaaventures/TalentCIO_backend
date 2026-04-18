const AttendanceDocument = require('../models/AttendanceDocument');
const User = require('../models/User');
const { cloudinary } = require('../config/cloudinary');
const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');

// @desc    Upload attendance attachment
// @route   POST /api/attendance/attachments/:userId/:month
// @access  Private (Self, Manager, Admin)
exports.uploadAttachment = async (req, res) => {
    try {
        const { userId, month } = req.params;
        const companyId = req.companyId;

        // Permission check
        const isSelf = req.user._id.toString() === userId;
        const isAdmin = req.user.roles?.some(r => r.name === 'Admin' || r === 'Admin') || req.user.permissions?.includes('*');
        const targetUser = await User.findById(userId);
        const isManager = targetUser?.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        if (!isSelf && !isAdmin && !isManager) {
            return res.status(403).json({ message: 'Not authorized to upload attachments for this user' });
        }

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        let doc = await AttendanceDocument.findOne({ user: userId, companyId, month });

        const fileData = {
            url: req.file.path,
            name: req.file.originalname,
            publicId: req.file.filename, // Multer-storage-cloudinary usually puts public_id in filename
            uploadedAt: new Date()
        };

        if (doc) {
            doc.files.push(fileData);
            await doc.save();
        } else {
            doc = new AttendanceDocument({
                user: userId,
                companyId,
                month,
                files: [fileData]
            });
            await doc.save();
        }

        res.status(201).json(doc);
    } catch (error) {
        console.error('uploadAttachment error:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// @desc    Get attendance attachments for a month
// @route   GET /api/attendance/attachments/:userId/:month
// @access  Private (Self, Manager, Admin)
exports.getAttachments = async (req, res) => {
    try {
        const { userId, month } = req.params;
        const companyId = req.companyId;

        // Permission check
        const isSelf = req.user._id.toString() === userId;
        const isAdmin = req.user.roles?.some(r => r.name === 'Admin' || r === 'Admin') || req.user.permissions?.includes('*');
        const targetUser = await User.findById(userId);
        const isManager = targetUser?.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        if (!isSelf && !isAdmin && !isManager) {
            return res.status(403).json({ message: 'Not authorized to view these attachments' });
        }

        const doc = await AttendanceDocument.findOne({ user: userId, companyId, month });
        res.json(doc || { files: [] });
    } catch (error) {
        console.error('getAttachments error:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// @desc    Delete attendance attachment
// @route   DELETE /api/attendance/attachments/:userId/:month/:fileId
// @access  Private (Self, Admin)
exports.deleteAttachment = async (req, res) => {
    try {
        const { userId, month, fileId } = req.params;
        const companyId = req.companyId;

        // Permission check: Only self or admin can delete
        const isSelf = req.user._id.toString() === userId;
        const isAdmin = req.user.roles?.some(r => r.name === 'Admin' || r === 'Admin') || req.user.permissions?.includes('*');

        if (!isSelf && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized to delete this attachment' });
        }

        const doc = await AttendanceDocument.findOne({ user: userId, companyId, month });
        if (!doc) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const fileIndex = doc.files.findIndex(f => f._id.toString() === fileId);
        if (fileIndex === -1) {
            return res.status(404).json({ message: 'File not found' });
        }

        const file = doc.files[fileIndex];

        // Delete from Cloudinary
        if (file.publicId) {
            try {
                await cloudinary.uploader.destroy(file.publicId);
            } catch (cloudErr) {
                console.error('Cloudinary delete error:', cloudErr);
                // Continue even if cloud deletion fails
            }
        }

        doc.files.splice(fileIndex, 1);
        await doc.save();

        res.json(doc);
    } catch (error) {
        console.error('deleteAttachment error:', error);
        res.status(500).json({ message: 'Server error' });
    }
};
