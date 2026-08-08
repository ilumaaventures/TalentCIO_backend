const Announcement = require('../announcement.model');
const {
    REACTION_TYPES,
    setPrivateCache,
    normalizeString,
    canManageAnnouncements,
    applyAnnouncementPopulation,
    serializeAnnouncement,
    buildVisibleAnnouncementQuery,
    isAnnouncementExpired,
    canReactToAnnouncement,
    canCommentOnAnnouncement,
    canViewAnnouncementReactions,
    fetchPopulatedAnnouncementById,
    buildUploadedAttachment,
    destroyAnnouncementAttachment,
    buildAnnouncementPayload,
    validateAnnouncementPayload,
    notifyPublishedAnnouncement
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

exports.getAnnouncements = async (req, res) => {
    try {
        setPrivateCache(res, 20);
        const manageAccess = canManageAnnouncements(req.user);
        const scope = req.query.scope === 'manage' && manageAccess ? 'manage' : 'visible';
        const featured = req.query.featured === 'true';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || (featured ? 3 : 20), 1), scope === 'manage' ? 100 : 50);
        const statusFilter = normalizeString(req.query.status).toLowerCase();

        const query = scope === 'manage'
            ? { companyId: req.companyId }
            : buildVisibleAnnouncementQuery({ companyId: req.companyId, user: req.user });

        if (scope === 'manage' && ['draft', 'published'].includes(statusFilter)) {
            query.status = statusFilter;
        }

        const announcementQuery = Announcement.find(query)
            .sort({
                pinned: -1,
                publishedAt: -1,
                createdAt: -1
            })
            .limit(limit);

        applyAnnouncementPopulation(announcementQuery);
        const announcements = await announcementQuery.lean();

        return res.json({
            announcements: announcements.map((announcement) => serializeAnnouncement(announcement, req.user, scope === 'manage')),
            canManage: manageAccess,
            reactionTypes: REACTION_TYPES
        });
    } catch (error) {
        console.error('getAnnouncements error:', error);
        return res.status(500).json({ message: 'Failed to load announcements.' });
    }
};

exports.getAnnouncementById = async (req, res) => {
    try {
        const announcementQuery = Announcement.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });
        applyAnnouncementPopulation(announcementQuery);
        const announcement = await announcementQuery.lean();

        const { error, status, manageAccess } = await ensureAnnouncementFeedAccess(req, announcement);
        if (error) {
            return res.status(status).json({ message: error });
        }

        return res.json({
            announcement: serializeAnnouncement(announcement, req.user, manageAccess)
        });
    } catch (error) {
        console.error('getAnnouncementById error:', error);
        return res.status(500).json({ message: 'Failed to fetch announcement.' });
    }
};

exports.createAnnouncement = async (req, res) => {
    let uploadedAttachment = null;

    try {
        uploadedAttachment = buildUploadedAttachment(req.file);
        const payload = buildAnnouncementPayload(req.body || {});
        const validationMessage = await validateAnnouncementPayload(payload, req.companyId);

        if (validationMessage) {
            if (uploadedAttachment) {
                await destroyAnnouncementAttachment(uploadedAttachment);
            }
            return res.status(400).json({ message: validationMessage });
        }

        const shouldPublishNow = payload.status === 'published';
        const announcement = await Announcement.create({
            ...payload,
            companyId: req.companyId,
            createdBy: req.user._id,
            updatedBy: req.user._id,
            attachment: uploadedAttachment,
            publishedAt: shouldPublishNow ? new Date() : null
        });
        uploadedAttachment = null;

        const populatedAnnouncement = await fetchPopulatedAnnouncementById(announcement._id);

        if (shouldPublishNow) {
            try {
                await notifyPublishedAnnouncement({ req, announcement: populatedAnnouncement });
            } catch (notificationError) {
                console.error('createAnnouncement notifyPublishedAnnouncement error:', notificationError);
            }
        }

        return res.status(201).json({
            message: shouldPublishNow ? 'Announcement published successfully.' : 'Announcement draft created successfully.',
            announcement: serializeAnnouncement(populatedAnnouncement, req.user, true)
        });
    } catch (error) {
        console.error('createAnnouncement error:', error);
        if (uploadedAttachment) {
            await destroyAnnouncementAttachment(uploadedAttachment);
        }
        return res.status(500).json({ message: 'Failed to create announcement.' });
    }
};

