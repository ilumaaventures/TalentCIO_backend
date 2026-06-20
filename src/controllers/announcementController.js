const Announcement = require('../models/Announcement');
const OnboardingEmployee = require('../models/OnboardingEmployee');
const User = require('../models/User');
const { cloudinary } = require('../config/cloudinary');
const NotificationService = require('../services/notificationService');

const ANNOUNCEMENT_CATEGORIES = ['General', 'HR', 'Policy', 'Product', 'Celebration', 'Alert'];
const AUDIENCE_TYPES = ['all', 'departments', 'employmentTypes', 'specificUsers'];
const REACTION_TYPES = ['like', 'celebrate', 'support'];
const MANAGER_ROLE_NAMES = new Set(['Admin', 'Manager', 'HR Admin', 'System Admin']);
const EMPLOYMENT_TYPES = ['Full Time', 'Part Time', 'Contract', 'Intern', 'Consultant', 'Freelance', 'Probation'];
const ANNOUNCEMENT_COMMUNITY_SECTION_PERMISSIONS = {
    birthdays: 'announcement.community.birthdays.view',
    anniversaries: 'announcement.community.work_anniversaries.view',
    joinees: 'announcement.community.new_joiners.view'
};
const ANNOUNCEMENT_FIELD_LIMITS = {
    title: 160,
    summary: 240,
    content: 8000,
    commentText: 1200
};

