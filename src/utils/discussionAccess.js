const mongoose = require('mongoose');

const normalizeRoleName = (role) => {
    if (!role) return '';
    if (typeof role === 'string') return role;
    return role.name || '';
};

const isDiscussionAdmin = (user) => {
    if (!user) return false;
    return (user.permissions || []).includes('*') || (user.roles || []).some((role) => {
        const roleName = normalizeRoleName(role);
        return role?.isSystem || ['Admin', 'System', 'Super Admin', 'System Admin'].includes(roleName);
    });
};

const toObjectId = (value) => (
    value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value))
);

const idsMatch = (left, right) => String(left || '') === String(right || '');

const isSupervisor = (discussion, userId) => {
    if (!discussion?.supervisor) return false;
    const supervisors = Array.isArray(discussion.supervisor) ? discussion.supervisor : [discussion.supervisor];
    return supervisors.some((s) => idsMatch(s?._id || s, userId));
};

const buildAccessibleDiscussionMatch = (companyId, user) => {
    const match = {
        companyId: toObjectId(companyId)
    };

    if (isDiscussionAdmin(user)) {
        return match;
    }

    const userId = toObjectId(user._id);
    return {
        ...match,
        $or: [
            { createdBy: userId },
            { supervisor: userId },
            { visibleToUsers: userId },
            { participants: userId }
        ]
    };
};

const canAccessDiscussion = (discussion, user) => {
    if (!discussion || !user) return false;
    if (isDiscussionAdmin(user)) return true;

    return (
        idsMatch(discussion.createdBy?._id || discussion.createdBy, user._id) ||
        isSupervisor(discussion, user._id) ||
        (Array.isArray(discussion.visibleToUsers) && discussion.visibleToUsers.some((visibleUser) => idsMatch(visibleUser?._id || visibleUser, user._id))) ||
        (Array.isArray(discussion.participants) && discussion.participants.some((participant) => idsMatch(participant?._id || participant, user._id)))
    );
};

const canEditDiscussion = (discussion, user) => (
    isDiscussionAdmin(user) ||
    idsMatch(discussion?.createdBy?._id || discussion?.createdBy, user?._id) ||
    isSupervisor(discussion, user?._id)
);

const canDeleteDiscussion = (discussion, user) => (
    isDiscussionAdmin(user) ||
    idsMatch(discussion?.createdBy?._id || discussion?.createdBy, user?._id)
);

const canChangeRestrictedDiscussionStatus = (discussion, user) => (
    isDiscussionAdmin(user) ||
    isSupervisor(discussion, user?._id)
);

const buildDiscussionParticipants = (...candidateIds) => {
    const seen = new Set();
    return candidateIds
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .filter(Boolean)
        .map((value) => String(value))
        .filter((value) => {
            if (seen.has(value)) return false;
            seen.add(value);
            return true;
        })
        .map((value) => toObjectId(value));
};

const attachDiscussionPermissions = (discussion, user) => {
    if (!discussion) return discussion;
    return {
        ...discussion,
        canEdit: canEditDiscussion(discussion, user),
        canDelete: canDeleteDiscussion(discussion, user),
        canChangeRestrictedStatus: canChangeRestrictedDiscussionStatus(discussion, user),
        canUpdateStatus: canChangeRestrictedDiscussionStatus(discussion, user)
    };
};

module.exports = {
    attachDiscussionPermissions,
    buildAccessibleDiscussionMatch,
    buildDiscussionParticipants,
    canAccessDiscussion,
    canChangeRestrictedDiscussionStatus,
    canDeleteDiscussion,
    canEditDiscussion,
    isDiscussionAdmin
};
