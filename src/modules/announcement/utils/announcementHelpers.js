const Announcement = require('../announcement.model');
const User = require('../../../modules/user/user.model');
const NotificationService = require('../../../services/notificationService');

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

const setPrivateCache = (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
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
            label: count ? `${count} Selected User${count === 1 ? '' : 's'}` : 'Specific Users'
        };
    }

    return {
        type: 'all',
        label: 'All Employees'
    };
};

const isUserInAudience = (announcement = {}, user = {}) => {
    if (announcement.audienceType === 'all') return true;

    if (announcement.audienceType === 'departments') {
        const userDept = normalizeString(user.department);
        return announcement.audienceDepartments?.some(dept => normalizeString(dept).toLowerCase() === userDept.toLowerCase());
    }

    if (announcement.audienceType === 'employmentTypes') {
        const userEmpType = normalizeString(user.employmentType);
        return announcement.audienceEmploymentTypes?.some(type => normalizeString(type).toLowerCase() === userEmpType.toLowerCase());
    }

    if (announcement.audienceType === 'specificUsers') {
        const userId = String(user._id || '');
        return announcement.audienceUserIds?.some(id => String(id._id || id) === userId);
    }

    return true;
};

const buildUserDisplayName = (user = {}) => {
    const firstName = normalizeString(user.firstName);
    const lastName = normalizeString(user.lastName);
    const fullName = `${firstName} ${lastName}`.trim();
    return fullName || user.email || 'Team Member';
};

const buildAnnouncementScopeQuery = (companyId, user = {}) => {
    const isManager = canManageAnnouncements(user);
    if (isManager) {
        return { companyId };
    }

    const userId = user._id;
    const userDept = user.department;
    const userEmpType = user.employmentType;

    const audienceConditions = [
        { audienceType: 'all' },
        { audienceType: 'specificUsers', audienceUserIds: userId }
    ];

    if (userDept) {
        audienceConditions.push({ audienceType: 'departments', audienceDepartments: userDept });
    }

    if (userEmpType) {
        audienceConditions.push({ audienceType: 'employmentTypes', audienceEmploymentTypes: userEmpType });
    }

    return {
        companyId,
        status: 'published',
        $or: audienceConditions
    };
};

const sanitizeUser = (user = {}) => ({
    _id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    profilePicture: user.profilePicture || '',
    department: user.department || '',
    employmentType: user.employmentType || ''
});

const formatReactionItem = (reaction = {}, currentUserId = '') => {
    const userIdObj = reaction.userId && typeof reaction.userId === 'object' ? reaction.userId : {};
    const userId = String(userIdObj._id || reaction.userId || '');

    return {
        _id: reaction._id,
        type: reaction.type,
        createdAt: reaction.createdAt,
        user: {
            _id: userId,
            firstName: userIdObj.firstName || '',
            lastName: userIdObj.lastName || '',
            profilePicture: userIdObj.profilePicture || ''
        },
        isSelf: userId === String(currentUserId || '')
    };
};

const formatCommentItem = (comment = {}, currentUserId = '', isManager = false) => {
    const userIdObj = comment.userId && typeof comment.userId === 'object' ? comment.userId : {};
    const userId = String(userIdObj._id || comment.userId || '');
    const isOwner = userId === String(currentUserId || '');

    return {
        _id: comment._id,
        commentText: comment.commentText,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        user: {
            _id: userId,
            firstName: userIdObj.firstName || '',
            lastName: userIdObj.lastName || '',
            email: userIdObj.email || '',
            profilePicture: userIdObj.profilePicture || '',
            department: userIdObj.department || '',
            employmentType: userIdObj.employmentType || ''
        },
        canDelete: isOwner || isManager
    };
};

