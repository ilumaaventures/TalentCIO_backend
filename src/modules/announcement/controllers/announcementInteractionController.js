const Announcement = require('../announcement.model');
const User = require('../../../modules/user/user.model');
const {
    REACTION_TYPES,
    ANNOUNCEMENT_FIELD_LIMITS,
    normalizeString,
    exceedsMaxLength,
    canManageAnnouncements,
    canReactToAnnouncement,
    canCommentOnAnnouncement,
    fetchPopulatedAnnouncementById,
    serializeAnnouncement,
    buildVisibleAnnouncementQuery,
    isAnnouncementExpired
} = require('../utils/announcementHelpers');

const ensureAnnouncementFeedAccess = async (req, announcement, options = {}) => {
    const { interactiveOnly = false } = options;
    const manageAccess = canManageAnnouncements(req.user);

    if (!announcement) {
        return { error: 'Announcement not found.', status: 404, manageAccess };
    }

    if (manageAccess) {
        if (interactiveOnly && (announcement.status !== 'published' || isAnnouncementExpired(announcement))) {
            return { error: 'Only live announcements can receive reactions or comments.', status: 400, manageAccess };
        }

        return { announcement, manageAccess };
    }

    const accessible = await Announcement.exists({
        _id: announcement._id,
        ...buildVisibleAnnouncementQuery({ companyId: req.companyId, user: req.user })
    });

    if (!accessible) {
        return { error: 'You do not have access to this announcement.', status: 403, manageAccess };
    }

    if (interactiveOnly && (announcement.status !== 'published' || isAnnouncementExpired(announcement))) {
        return { error: 'Only live announcements can receive reactions or comments.', status: 400, manageAccess };
    }

    return { announcement, manageAccess };
};

const ensureInteractionCollections = (announcement) => {
    if (!announcement) return announcement;

    if (!Array.isArray(announcement.reactions)) {
        announcement.reactions = [];
    }

    if (!Array.isArray(announcement.comments)) {
        announcement.comments = [];
    }

    return announcement;
};

exports.toggleAnnouncementReaction = async (req, res) => {
    try {
        if (!canReactToAnnouncement(req.user)) {
            return res.status(403).json({ message: 'You do not have permission to react to announcements.' });
        }

        const type = normalizeString(req.body?.type).toLowerCase();
        if (!REACTION_TYPES.includes(type)) {
            return res.status(400).json({ message: 'Choose a valid reaction.' });
        }

        const announcement = await Announcement.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });
        ensureInteractionCollections(announcement);

        const access = await ensureAnnouncementFeedAccess(req, announcement, { interactiveOnly: true });
        if (access.error) {
            return res.status(access.status).json({ message: access.error });
        }

        const viewerId = String(req.user._id);
        const existingReaction = announcement.reactions.find((reaction) => String(reaction.userId) === viewerId);

        if (existingReaction && existingReaction.type === type) {
            announcement.reactions = announcement.reactions.filter((reaction) => String(reaction.userId) !== viewerId);
        } else if (existingReaction) {
            existingReaction.type = type;
            existingReaction.createdAt = new Date();
        } else {
            announcement.reactions.push({
                userId: req.user._id,
                type
            });
        }

        announcement.updatedBy = req.user._id;
        await announcement.save();

        const populatedAnnouncement = await fetchPopulatedAnnouncementById(announcement._id);
        return res.json({
            message: 'Reaction updated successfully.',
            announcement: serializeAnnouncement(populatedAnnouncement, req.user, access.manageAccess)
        });
    } catch (error) {
        console.error('toggleAnnouncementReaction error:', error);
        return res.status(500).json({ message: error?.message || 'Failed to update reaction.' });
    }
};

exports.addAnnouncementComment = async (req, res) => {
    try {
        if (!canCommentOnAnnouncement(req.user)) {
            return res.status(403).json({ message: 'You do not have permission to comment on announcements.' });
        }

        const text = normalizeString(req.body?.text);
        if (!text) {
            return res.status(400).json({ message: 'Comment text is required.' });
        }

        if (exceedsMaxLength(text, ANNOUNCEMENT_FIELD_LIMITS.commentText)) {
            return res.status(400).json({
                message: `Comment text cannot exceed ${ANNOUNCEMENT_FIELD_LIMITS.commentText} characters.`
            });
        }

        const announcement = await Announcement.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });
        ensureInteractionCollections(announcement);

        const access = await ensureAnnouncementFeedAccess(req, announcement, { interactiveOnly: true });
        if (access.error) {
            return res.status(access.status).json({ message: access.error });
        }

        announcement.comments.push({
            userId: req.user._id,
            text
        });
        announcement.updatedBy = req.user._id;
        await announcement.save();

        const populatedAnnouncement = await fetchPopulatedAnnouncementById(announcement._id);
        return res.status(201).json({
            message: 'Comment added successfully.',
            announcement: serializeAnnouncement(populatedAnnouncement, req.user, access.manageAccess)
        });
    } catch (error) {
        console.error('addAnnouncementComment error:', error);
        return res.status(500).json({ message: error?.message || 'Failed to add comment.' });
    }
};

