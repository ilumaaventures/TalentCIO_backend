const AttendanceDocument = require('../model/attendanceDocument.model');
const User = require('../../user/user.model');
const Role = require('../../user/role.model');
const NotificationService = require('../../../services/notificationService');
const { cloudinary } = require('../../../config/cloudinary');
const { extractPublicIdFromUrl } = require('../../../utils/cloudinaryHelper');

const getRoleNames = (user = {}) => (
    Array.isArray(user.roles)
        ? user.roles.map((role) => (typeof role === 'string' ? role : role?.name)).filter(Boolean)
        : []
);

const hasCompanyWideAttachmentViewAccess = (user = {}) => {
    const roleNames = getRoleNames(user);
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];

    return (
        roleNames.includes('Admin')
        || roleNames.includes('System Admin')
        || permissions.includes('*')
        || permissions.includes('admin')
        || permissions.includes('all')
        || permissions.includes('attendance.view')
        || permissions.includes('attendance.view_others')
        || permissions.includes('user.read')
    );
};

const hasAttachmentAdminAccess = (user = {}) => {
    const roleNames = getRoleNames(user);
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];

    return (
        roleNames.includes('Admin')
        || roleNames.includes('System Admin')
        || permissions.includes('*')
        || permissions.includes('admin')
        || permissions.includes('all')
        || user?.role === 'Admin'
    );
};

// @desc    Upload attendance attachment
// @route   POST /api/attendance/attachments/:userId/:month
// @access  Private (Self, Manager, Admin)
exports.uploadAttachment = async (req, res) => {
    try {
        const { userId, month } = req.params;
        const companyId = req.companyId;

        // Permission check
        const isSelf = req.user._id.toString() === userId;
        const isAdmin = hasAttachmentAdminAccess(req.user);
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
        const hasCompanyWideAccess = hasCompanyWideAttachmentViewAccess(req.user);
        const targetUser = await User.findById(userId);
        const isManager = targetUser?.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        if (!isSelf && !hasCompanyWideAccess && !isManager) {
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
        const isAdmin = hasAttachmentAdminAccess(req.user);

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

        if (file.status === 'Approved') {
            return res.status(403).json({ message: 'Cannot delete an approved document' });
        }

        if (file.status === 'Submitted' && !isAdmin) {
            return res.status(403).json({ message: 'Only admins can delete submitted documents' });
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
        const isAdmin = hasAttachmentAdminAccess(req.user);
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
        const isAdminUser = hasAttachmentAdminAccess(req.user);
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

        const io = req.app.get('io');
        const notifications = [];
        for (const managerId of notifyUsers) {
            if (managerId === req.user._id.toString()) continue;

            notifications.push({
                user: managerId,
                companyId,
                preferenceKey: 'attendance_document_submitted',
                title: 'Attendance Document Submitted',
                message: `${targetUser.firstName} ${targetUser.lastName} has submitted an attendance document for approval (${month}).`,
                type: 'Approval',
                link: `/attendance?tab=documents&userId=${userId}&month=${month}`
            });
        }

        if (notifications.length > 0) {
            await NotificationService.createManyNotifications(io, notifications);
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

        const isAdmin = hasAttachmentAdminAccess(req.user);
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
        const io = req.app.get('io');
        await NotificationService.createNotification(io, {
            user: userId,
            companyId,
            preferenceKey: 'attendance_document_status_updated',
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