const formatAnnouncementResponse = (announcementDoc, user = {}) => {
    const announcement = typeof announcementDoc.toObject === 'function'
        ? announcementDoc.toObject({ virtuals: true })
        : announcementDoc;

    const currentUserId = String(user._id || '');
    const isManager = canManageAnnouncements(user);
    const audienceSummary = buildAudienceSummary(announcement);

    const userReaction = (announcement.reactions || []).find(
        (reaction) => String(reaction.userId?._id || reaction.userId || '') === currentUserId
    );

    const reactionsCount = (announcement.reactions || []).length;
    const commentsCount = (announcement.comments || []).length;
    const isAcknowledged = (announcement.acknowledgements || []).some(
        (ack) => String(ack.userId?._id || ack.userId || '') === currentUserId
    );

    const canViewReactions = canViewAnnouncementReactions(user);
    const formattedReactions = canViewReactions
        ? (announcement.reactions || []).map((reaction) => formatReactionItem(reaction, currentUserId))
        : [];

    const formattedComments = (announcement.comments || []).map(
        (comment) => formatCommentItem(comment, currentUserId, isManager)
    );

    let audienceUserIds = [];
    if (announcement.audienceType === 'specificUsers' && Array.isArray(announcement.audienceUserIds)) {
        audienceUserIds = announcement.audienceUserIds.map((audienceUser) => {
            if (audienceUser && typeof audienceUser === 'object') {
                return sanitizeUser(audienceUser);
            }
            return { _id: audienceUser };
        });
    }

    return {
        _id: announcement._id,
        companyId: announcement.companyId,
        title: announcement.title,
        summary: announcement.summary || '',
        content: announcement.content,
        category: announcement.category || 'General',
        priority: announcement.priority || 'medium',
        status: announcement.status || 'published',
        audienceType: announcement.audienceType || 'all',
        audienceDepartments: announcement.audienceDepartments || [],
        audienceEmploymentTypes: announcement.audienceEmploymentTypes || [],
        audienceUserIds,
        audienceSummary,
        pinned: Boolean(announcement.pinned || announcement.isPinned),
        isPinned: Boolean(announcement.pinned || announcement.isPinned),
        pinnedAt: announcement.pinnedAt || null,
        pinExpiresAt: announcement.pinExpiresAt || announcement.expiresAt || null,
        scheduledFor: announcement.scheduledFor || null,
        publishedAt: announcement.publishedAt || null,
        isRecurring: Boolean(announcement.isRecurring),
        recurringInterval: announcement.recurringInterval || null,
        requireAcknowledgement: Boolean(announcement.requireAcknowledgement),
        isAcknowledged,
        acknowledgementsCount: (announcement.acknowledgements || []).length,
        attachment: announcement.attachment || null,
        createdBy: announcement.createdBy && typeof announcement.createdBy === 'object'
            ? sanitizeUser(announcement.createdBy)
            : { _id: announcement.createdBy },
        updatedBy: announcement.updatedBy && typeof announcement.updatedBy === 'object'
            ? sanitizeUser(announcement.updatedBy)
            : { _id: announcement.updatedBy },
        reactionsCount,
        commentsCount,
        userReactionType: userReaction ? userReaction.type : null,
        reactions: formattedReactions,
        comments: formattedComments,
        canManage: isManager,
        canEdit: isManager,
        canDelete: isManager,
        canComment: canCommentOnAnnouncement(user),
        canReact: canReactToAnnouncement(user),
        createdAt: announcement.createdAt,
        updatedAt: announcement.updatedAt
    };
};

const emitAnnouncementSocketEvent = (req, eventName, payload) => {
    try {
        const io = req.app?.get('io');
        if (!io || !req.companyId) return;

        const roomName = `company:${req.companyId}`;
        io.to(roomName).emit(eventName, payload);
    } catch (error) {
        console.error(`Failed to emit socket event ${eventName}:`, error);
    }
};

const fetchPopulatedAnnouncementById = async (announcementId) => {
    const query = Announcement.findById(announcementId);
    applyAnnouncementPopulation(query);
    return query.exec();
};