const setPrivateCache = (res, maxAgeSeconds = 20) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`);
};

const monthDayFormatter = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short'
});

const normalizeString = (value = '') => String(value || '').trim();

const parseBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;

    const normalizedValue = normalizeString(value).toLowerCase();
    return ['true', '1', 'yes', 'on'].includes(normalizedValue);
};

const parseArrayValue = (value) => {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];

    if (typeof value === 'string') {
        const trimmedValue = normalizeString(value);
        if (!trimmedValue) return [];

        try {
            const parsedValue = JSON.parse(trimmedValue);
            return Array.isArray(parsedValue) ? parsedValue : [parsedValue];
        } catch {
            return [trimmedValue];
        }
    }

    return [value];
};

const exceedsMaxLength = (value = '', maxLength = 0) => (
    Boolean(maxLength) && normalizeString(value).length > maxLength
);

const toValidDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const isSameCalendarMonth = (leftValue, rightValue = new Date()) => {
    const leftDate = toValidDate(leftValue);
    const rightDate = toValidDate(rightValue);
    if (!leftDate || !rightDate) return false;
    return (
        leftDate.getMonth() === rightDate.getMonth()
        && leftDate.getFullYear() === rightDate.getFullYear()
    );
};

const isSameRecurringMonth = (leftValue, rightValue = new Date()) => {
    const leftDate = toValidDate(leftValue);
    const rightDate = toValidDate(rightValue);
    if (!leftDate || !rightDate) return false;
    return leftDate.getMonth() === rightDate.getMonth();
};

const isSameMonthDay = (leftValue, rightValue = new Date()) => {
    const leftDate = toValidDate(leftValue);
    const rightDate = toValidDate(rightValue);
    if (!leftDate || !rightDate) return false;
    return (
        leftDate.getMonth() === rightDate.getMonth()
        && leftDate.getDate() === rightDate.getDate()
    );
};

const getYearsCompleted = (value, referenceDate = new Date()) => {
    const sourceDate = toValidDate(value);
    const compareDate = toValidDate(referenceDate);
    if (!sourceDate || !compareDate) return 0;

    let years = compareDate.getFullYear() - sourceDate.getFullYear();
    const hasOccurredThisYear = (
        compareDate.getMonth() > sourceDate.getMonth()
        || (compareDate.getMonth() === sourceDate.getMonth() && compareDate.getDate() >= sourceDate.getDate())
    );

    if (!hasOccurredThisYear) {
        years -= 1;
    }

    return Math.max(years, 0);
};

const getTransferredOnboardingRecord = (user = {}, onboardingEmployeeByUserId = new Map()) => (
    onboardingEmployeeByUserId.get(String(user?._id || '')) || null
);

const getBirthdayDateValue = (user = {}, onboardingEmployeeByUserId = new Map()) => (
    user?.employeeProfile?.personal?.dob
    || getTransferredOnboardingRecord(user, onboardingEmployeeByUserId)?.personalDetails?.dateOfBirth
    || null
);

const getCurrentMonthDateValue = (user = {}, onboardingEmployeeByUserId = new Map()) => (
    user?.employeeProfile?.employment?.joiningDate
    || user?.joiningDate
    || getTransferredOnboardingRecord(user, onboardingEmployeeByUserId)?.joiningDate
    || null
);

const normalizeStringArray = (values = []) => (
    [...new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => normalizeString(value))
            .filter(Boolean)
    )]
);

const normalizeAudienceUserObjectIds = (values = []) => (
    [...new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => {
                if (!value) return '';
                if (typeof value === 'string') return normalizeString(value);
                if (value._id) return normalizeString(value._id);
                return normalizeString(value);
            })
            .filter(Boolean)
    )]
);

const getUserRoleNames = (user = {}) => (
    Array.isArray(user.roles)
        ? user.roles.map((role) => (typeof role === 'string' ? role : role?.name)).filter(Boolean)
        : []
);

const canManageAnnouncements = (user = {}) => {
    const roleNames = getUserRoleNames(user);
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];

    return (
        roleNames.some((roleName) => MANAGER_ROLE_NAMES.has(roleName))
        || permissions.includes('announcement.manage')
        || permissions.includes('*')
        || permissions.includes('admin')
    );
};

const canReactToAnnouncement = (user = {}) => {
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    return (
        canManageAnnouncements(user)
        || permissions.includes('announcement.react')
    );
};

const canCommentOnAnnouncement = (user = {}) => {
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    return (
        canManageAnnouncements(user)
        || permissions.includes('announcement.comment')
    );
};

const canViewAnnouncementReactions = (user = {}) => {
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    return (
        canManageAnnouncements(user)
        || permissions.includes('announcement.reactions.view')
    );
};

const hasAnnouncementCommunityPermission = (user = {}, permissionKey = '') => {
    if (!permissionKey) return false;

    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    return (
        Boolean(user?.hasAllPermissions)
        || permissions.includes(permissionKey)
        || permissions.includes('*')
        || permissions.includes('admin')
    );
};

const canViewAnnouncementCommunitySection = (user = {}, sectionKey = '') => (
    hasAnnouncementCommunityPermission(user, ANNOUNCEMENT_COMMUNITY_SECTION_PERMISSIONS[sectionKey])
);

const announcementPopulatePaths = [
    { path: 'createdBy', select: 'firstName lastName profilePicture department employmentType' },
    { path: 'updatedBy', select: 'firstName lastName profilePicture department employmentType' },
    { path: 'audienceUserIds', select: 'firstName lastName email department employmentType profilePicture' },
    { path: 'comments.userId', select: 'firstName lastName email profilePicture department employmentType' },
    { path: 'reactions.userId', select: 'firstName lastName profilePicture' }
];

const applyAnnouncementPopulation = (query) => {
    announcementPopulatePaths.forEach((populateConfig) => {
        query.populate(populateConfig);
    });
    return query;
};

const buildAudienceSummary = (announcement = {}) => {
    if (announcement.audienceType === 'departments') {
        return {
            type: announcement.audienceType,
            label: announcement.audienceDepartments?.length
                ? `Departments: ${announcement.audienceDepartments.join(', ')}`
                : 'Departments'
        };
    }

    if (announcement.audienceType === 'employmentTypes') {
        return {
            type: announcement.audienceType,
            label: announcement.audienceEmploymentTypes?.length
                ? `Employment Types: ${announcement.audienceEmploymentTypes.join(', ')}`
                : 'Employment Types'
        };
    }

    if (announcement.audienceType === 'specificUsers') {
        const count = Array.isArray(announcement.audienceUserIds) ? announcement.audienceUserIds.length : 0;
        return {
            type: announcement.audienceType,
            label: `Specific Users (${count})`
        };
    }

    return {
        type: 'all',
        label: 'All Employees'
    };
};

const buildVisibilityMatch = (user = {}) => {
    const orConditions = [{ audienceType: 'all' }];

    if (normalizeString(user.department)) {
        orConditions.push({
            audienceType: 'departments',
            audienceDepartments: normalizeString(user.department)
        });
    }

    if (normalizeString(user.employmentType)) {
        orConditions.push({
            audienceType: 'employmentTypes',
            audienceEmploymentTypes: normalizeString(user.employmentType)
        });
    }

    if (user._id) {
        orConditions.push({
            audienceType: 'specificUsers',
            audienceUserIds: user._id
        });
    }

    return { $or: orConditions };
};

const buildVisibleAnnouncementQuery = ({ companyId, user }) => {
    const now = new Date();
    const isManager = canManageAnnouncements(user);

    const query = {
        companyId,
        status: 'published',
        $and: [
            {
                $or: [
                    { expiresAt: null },
                    { expiresAt: { $gt: now } }
                ]
            }
        ]
    };

    if (!isManager) {
        Object.assign(query, buildVisibilityMatch(user));
    }

    return query;
};

const isAnnouncementExpired = (announcement = {}) => (
    announcement?.expiresAt ? new Date(announcement.expiresAt) <= new Date() : false
);

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

const buildUploadedAttachment = (file) => {
    if (!file?.path) return null;

    return {
        url: file.path,
        name: file.originalname || 'attachment',
        publicId: file.filename || '',
        resourceType: file.mimetype?.startsWith('image/') ? 'image' : 'raw',
        mimeType: file.mimetype || '',
        size: Number(file.size) || 0,
        uploadedAt: new Date()
    };
};

const destroyAnnouncementAttachment = async (attachment = null) => {
    if (!attachment?.publicId) return;

    const resourceType = attachment.resourceType === 'image' ? 'image' : 'raw';

    try {
        await cloudinary.uploader.destroy(attachment.publicId, { resource_type: resourceType });
    } catch (error) {
        console.error('destroyAnnouncementAttachment error:', error);
    }
};

const getReactionBreakdown = (reactions = [], viewerId = '') => {
    const counts = REACTION_TYPES.reduce((accumulator, type) => {
        accumulator[type] = 0;
        return accumulator;
    }, {});

    let viewerReaction = '';
    reactions.forEach((reaction) => {
        const reactionType = normalizeString(reaction?.type).toLowerCase();
        if (!REACTION_TYPES.includes(reactionType)) return;
        counts[reactionType] += 1;

        const reactionUserId = String(reaction?.userId?._id || reaction?.userId || '');
        if (viewerId && reactionUserId === viewerId) {
            viewerReaction = reactionType;
        }
    });

    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    return {
        counts,
        total,
        viewerReaction
    };
};

const buildReactionPreviewUsers = (reactions = []) => (
    reactions
        .slice()
        .sort((left, right) => new Date(right?.createdAt || 0) - new Date(left?.createdAt || 0))
        .slice(0, 3)
        .map((reaction) => {
            const person = reaction?.userId;
            const name = [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim();

            return {
                _id: person?._id || reaction?.userId || null,
                firstName: person?.firstName || '',
                lastName: person?.lastName || '',
                profilePicture: person?.profilePicture || '',
                name: name || 'Team Member',
                reactionType: reaction?.type || ''
            };
        })
);

const serializeComment = (comment = {}, viewer = {}, manageAccess = false) => {
    const authorName = [comment.userId?.firstName, comment.userId?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
    const viewerId = String(viewer?._id || '');
    const authorId = String(comment.userId?._id || comment.userId || '');
    const canDelete = Boolean(authorId && (authorId === viewerId || manageAccess));

    return {
        _id: comment._id,
        text: comment.text || '',
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        canDelete,
        author: comment.userId ? {
            _id: comment.userId._id,
            firstName: comment.userId.firstName || '',
            lastName: comment.userId.lastName || '',
            email: comment.userId.email || '',
            department: comment.userId.department || '',
            employmentType: comment.userId.employmentType || '',
            profilePicture: comment.userId.profilePicture || '',
            name: authorName || 'Team Member'
        } : null
    };
};

const serializeAnnouncement = (announcement = {}, viewer = {}, manageAccess = false) => {
    const audienceSummary = buildAudienceSummary(announcement);
    const creatorName = [announcement.createdBy?.firstName, announcement.createdBy?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
    const updaterName = [announcement.updatedBy?.firstName, announcement.updatedBy?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
    const isExpired = isAnnouncementExpired(announcement);
    const isVisibleToViewer = manageAccess
        ? true
        : (
            announcement.status === 'published'
            && !isExpired
        );
    const viewerId = String(viewer?._id || '');
    const canReact = canReactToAnnouncement(viewer);
    const canComment = canCommentOnAnnouncement(viewer);
    const canViewReactions = canViewAnnouncementReactions(viewer);

    const reactionSummary = getReactionBreakdown(announcement.reactions || [], viewerId);
    const comments = (canComment || canViewReactions) && Array.isArray(announcement.comments)
        ? announcement.comments
            .slice()
            .sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0))
            .map((comment) => serializeComment(comment, viewer, manageAccess))
        : [];

    return {
        _id: announcement._id,
        title: announcement.title,
        summary: announcement.summary || '',
        content: announcement.content,
        category: announcement.category,
        status: announcement.status,
        pinned: Boolean(announcement.pinned),
        audienceType: announcement.audienceType,
        audienceDepartments: announcement.audienceDepartments || [],
        audienceEmploymentTypes: announcement.audienceEmploymentTypes || [],
        audienceUserIds: (announcement.audienceUserIds || []).map((userId) => String(userId?._id || userId)),
        audienceUsers: Array.isArray(announcement.audienceUserIds)
            ? announcement.audienceUserIds
                .filter((userEntry) => typeof userEntry === 'object' && userEntry)
                .map((userEntry) => ({
                    _id: userEntry._id,
                    firstName: userEntry.firstName,
                    lastName: userEntry.lastName,
                    email: userEntry.email,
                    department: userEntry.department,
                    employmentType: userEntry.employmentType,
                    profilePicture: userEntry.profilePicture || ''
                }))
            : [],
        audienceSummary,
        publishedAt: announcement.publishedAt,
        expiresAt: announcement.expiresAt,
        createdAt: announcement.createdAt,
        updatedAt: announcement.updatedAt,
        createdBy: creatorName ? {
            _id: announcement.createdBy?._id,
            firstName: announcement.createdBy?.firstName || '',
            lastName: announcement.createdBy?.lastName || '',
            department: announcement.createdBy?.department || '',
            employmentType: announcement.createdBy?.employmentType || '',
            profilePicture: announcement.createdBy?.profilePicture || '',
            name: creatorName
        } : null,
        updatedBy: updaterName ? {
            _id: announcement.updatedBy?._id,
            firstName: announcement.updatedBy?.firstName || '',
            lastName: announcement.updatedBy?.lastName || '',
            department: announcement.updatedBy?.department || '',
            employmentType: announcement.updatedBy?.employmentType || '',
            profilePicture: announcement.updatedBy?.profilePicture || '',
            name: updaterName
        } : null,
        attachment: announcement?.attachment?.url ? {
            url: announcement.attachment.url,
            name: announcement.attachment.name || 'attachment',
            mimeType: announcement.attachment.mimeType || '',
            size: Number(announcement.attachment.size) || 0,
            resourceType: announcement.attachment.resourceType || 'raw',
            uploadedAt: announcement.attachment.uploadedAt || announcement.updatedAt || announcement.createdAt
        } : null,
        comments,
        commentCount: comments.length,
        reactionCounts: canViewReactions ? reactionSummary.counts : {},
        totalReactions: canViewReactions ? reactionSummary.total : 0,
        viewerReaction: canReact ? reactionSummary.viewerReaction : null,
        reactionPreviewUsers: canViewReactions ? buildReactionPreviewUsers(announcement.reactions || []) : [],
        canManage: manageAccess || canManageAnnouncements(viewer),
        canReact,
        canComment,
        canViewReactions,
        isExpired,
        isVisibleToViewer,
        acknowledgedCount: Array.isArray(announcement.acknowledgements) ? announcement.acknowledgements.length : 0,
        viewerAcknowledged: Array.isArray(announcement.acknowledgements)
            ? announcement.acknowledgements.some((ack) => String(ack.userId?._id || ack.userId) === viewerId)
            : false
    };
};

const serializeCommunityMember = (user = {}, options = {}) => {
    const {
        dateValue = null,
        yearsCompleted = 0,
        source = '',
        transferredFromOnboarding = false
    } = options;

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();

    return {
        _id: user._id,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        name: name || user.email || 'Team Member',
        email: user.email || '',
        department: user.department || '',
        employmentType: user.employmentType || '',
        profilePicture: user.profilePicture || '',
        dateLabel: dateValue ? monthDayFormatter.format(new Date(dateValue)) : '',
        yearsCompleted,
        source,
        transferredFromOnboarding
    };
};

const buildAnnouncementPayload = (body = {}) => {
    const title = normalizeString(body.title);
    const summary = normalizeString(body.summary);
    const content = normalizeString(body.content);
    const category = ANNOUNCEMENT_CATEGORIES.includes(body.category) ? body.category : 'General';
    const status = body.status === 'published' ? 'published' : 'draft';
    const audienceType = AUDIENCE_TYPES.includes(body.audienceType) ? body.audienceType : 'all';
    const audienceDepartments = normalizeStringArray(parseArrayValue(body.audienceDepartments));
    const audienceEmploymentTypes = normalizeStringArray(parseArrayValue(body.audienceEmploymentTypes));
    const audienceUserIds = normalizeAudienceUserObjectIds(parseArrayValue(body.audienceUserIds));
    const expiresAtValue = normalizeString(body.expiresAt);
    const expiresAt = expiresAtValue ? new Date(expiresAtValue) : null;

    return {
        title,
        summary,
        content,
        category,
        status,
        pinned: parseBoolean(body.pinned),
        audienceType,
        audienceDepartments,
        audienceEmploymentTypes,
        audienceUserIds,
        expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
        removeAttachment: parseBoolean(body.removeAttachment)
    };
};

const validateAnnouncementPayload = async (payload = {}, companyId) => {
    if (!payload.title) {
        return 'Title is required.';
    }

    if (!payload.content) {
        return 'Announcement content is required.';
    }

    if (exceedsMaxLength(payload.title, ANNOUNCEMENT_FIELD_LIMITS.title)) {
        return `Title cannot exceed ${ANNOUNCEMENT_FIELD_LIMITS.title} characters.`;
    }

    if (exceedsMaxLength(payload.summary, ANNOUNCEMENT_FIELD_LIMITS.summary)) {
        return `Summary cannot exceed ${ANNOUNCEMENT_FIELD_LIMITS.summary} characters.`;
    }

    if (exceedsMaxLength(payload.content, ANNOUNCEMENT_FIELD_LIMITS.content)) {
        return `Announcement content cannot exceed ${ANNOUNCEMENT_FIELD_LIMITS.content} characters.`;
    }

    if (payload.expiresAt && payload.expiresAt <= new Date()) {
        return 'Expiry date must be in the future.';
    }

    if (payload.audienceType === 'departments' && payload.audienceDepartments.length === 0) {
        return 'Select at least one department audience.';
    }

    if (payload.audienceType === 'employmentTypes' && payload.audienceEmploymentTypes.length === 0) {
        return 'Select at least one employment type audience.';
    }

    if (payload.audienceType === 'specificUsers') {
        if (payload.audienceUserIds.length === 0) {
            return 'Select at least one employee audience.';
        }

        const existingUsers = await User.countDocuments({
            _id: { $in: payload.audienceUserIds },
            companyId,
            isActive: true
        });

        if (existingUsers !== payload.audienceUserIds.length) {
            return 'One or more selected employees are unavailable.';
        }
    }

    return '';
};

const notifyPublishedAnnouncement = async ({ req, announcement }) => {
    const liveAudienceQuery = {
        companyId: req.companyId,
        isActive: true
    };

    if (announcement.audienceType === 'departments') {
        liveAudienceQuery.department = { $in: announcement.audienceDepartments || [] };
    } else if (announcement.audienceType === 'employmentTypes') {
        liveAudienceQuery.employmentType = { $in: announcement.audienceEmploymentTypes || [] };
    } else if (announcement.audienceType === 'specificUsers') {
        const audienceUserIds = normalizeAudienceUserObjectIds(announcement.audienceUserIds);
        liveAudienceQuery._id = { $in: audienceUserIds };
    }

    const recipients = await User.find(liveAudienceQuery)
        .select('_id')
        .lean();

    const recipientIds = recipients
        .map((user) => String(user._id || ''))
        .filter((userId) => userId && userId !== String(req.user._id));

    if (recipientIds.length === 0) {
        return;
    }

    const io = req.app.get('io');
    await NotificationService.createManyNotifications(io, recipientIds.map((userId) => ({
        user: userId,
        companyId: req.companyId,
        preferenceKey: 'announcement_published',
        title: announcement.title,
        message: announcement.summary || 'A new internal announcement has been published.',
        type: announcement.category === 'Alert' ? 'Alert' : 'Info',
        link: '/announcements',
        metadata: {
            announcementId: announcement._id
        }
    })));
};

const fetchPopulatedAnnouncementById = async (announcementId) => {
    const query = Announcement.findById(announcementId);
    applyAnnouncementPopulation(query);
    return query.lean();
};

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

exports.getAnnouncementComposerSetup = async (req, res) => {
    try {
        setPrivateCache(res, 60);
        const manageAccess = canManageAnnouncements(req.user);

        if (!manageAccess) {
            return res.json({
                canManage: false,
                categories: ANNOUNCEMENT_CATEGORIES,
                audienceTypes: AUDIENCE_TYPES,
                reactionTypes: REACTION_TYPES,
                departments: [],
                employmentTypes: EMPLOYMENT_TYPES,
                users: []
            });
        }

        const [departments, users] = await Promise.all([
            User.distinct('department', {
                companyId: req.companyId,
                isActive: true,
                department: { $nin: [null, ''] }
            }),
            User.find({ companyId: req.companyId, isActive: true })
                .select('firstName lastName email department employmentType profilePicture')
                .sort({ firstName: 1, lastName: 1 })
                .lean()
        ]);

        return res.json({
            canManage: true,
            categories: ANNOUNCEMENT_CATEGORIES,
            audienceTypes: AUDIENCE_TYPES,
            reactionTypes: REACTION_TYPES,
            departments: normalizeStringArray(departments).sort((left, right) => left.localeCompare(right)),
            employmentTypes: EMPLOYMENT_TYPES,
            users
        });
    } catch (error) {
        console.error('getAnnouncementComposerSetup error:', error);
        return res.status(500).json({ message: 'Failed to load announcement composer setup.' });
    }
};

exports.getAnnouncementBootstrap = exports.getAnnouncementComposerSetup;

exports.getAnnouncementCommunity = async (req, res) => {
    try {
        setPrivateCache(res, 300);
        const now = new Date();
        const sectionVisibility = {
            birthdays: canViewAnnouncementCommunitySection(req.user, 'birthdays'),
            anniversaries: canViewAnnouncementCommunitySection(req.user, 'anniversaries'),
            joinees: canViewAnnouncementCommunitySection(req.user, 'joinees')
        };

        const emptyResponse = {
            month: {
                year: now.getFullYear(),
                month: now.getMonth() + 1
            },
            visibility: sectionVisibility,
            birthdays: {
                currentMonth: [],
                today: [],
                count: 0
            },
            workAnniversaries: {
                currentMonth: [],
                today: [],
                count: 0
            },
            newJoinees: {
                currentMonth: [],
                count: 0
            }
        };

        if (!Object.values(sectionVisibility).some(Boolean)) {
            return res.json(emptyResponse);
        }

        const users = await User.find({ companyId: req.companyId, isActive: true })
            .select('firstName lastName email department employmentType profilePicture joiningDate employeeProfile createdAt')
            .populate('employeeProfile', 'personal.dob employment.joiningDate')
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        const userIds = users.map((user) => user._id);
        const onboardingTransfers = await OnboardingEmployee.find({
            companyId: req.companyId,
            transferredToUserId: { $in: userIds }
        })
            .select('transferredToUserId personalDetails.dateOfBirth joiningDate')
            .lean();

        const onboardingTransferredUserIdSet = new Set(
            onboardingTransfers.map((entry) => String(entry.transferredToUserId || ''))
        );
        const onboardingEmployeeByUserId = new Map(
            onboardingTransfers.map((entry) => [String(entry.transferredToUserId || ''), entry])
        );

        const birthdayUsersCurrentMonth = sectionVisibility.birthdays
            ? users
                .filter((user) => isSameRecurringMonth(getBirthdayDateValue(user, onboardingEmployeeByUserId), now))
                .sort((left, right) => (
                    new Date(getBirthdayDateValue(left, onboardingEmployeeByUserId)).getDate()
                    - new Date(getBirthdayDateValue(right, onboardingEmployeeByUserId)).getDate()
                ))
            : [];

        const birthdaysCurrentMonth = sectionVisibility.birthdays
            ? birthdayUsersCurrentMonth.map((user) => serializeCommunityMember(user, {
                dateValue: getBirthdayDateValue(user, onboardingEmployeeByUserId),
                source: 'birthday'
            }))
            : [];

        const birthdaysToday = sectionVisibility.birthdays
            ? birthdayUsersCurrentMonth
                .filter((user) => isSameMonthDay(getBirthdayDateValue(user, onboardingEmployeeByUserId), now))
                .map((user) => serializeCommunityMember(user, {
                    dateValue: getBirthdayDateValue(user, onboardingEmployeeByUserId),
                    source: 'birthday'
                }))
            : [];

        const anniversaryUsersCurrentMonth = sectionVisibility.anniversaries
            ? users
                .filter((user) => {
                    const joiningDate = getCurrentMonthDateValue(user, onboardingEmployeeByUserId);
                    return isSameRecurringMonth(joiningDate, now) && getYearsCompleted(joiningDate, now) > 0;
                })
                .sort((left, right) => {
                    const leftDate = getCurrentMonthDateValue(left, onboardingEmployeeByUserId);
                    const rightDate = getCurrentMonthDateValue(right, onboardingEmployeeByUserId);
                    return new Date(leftDate).getDate() - new Date(rightDate).getDate();
                })
            : [];

        const anniversariesCurrentMonth = sectionVisibility.anniversaries
            ? anniversaryUsersCurrentMonth.map((user) => {
                const joiningDate = getCurrentMonthDateValue(user, onboardingEmployeeByUserId);
                return serializeCommunityMember(user, {
                    dateValue: joiningDate,
                    yearsCompleted: getYearsCompleted(joiningDate, now),
                    source: 'anniversary'
                });
            })
            : [];

        const anniversariesToday = sectionVisibility.anniversaries
            ? anniversaryUsersCurrentMonth
                .filter((user) => isSameMonthDay(getCurrentMonthDateValue(user, onboardingEmployeeByUserId), now))
                .map((user) => {
                    const joiningDate = getCurrentMonthDateValue(user, onboardingEmployeeByUserId);
                    return serializeCommunityMember(user, {
                        dateValue: joiningDate,
                        yearsCompleted: getYearsCompleted(joiningDate, now),
                        source: 'anniversary'
                    });
                })
            : [];

        const newJoineesCurrentMonth = sectionVisibility.joinees
            ? users
                .filter((user) => {
                    const joiningDate = getCurrentMonthDateValue(user, onboardingEmployeeByUserId);
                    return isSameCalendarMonth(joiningDate, now);
                })
                .sort((left, right) => (
                    new Date(getCurrentMonthDateValue(left, onboardingEmployeeByUserId))
                    - new Date(getCurrentMonthDateValue(right, onboardingEmployeeByUserId))
                ))
                .map((user) => serializeCommunityMember(user, {
                    dateValue: getCurrentMonthDateValue(user, onboardingEmployeeByUserId),
                    source: 'newJoinee',
                    transferredFromOnboarding: onboardingTransferredUserIdSet.has(String(user._id))
                }))
            : [];

        return res.json({
            month: {
                year: now.getFullYear(),
                month: now.getMonth() + 1
            },
            visibility: sectionVisibility,
            birthdays: {
                currentMonth: birthdaysCurrentMonth,
                today: birthdaysToday,
                count: birthdaysCurrentMonth.length
            },
            workAnniversaries: {
                currentMonth: anniversariesCurrentMonth,
                today: anniversariesToday,
                count: anniversariesCurrentMonth.length
            },
            newJoinees: {
                currentMonth: newJoineesCurrentMonth,
                count: newJoineesCurrentMonth.length
            }
        });
    } catch (error) {
        console.error('getAnnouncementCommunity error:', error);
        return res.status(500).json({ message: 'Failed to load announcement community data.' });
    }
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