exports.deleteAnnouncementComment = async (req, res) => {
    try {
        if (!canCommentOnAnnouncement(req.user)) {
            return res.status(403).json({ message: 'You do not have permission to delete comments.' });
        }

        const announcement = await Announcement.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });
        ensureInteractionCollections(announcement);

        const access = await ensureAnnouncementFeedAccess(req, announcement, { interactiveOnly: true });
        if (access.error) {
            return res.status(access.status).json({ message: access.error });
        }

        const comment = announcement.comments.id(req.params.commentId);
        if (!comment) {
            return res.status(404).json({ message: 'Comment not found.' });
        }

        const viewerId = String(req.user._id);
        const authorId = String(comment.userId || '');
        if (!access.manageAccess && authorId !== viewerId) {
            return res.status(403).json({ message: 'You can only remove your own comments.' });
        }

        announcement.comments.pull(comment._id);
        announcement.updatedBy = req.user._id;
        await announcement.save();

        const populatedAnnouncement = await fetchPopulatedAnnouncementById(announcement._id);
        return res.json({
            message: 'Comment deleted successfully.',
            announcement: serializeAnnouncement(populatedAnnouncement, req.user, access.manageAccess)
        });
    } catch (error) {
        console.error('deleteAnnouncementComment error:', error);
        return res.status(500).json({ message: error?.message || 'Failed to delete comment.' });
    }
};

exports.acknowledgeAnnouncement = async (req, res) => {
    try {
        const announcement = await Announcement.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!announcement) {
            return res.status(404).json({ message: 'Announcement not found.' });
        }

        const access = await ensureAnnouncementFeedAccess(req, announcement, { interactiveOnly: true });
        if (access.error) {
            return res.status(access.status).json({ message: access.error });
        }

        const viewerId = String(req.user._id);
        const alreadyAcked = (announcement.acknowledgements || []).some(
            (ack) => String(ack.userId) === viewerId
        );

        if (!alreadyAcked) {
            announcement.acknowledgements.push({
                userId: req.user._id,
                acknowledgedAt: new Date()
            });
            await announcement.save();
        }

        return res.json({
            message: 'Announcement acknowledged successfully.'
        });
    } catch (error) {
        console.error('acknowledgeAnnouncement error:', error);
        return res.status(500).json({ message: error?.message || 'Failed to acknowledge announcement.' });
    }
};

exports.getAnnouncementAcknowledgements = async (req, res) => {
    try {
        const manageAccess = canManageAnnouncements(req.user);
        if (!manageAccess) {
            return res.status(403).json({ message: 'Only managers can view the read status report.' });
        }

        const announcement = await Announcement.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!announcement) {
            return res.status(404).json({ message: 'Announcement not found.' });
        }

        const populatedAnnouncement = await Announcement.findOne({
            _id: req.params.id,
            companyId: req.companyId
        }).populate('acknowledgements.userId', 'firstName lastName email department employmentType profilePicture');

        const read = [];
        const readUserIds = new Set();

        (populatedAnnouncement.acknowledgements || []).forEach((ack) => {
            if (ack.userId) {
                read.push({
                    user: {
                        _id: ack.userId._id,
                        firstName: ack.userId.firstName || '',
                        lastName: ack.userId.lastName || '',
                        email: ack.userId.email || '',
                        department: ack.userId.department || '',
                        employmentType: ack.userId.employmentType || '',
                        profilePicture: ack.userId.profilePicture || '',
                        name: [ack.userId.firstName, ack.userId.lastName].filter(Boolean).join(' ').trim() || ack.userId.email
                    },
                    acknowledgedAt: ack.acknowledgedAt
                });
                readUserIds.add(String(ack.userId._id));
            }
        });

        const targetQuery = {
            companyId: req.companyId,
            isActive: true
        };

        if (announcement.audienceType === 'departments') {
            targetQuery.department = { $in: announcement.audienceDepartments || [] };
        } else if (announcement.audienceType === 'employmentTypes') {
            targetQuery.employmentType = { $in: announcement.audienceEmploymentTypes || [] };
        } else if (announcement.audienceType === 'specificUsers') {
            targetQuery._id = { $in: announcement.audienceUserIds || [] };
        }

        const targetUsers = await User.find(targetQuery)
            .select('firstName lastName email department employmentType profilePicture')
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        const unread = targetUsers
            .filter((user) => !readUserIds.has(String(user._id)))
            .map((user) => ({
                user: {
                    _id: user._id,
                    firstName: user.firstName || '',
                    lastName: user.lastName || '',
                    email: user.email || '',
                    department: user.department || '',
                    employmentType: user.employmentType || '',
                    profilePicture: user.profilePicture || '',
                    name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email
                }
            }));

        return res.json({
            read,
            unread
        });
    } catch (error) {
        console.error('getAnnouncementAcknowledgements error:', error);
        return res.status(500).json({ message: 'Failed to retrieve acknowledgement stats.' });
    }
};