const notifyPublishedAnnouncement = async ({ req, announcement }) => {
    try {
        const io = req.app.get('io');
        const authorName = buildUserDisplayName(announcement.createdBy);
        let userFilter = { companyId: req.companyId, isActive: true, _id: { $ne: req.user._id } };

        if (announcement.audienceType === 'specificUsers') {
            const recipientIds = (announcement.audienceUserIds || [])
                .map((u) => String(u._id || u))
                .filter((id) => id !== String(req.user._id));
            if (!recipientIds.length) return;
            userFilter._id = { $in: recipientIds };
        } else if (announcement.audienceType === 'departments') {
            const depts = announcement.audienceDepartments || [];
            if (!depts.length) return;
            userFilter.department = { $in: depts };
        } else if (announcement.audienceType === 'employmentTypes') {
            const types = announcement.audienceEmploymentTypes || [];
            if (!types.length) return;
            userFilter.employmentType = { $in: types };
        }

        const users = await User.find(userFilter).select('_id').lean();
        if (users.length > 0) {
            const notifications = users.map(u => ({
                user: u._id,
                companyId: req.companyId,
                preferenceKey: 'announcement_published',
                title: `New Announcement: ${announcement.title}`,
                message: `${authorName} published an announcement in ${announcement.category}.`,
                type: 'Info',
                link: '/announcements',
                origin: req.headers?.origin || ''
            }));
            await NotificationService.createManyNotifications(io, notifications);
        }

        emitAnnouncementSocketEvent(req, 'announcement:published', {
            announcementId: announcement._id,
            title: announcement.title,
            category: announcement.category,
            audienceType: announcement.audienceType,
            publishedAt: announcement.publishedAt
        });
    } catch (error) {
        console.error('Failed to notify users about published announcement:', error);
    }
};

const buildVisibleAnnouncementQuery = ({ companyId, user = {} } = {}) => {
    return buildAnnouncementScopeQuery(companyId, user);
};

const serializeAnnouncement = (announcementDoc, user = {}, isManager = false) => {
    const isUserManager = isManager || canManageAnnouncements(user);
    const response = formatAnnouncementResponse(announcementDoc, user);
    response.canManage = isUserManager;
    response.canEdit = isUserManager;
    response.canDelete = isUserManager;
    return response;
};

const serializeCommunityMember = (user = {}, extra = {}) => {
    return {
        ...sanitizeUser(user),
        ...extra
    };
};

const isAnnouncementExpired = (announcement = {}) => {
    if (!announcement.expiresAt && !announcement.pinExpiresAt) return false;
    const expiry = announcement.expiresAt || announcement.pinExpiresAt;
    const expiryDate = toValidDate(expiry);
    return Boolean(expiryDate && expiryDate.getTime() < Date.now());
};

const buildUploadedAttachment = (file) => {
    if (!file) return null;
    const url = file.path || file.secure_url || file.url || '';
    const publicId = file.filename || file.public_id || '';
    return {
        url,
        name: file.originalname || file.name || 'Attachment',
        publicId,
        resourceType: file.resource_type || (file.mimetype?.startsWith('image/') ? 'image' : 'raw'),
        mimeType: file.mimetype || file.mimeType || '',
        size: file.size || 0,
        uploadedAt: new Date()
    };
};

const destroyAnnouncementAttachment = async (attachment) => {
    if (!attachment || !attachment.publicId) return;
    try {
        const cloudinary = require('cloudinary').v2;
        await cloudinary.uploader.destroy(attachment.publicId, {
            resource_type: attachment.resourceType || 'raw'
        });
    } catch (err) {
        console.error('destroyAnnouncementAttachment error:', err);
    }
};