exports.updateAnnouncement = async (req, res) => {
    let uploadedAttachment = null;

    try {
        const existingAnnouncement = await Announcement.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!existingAnnouncement) {
            return res.status(404).json({ message: 'Announcement not found.' });
        }

        uploadedAttachment = buildUploadedAttachment(req.file);
        const payload = buildAnnouncementPayload(req.body || {});
        const validationMessage = await validateAnnouncementPayload(payload, req.companyId);

        if (validationMessage) {
            if (uploadedAttachment) {
                await destroyAnnouncementAttachment(uploadedAttachment);
            }
            return res.status(400).json({ message: validationMessage });
        }

        const shouldPublishNow = existingAnnouncement.status !== 'published' && payload.status === 'published';
        const previousAttachment = existingAnnouncement.attachment?.publicId
            ? {
                url: existingAnnouncement.attachment.url,
                name: existingAnnouncement.attachment.name,
                publicId: existingAnnouncement.attachment.publicId,
                resourceType: existingAnnouncement.attachment.resourceType,
                mimeType: existingAnnouncement.attachment.mimeType,
                size: existingAnnouncement.attachment.size,
                uploadedAt: existingAnnouncement.attachment.uploadedAt
            }
            : null;

        existingAnnouncement.title = payload.title;
        existingAnnouncement.summary = payload.summary;
        existingAnnouncement.content = payload.content;
        existingAnnouncement.category = payload.category;
        existingAnnouncement.status = payload.status;
        existingAnnouncement.pinned = payload.pinned;
        existingAnnouncement.audienceType = payload.audienceType;
        existingAnnouncement.audienceDepartments = payload.audienceDepartments;
        existingAnnouncement.audienceEmploymentTypes = payload.audienceEmploymentTypes;
        existingAnnouncement.audienceUserIds = payload.audienceUserIds;
        existingAnnouncement.expiresAt = payload.expiresAt;
        existingAnnouncement.recurringInterval = payload.recurringInterval;
        existingAnnouncement.recurringDayOfMonth = payload.recurringDayOfMonth;
        existingAnnouncement.updatedBy = req.user._id;

        if (uploadedAttachment) {
            existingAnnouncement.attachment = uploadedAttachment;
        } else if (payload.removeAttachment) {
            existingAnnouncement.attachment = null;
        }

        if (shouldPublishNow) {
            existingAnnouncement.publishedAt = new Date();
        }

        await existingAnnouncement.save();
        const nextAttachmentPublicId = existingAnnouncement.attachment?.publicId || '';
        if (previousAttachment?.publicId && previousAttachment.publicId !== nextAttachmentPublicId) {
            await destroyAnnouncementAttachment(previousAttachment);
        }
        uploadedAttachment = null;

        const populatedAnnouncement = await fetchPopulatedAnnouncementById(existingAnnouncement._id);

        if (shouldPublishNow) {
            try {
                await notifyPublishedAnnouncement({ req, announcement: populatedAnnouncement });
            } catch (notificationError) {
                console.error('updateAnnouncement notifyPublishedAnnouncement error:', notificationError);
            }
        }

        return res.json({
            message: shouldPublishNow ? 'Announcement published successfully.' : 'Announcement updated successfully.',
            announcement: serializeAnnouncement(populatedAnnouncement, req.user, true)
        });
    } catch (error) {
        console.error('updateAnnouncement error:', error);
        if (uploadedAttachment) {
            await destroyAnnouncementAttachment(uploadedAttachment);
        }
        return res.status(500).json({
            message: error?.message || 'Failed to update announcement.'
        });
    }
};

exports.deleteAnnouncement = async (req, res) => {
    try {
        const announcement = await Announcement.findOne({
            _id: req.params.id,
            companyId: req.companyId
        });

        if (!announcement) {
            return res.status(404).json({ message: 'Announcement not found.' });
        }

        await announcement.softDelete(req.user._id);
        return res.json({ message: 'Announcement deleted successfully.' });
    } catch (error) {
        console.error('deleteAnnouncement error:', error);
        return res.status(500).json({ message: 'Failed to delete announcement.' });
    }
};
