const AttendanceDocument = require('../models/AttendanceDocument');
const User = require('../models/User');
const Role = require('../models/Role');
const Notification = require('../models/Notification');
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

        if (file.status === 'Approved' || file.status === 'Submitted') {
            return res.status(403).json({ message: 'Cannot delete a submitted or approved document' });
        }

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

// @desc    Replace a rejected attachment
// @route   PUT /api/attendance/attachments/:userId/:month/:fileId/replace
// @access  Private (Self, Manager, Admin)
exports.replaceAttachment = async (req, res) => {
    try {
        const { userId, month, fileId } = req.params;
        const companyId = req.companyId;

        // Permission check
        const isSelf = req.user._id.toString() === userId;
        const isAdmin = req.user.roles?.some(r => r.name === 'Admin' || r === 'Admin') || req.user.permissions?.includes('*');
        const targetUser = await User.findById(userId);
        const isManager = targetUser?.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        if (!isSelf && !isAdmin && !isManager) {
            return res.status(403).json({ message: 'Not authorized to replace attachments for this user' });
        }

        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

        const doc = await AttendanceDocument.findOne({ user: userId, companyId, month });
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        const file = doc.files.id(fileId);
        if (!file) return res.status(404).json({ message: 'File not found' });

        if (file.status === 'Approved' || file.status === 'Submitted') {
            return res.status(403).json({ message: 'Cannot replace a submitted or approved document' });
        }

        // Delete old from Cloudinary
        if (file.publicId) {
            try {
                await cloudinary.uploader.destroy(file.publicId);
            } catch (cloudErr) {
                console.error('Cloudinary delete error:', cloudErr);
            }
        }

        // Replace metadata
        file.url = req.file.path;
        file.name = req.file.originalname;
        file.publicId = req.file.filename;
        file.uploadedAt = new Date();
        file.status = 'Pending';
        file.rejectionReason = undefined;

        await doc.save();
        res.json(doc);
    } catch (error) {
        console.error('replaceAttachment error:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// @desc    Submit attachment for approval
// @route   PUT /api/attendance/attachments/:userId/:month/:fileId/submit
// @access  Private (Self)
exports.submitAttachmentForApproval = async (req, res) => {
    try {
        const { userId, month, fileId } = req.params;
        const companyId = req.companyId;

        // Permission check: Self, or Admin/Manager (consistent with upload)
        const isSelf = req.user._id.toString() === userId;
        const isAdminUser = req.user.roles?.some(r => r.name === 'Admin' || r === 'Admin') || req.user.permissions?.includes('*');
        const targetUser = await User.findById(userId).populate('reportingManagers');
        const isManager = targetUser?.reportingManagers?.some(m => {
            const mId = m._id ? m._id.toString() : m.toString();
            return mId === req.user._id.toString();
        });

        if (!isSelf && !isAdminUser && !isManager) {
            return res.status(403).json({ message: 'Not authorized to submit this attachment' });
        }

        const doc = await AttendanceDocument.findOne({ user: userId, companyId, month });
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        const file = doc.files.id(fileId);
        if (!file) return res.status(404).json({ message: 'File not found' });

        if (file.status === 'Approved') {
            return res.status(400).json({ message: 'Already approved' });
        }

        file.status = 'Submitted';
        file.rejectionReason = undefined; // Clear reason on resubmission
        await doc.save();

        // Notify managers and admins
        const adminRole = await Role.findOne({ name: 'Admin', companyId });
        const adminQuery = { companyId, isActive: true };
        if (adminRole) {
            adminQuery.roles = adminRole._id;
        }

        // Only search for admins if we have a companyId filter to avoid leakage
        const admins = companyId ? await User.find(adminQuery) : [];

        const notifyUsers = new Set();
        if (targetUser && targetUser.reportingManagers) {
            targetUser.reportingManagers.forEach(m => {
                const id = m && (m._id ? m._id.toString() : m.toString());
                if (id) notifyUsers.add(id);
            });
        }
        admins.forEach(a => {
            if (a && a._id) notifyUsers.add(a._id.toString());
        });

        for (const managerId of notifyUsers) {
            // Don't notify the person who performed the action if they are a manager/admin
            if (managerId === req.user._id.toString()) continue;

            await Notification.create({
                user: managerId,
                companyId,
                title: 'Attendance Document Submitted',
                message: `${targetUser.firstName} ${targetUser.lastName} has submitted an attendance document for approval (${month}).`,
                type: 'Approval',
                link: `/attendance?tab=documents&userId=${userId}&month=${month}`
            });
        }

        res.json(file);
    } catch (error) {
        console.error('submitAttachment error:', error);
        res.status(500).json({ message: 'Server error: ' + error.message });
    }
};

// @desc    Approve/Reject attachment
// @route   PUT /api/attendance/attachments/:userId/:month/:fileId/review
// @access  Private (Manager, Admin)
exports.reviewAttachment = async (req, res) => {
    try {
        const { userId, month, fileId } = req.params;
        const { status, reason } = req.body; // status: 'Approved' or 'Rejected'
        const companyId = req.companyId;

        const isAdmin = req.user.roles?.some(r => r.name === 'Admin' || r === 'Admin') || req.user.permissions?.includes('*');
        const targetUser = await User.findById(userId);
        const isManager = targetUser?.reportingManagers?.some(m => {
            const mId = m._id ? m._id.toString() : m.toString();
            return mId === req.user._id.toString();
        });

        if (!isAdmin && !isManager) {
            return res.status(403).json({ message: 'Not authorized to review attachments' });
        }

        if (!['Approved', 'Rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const doc = await AttendanceDocument.findOne({ user: userId, companyId, month });
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        const file = doc.files.id(fileId);
        if (!file) return res.status(404).json({ message: 'File not found' });

        file.status = status;
        if (status === 'Rejected') {
            file.rejectionReason = reason;
        } else {
            file.rejectionReason = undefined;
        }

        await doc.save();

        // Notify User
        await Notification.create({
            user: userId,
            companyId,
            title: `Attendance Document ${status}`,
            message: `Your uploaded attendance document for ${month} has been ${status.toLowerCase()}. ${reason ? 'Reason: ' + reason : ''}`,
            type: 'Approval',
            link: `/attendance?tab=documents&month=${month}`
        });

        res.json(file);
    } catch (error) {
        console.error('reviewAttachment error:', error);
        res.status(500).json({ message: 'Server error' });
    }
};