const buildAnnouncementPayload = (body = {}) => {
    const isPinnedValue = parseBoolean(body.pinned !== undefined ? body.pinned : body.isPinned);
    return {
        title: normalizeString(body.title),
        summary: normalizeString(body.summary),
        content: normalizeString(body.content),
        category: normalizeString(body.category) || 'General',
        priority: normalizeString(body.priority) || 'medium',
        status: normalizeString(body.status) || 'published',
        audienceType: normalizeString(body.audienceType) || 'all',
        audienceDepartments: parseArrayValue(body.audienceDepartments),
        audienceEmploymentTypes: parseArrayValue(body.audienceEmploymentTypes),
        audienceUserIds: normalizeAudienceUserObjectIds(parseArrayValue(body.audienceUserIds)),
        pinned: isPinnedValue,
        isPinned: isPinnedValue,
        pinnedAt: isPinnedValue ? new Date() : null,
        pinExpiresAt: toValidDate(body.pinExpiresAt || body.expiresAt),
        expiresAt: toValidDate(body.expiresAt || body.pinExpiresAt),
        scheduledFor: toValidDate(body.scheduledFor),
        isRecurring: parseBoolean(body.isRecurring),
        recurringInterval: normalizeString(body.recurringInterval) || null,
        requireAcknowledgement: parseBoolean(body.requireAcknowledgement)
    };
};

const validateAnnouncementPayload = async (payload = {}) => {
    if (!payload.title) return 'Announcement title is required.';
    if (exceedsMaxLength(payload.title, ANNOUNCEMENT_FIELD_LIMITS.title)) {
        return `Title cannot exceed ${ANNOUNCEMENT_FIELD_LIMITS.title} characters.`;
    }
    if (payload.summary && exceedsMaxLength(payload.summary, ANNOUNCEMENT_FIELD_LIMITS.summary)) {
        return `Summary cannot exceed ${ANNOUNCEMENT_FIELD_LIMITS.summary} characters.`;
    }
    if (!payload.content) return 'Announcement content is required.';
    if (exceedsMaxLength(payload.content, ANNOUNCEMENT_FIELD_LIMITS.content)) {
        return `Content cannot exceed ${ANNOUNCEMENT_FIELD_LIMITS.content} characters.`;
    }
    if (payload.category && !ANNOUNCEMENT_CATEGORIES.includes(payload.category)) {
        return `Invalid category. Must be one of: ${ANNOUNCEMENT_CATEGORIES.join(', ')}.`;
    }
    return null;
};

module.exports = {
    ANNOUNCEMENT_CATEGORIES,
    AUDIENCE_TYPES,
    REACTION_TYPES,
    MANAGER_ROLE_NAMES,
    EMPLOYMENT_TYPES,
    ANNOUNCEMENT_COMMUNITY_SECTION_PERMISSIONS,
    ANNOUNCEMENT_FIELD_LIMITS,
    setPrivateCache,
    monthDayFormatter,
    normalizeString,
    parseBoolean,
    parseArrayValue,
    exceedsMaxLength,
    toValidDate,
    isSameCalendarMonth,
    isSameRecurringMonth,
    isSameMonthDay,
    getYearsCompleted,
    getTransferredOnboardingRecord,
    getBirthdayDateValue,
    getCurrentMonthDateValue,
    normalizeStringArray,
    normalizeAudienceUserObjectIds,
    getUserRoleNames,
    canManageAnnouncements,
    canReactToAnnouncement,
    canCommentOnAnnouncement,
    canViewAnnouncementReactions,
    hasAnnouncementCommunityPermission,
    canViewAnnouncementCommunitySection,
    announcementPopulatePaths,
    applyAnnouncementPopulation,
    buildAudienceSummary,
    isUserInAudience,
    buildUserDisplayName,
    buildAnnouncementScopeQuery,
    buildVisibleAnnouncementQuery,
    serializeAnnouncement,
    serializeCommunityMember,
    isAnnouncementExpired,
    buildUploadedAttachment,
    destroyAnnouncementAttachment,
    buildAnnouncementPayload,
    validateAnnouncementPayload,
    sanitizeUser,
    formatReactionItem,
    formatCommentItem,
    formatAnnouncementResponse,
    emitAnnouncementSocketEvent,
    fetchPopulatedAnnouncementById,
    notifyPublishedAnnouncement
};
