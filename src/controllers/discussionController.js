const Discussion = require('../models/Discussion');
const User = require('../models/User');
const Notification = require('../models/Notification');
const mongoose = require('mongoose');
const {
    attachDiscussionPermissions,
    buildAccessibleDiscussionMatch,
    buildDiscussionParticipants,
    canAccessDiscussion,
    canChangeRestrictedDiscussionStatus,
    canDeleteDiscussion,
    canEditDiscussion
} = require('../utils/discussionAccess');

const setPrivateCache = (res, maxAgeSeconds = 30) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`);
};

exports.createDiscussion = async (req, res) => {
    try {
        const { title, discussion, status, dueDate, supervisor, visibleToUserIds = [], participantUserId } = req.body;
        const selectedSupervisorId = supervisor || participantUserId;
        const normalizedVisibleTo = Array.isArray(visibleToUserIds)
            ? visibleToUserIds
            : (visibleToUserIds ? [visibleToUserIds] : []);

        if (!selectedSupervisorId) {
            return res.status(400).json({ message: 'Supervisor is required' });
        }

        if (!normalizedVisibleTo.length) {
            return res.status(400).json({ message: 'At least one visible user is required' });
        }
        const newDiscussion = new Discussion({
            companyId: req.companyId,
            title,
            discussion,
            status: status || 'inprogress',
            dueDate,
            createdBy: req.user._id,
            supervisor: selectedSupervisorId,
            visibleToUsers: normalizedVisibleTo,
            participants: buildDiscussionParticipants(req.user._id, selectedSupervisorId, normalizedVisibleTo)
        });
        await newDiscussion.save();

        const recipients = buildDiscussionParticipants(selectedSupervisorId, normalizedVisibleTo)
            .filter((userId) => String(userId) !== String(req.user._id));

        if (recipients.length) {
            await Notification.insertMany(recipients.map((userId) => ({
                user: userId,
                companyId: req.companyId,
                title: 'New Private Discussion',
                message: `You have been added to a private discussion: "${discussion.substring(0, 50)}${discussion.length > 50 ? '...' : ''}"`,
                type: 'Info',
                link: '/discussions'
            })));
        }

        const populatedDiscussion = await Discussion.findById(newDiscussion._id)
            .populate('createdBy', 'firstName lastName email profilePicture')
            .populate('supervisor', 'firstName lastName email profilePicture')
            .populate('visibleToUsers', 'firstName lastName email profilePicture')
            .lean();

        res.status(201).json({ message: 'Discussion created successfully', discussion: attachDiscussionPermissions(populatedDiscussion, req.user) });
    } catch (error) {
        console.error('Error creating discussion:', error);
        res.status(500).json({ message: 'Error creating discussion', error: error.message });
    }
};

exports.getDiscussions = async (req, res) => {
    try {
        setPrivateCache(res, 30);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const accessMatch = buildAccessibleDiscussionMatch(req.companyId, req.user);
        const total = await Discussion.countDocuments(accessMatch);

        let discussions = await Discussion.aggregate([
            { $match: accessMatch },
            {
                $addFields: {
                    isCompleted: { $cond: { if: { $eq: ["$status", "mark as complete"] }, then: 1, else: 0 } }
                }
            },
            { $sort: { isCompleted: 1, createdAt: -1 } },
            { $skip: skip },
            { $limit: limit }
        ]);

        discussions = await Discussion.populate(discussions, [
            { path: 'createdBy', select: 'firstName lastName email profilePicture' },
            { path: 'supervisor', select: 'firstName lastName email profilePicture' },
            { path: 'visibleToUsers', select: 'firstName lastName email profilePicture' }
        ]);

        discussions = discussions.map((discussion) => attachDiscussionPermissions(discussion, req.user));

        res.status(200).json({
            discussions,
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            total
        });
    } catch (error) {
        console.error('Error fetching discussions:', error);
        res.status(500).json({ message: 'Error fetching discussions', error: error.message });
    }
};

exports.getDiscussionById = async (req, res) => {
    try {
        const discussion = await Discussion.findOne({ _id: req.params.id, companyId: req.companyId })
            .populate('createdBy', 'firstName lastName email profilePicture')
            .populate('supervisor', 'firstName lastName email profilePicture')
            .populate('visibleToUsers', 'firstName lastName email profilePicture')
            .lean();
        if (!discussion) return res.status(404).json({ message: 'Discussion not found' });
        if (!canAccessDiscussion(discussion, req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this discussion' });
        }
        res.status(200).json(attachDiscussionPermissions(discussion, req.user));
    } catch (error) {
        console.error('Error fetching discussion:', error);
        res.status(500).json({ message: 'Error fetching discussion', error: error.message });
    }
};

exports.updateDiscussion = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, discussion, status, dueDate, supervisor, visibleToUserIds, participantUserId } = req.body;

        const existingDiscussion = await Discussion.findOne({ _id: id, companyId: req.companyId });
        if (!existingDiscussion) return res.status(404).json({ message: 'Discussion not found' });

        if (!canEditDiscussion(existingDiscussion, req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this discussion' });
        }

        // Enforce supervisor-only status changes after creation
        if (status && status !== existingDiscussion.status) {
            if (!canChangeRestrictedDiscussionStatus(existingDiscussion, req.user)) {
                return res.status(403).json({ message: 'Only the assigned supervisor can update the discussion status' });
            }
        }

        const updateData = { title, discussion, status, dueDate };
        const selectedSupervisorId = supervisor || participantUserId || existingDiscussion.supervisor;
        const normalizedVisibleTo = Array.isArray(visibleToUserIds)
            ? visibleToUserIds
            : (visibleToUserIds ? [visibleToUserIds] : existingDiscussion.visibleToUsers || []);

        if (supervisor || participantUserId) {
            updateData.supervisor = selectedSupervisorId;
        }
        if (visibleToUserIds !== undefined) {
            updateData.visibleToUsers = normalizedVisibleTo;
        }
        updateData.participants = buildDiscussionParticipants(existingDiscussion.createdBy, updateData.supervisor || selectedSupervisorId, updateData.visibleToUsers || normalizedVisibleTo);

        const updatedDiscussion = await Discussion.findOneAndUpdate(
            { _id: id, companyId: req.companyId },
            updateData,
            { new: true, runValidators: true }
        ).populate('createdBy', 'firstName lastName email profilePicture')
         .populate('supervisor', 'firstName lastName email profilePicture')
         .populate('visibleToUsers', 'firstName lastName email profilePicture')
         .lean();

        res.status(200).json({ message: 'Discussion updated successfully', discussion: attachDiscussionPermissions(updatedDiscussion, req.user) });
    } catch (error) {
        console.error('Error updating discussion:', error);
        res.status(500).json({ message: 'Error updating discussion', error: error.message });
    }
};

exports.deleteDiscussion = async (req, res) => {
    try {
        const discussion = await Discussion.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!discussion) return res.status(404).json({ message: 'Discussion not found' });
        if (!canDeleteDiscussion(discussion, req.user)) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to delete this discussion' });
        }

        await discussion.softDelete(req.user._id);
        res.status(200).json({ message: 'Discussion moved to bin successfully' });
    } catch (error) {
        console.error('Error deleting discussion:', error);
        res.status(500).json({ message: 'Error deleting discussion', error: error.message });
    }
};

exports.getSupervisorList = async (req, res) => {
    try {
        setPrivateCache(res, 60);
        const users = await User.find({ companyId: req.companyId, isActive: true })
            .select('firstName lastName email profilePicture')
            .sort({ firstName: 1 });
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching supervisor list:', error);
        res.status(500).json({ message: 'Error fetching supervisor list', error: error.message });
    }
};
