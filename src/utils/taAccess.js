const Candidate = require('../models/Candidate');
const { HiringRequest } = require('../models/HiringRequest');
const { getAssignedClientNames, getUserPermissionKeys, hasAssignedClientAccess, isHiringRequestAdmin } = require('./hiringRequestAccess');

const TA_CAPABILITIES = {
    VIEW: 'candidate.view',
    EDIT: 'candidate.edit',
    EVALUATE_ROUND: 'candidate.evaluate_round',
    MAKE_DECISION: 'candidate.make_decision',
    TRANSFER: 'candidate.transfer',
    CONFIG_MANAGE: 'ta.config.manage'
};

const GLOBAL_CAPABILITY_PERMISSION_MAP = {
    [TA_CAPABILITIES.VIEW]: ['ta.candidate.manage.all', 'ta.view', 'ta.edit'],
    [TA_CAPABILITIES.EDIT]: ['ta.candidate.manage.all', 'ta.edit'],
    [TA_CAPABILITIES.EVALUATE_ROUND]: ['ta.candidate.manage.all', 'ta.edit'],
    [TA_CAPABILITIES.MAKE_DECISION]: ['ta.candidate.manage.all', 'ta.decision', 'ta.edit'],
    [TA_CAPABILITIES.TRANSFER]: ['ta.candidate.manage.all', 'ta.bulk_transfer', 'ta.edit'],
    [TA_CAPABILITIES.CONFIG_MANAGE]: ['ta.config.manage', 'ta.edit', 'ta.email_template.manage', 'role.update', 'role.create']
};

const ASSIGNED_CAPABILITY_PERMISSION_MAP = {
    [TA_CAPABILITIES.VIEW]: ['ta.candidate.manage.assigned', 'ta.candidate.view'],
    [TA_CAPABILITIES.EDIT]: ['ta.candidate.manage.assigned', 'ta.candidate.edit'],
    [TA_CAPABILITIES.EVALUATE_ROUND]: ['ta.candidate.manage.assigned', 'ta.candidate.evaluate_round', 'ta.candidate.edit'],
    [TA_CAPABILITIES.MAKE_DECISION]: ['ta.candidate.manage.assigned', 'ta.candidate.make_decision', 'ta.candidate.edit'],
    [TA_CAPABILITIES.TRANSFER]: ['ta.candidate.manage.assigned', 'ta.candidate.transfer']
};

const MINIMUM_INTERVIEWER_CANDIDATE_FIELDS = [
    '_id',
    'candidateName',
    'email',
    'mobile',
    'resumeUrl',
    'resumePublicId',
    'uploadedAt',
    'currentCompany',
    'totalExperience',
    'qualification',
    'pastExperience',
    'currentLocation',
    'preferredLocation',
    'noticePeriod',
    'tatToJoin',
    'lastWorkingDay',
    'mustHaveSkills',
    'niceToHaveSkills',
    'skillRatings',
    'interviewRounds',
    'hiringRequestId',
    'applicantId',
    'profileSnapshot',
    'publicApplicationId'
];

const normalizeId = (value) => String(value?._id || value || '');

const hasGlobalCapabilityPermission = (user, capability) => {
    const permissions = getUserPermissionKeys(user);
    if (permissions.includes('*')) {
        return true;
    }

    const allowedPermissions = GLOBAL_CAPABILITY_PERMISSION_MAP[capability] || [];
    return allowedPermissions.some((permission) => permissions.includes(permission));
};

const hasAssignedCapabilityPermission = (user, capability) => {
    const permissions = getUserPermissionKeys(user);
    const allowedPermissions = ASSIGNED_CAPABILITY_PERMISSION_MAP[capability] || [];
    return allowedPermissions.some((permission) => permissions.includes(permission));
};

const hasCapabilityPermission = (user, capability) => (
    hasGlobalCapabilityPermission(user, capability) || hasAssignedCapabilityPermission(user, capability)
);

const getHiringRequestActorState = (hiringRequest, user) => {
    const userId = normalizeId(user?._id);
    const assignedUserIds = Array.isArray(hiringRequest?.assignedUsers)
        ? hiringRequest.assignedUsers.map(normalizeId)
        : [];
    const analyticsViewerIds = Array.isArray(hiringRequest?.analyticsViewers)
        ? hiringRequest.analyticsViewers.map(normalizeId)
        : [];
    const interviewPanelIds = Array.isArray(hiringRequest?.ownership?.interviewPanel)
        ? hiringRequest.ownership.interviewPanel.map(normalizeId)
        : [];

    return {
        isOwner: normalizeId(hiringRequest?.createdBy) === userId,
        isHiringManager: normalizeId(hiringRequest?.ownership?.hiringManager) === userId,
        isAssignedRecruiter: normalizeId(hiringRequest?.ownership?.recruiter) === userId,
        isAssignedUser: assignedUserIds.includes(userId),
        isAnalyticsViewer: analyticsViewerIds.includes(userId),
        isInterviewPanel: interviewPanelIds.includes(userId),
        isClientAssigned: hasAssignedClientAccess(hiringRequest, user)
    };
};

const isCandidateRoundAssignee = (candidate, user, roundId = null) => {
    const userId = normalizeId(user?._id);
    const rounds = Array.isArray(candidate?.interviewRounds) ? candidate.interviewRounds : [];
    return rounds.some((round) => {
        if (roundId && normalizeId(round?._id) !== normalizeId(roundId)) {
            return false;
        }

        return Array.isArray(round?.assignedTo) && round.assignedTo.map(normalizeId).includes(userId);
    });
};

const canAccessHiringRequestForCapability = (hiringRequest, user, capability = TA_CAPABILITIES.VIEW) => {
    if (!hiringRequest || !user?._id) {
        return false;
    }

    if (isHiringRequestAdmin(user) || hasGlobalCapabilityPermission(user, capability)) {
        return true;
    }

    const actors = getHiringRequestActorState(hiringRequest, user);

    switch (capability) {
        case TA_CAPABILITIES.VIEW:
            return actors.isOwner
                || actors.isHiringManager
                || actors.isAssignedRecruiter
                || actors.isAssignedUser
                || actors.isInterviewPanel
                || actors.isClientAssigned;
        case TA_CAPABILITIES.EDIT:
            return actors.isOwner
                || actors.isHiringManager
                || actors.isAssignedRecruiter
                || actors.isAssignedUser
                || actors.isClientAssigned;
        case TA_CAPABILITIES.MAKE_DECISION:
            return actors.isOwner
                || actors.isHiringManager
                || actors.isAssignedRecruiter
                || actors.isClientAssigned;
        case TA_CAPABILITIES.TRANSFER:
            return actors.isOwner
                || actors.isHiringManager
                || actors.isAssignedRecruiter
                || actors.isAssignedUser
                || actors.isClientAssigned;
        case TA_CAPABILITIES.CONFIG_MANAGE:
            return false;
        default:
            return false;
    }
};

const canAccessCandidateThroughHiringRequest = async ({
    candidate,
    hiringRequest,
    companyId,
    user,
    capability = TA_CAPABILITIES.VIEW,
    roundId = null
}) => {
    if (!candidate || !user?._id) {
        return false;
    }

    if (isHiringRequestAdmin(user)) {
        return true;
    }

    let resolvedHiringRequest = hiringRequest;
    if (!resolvedHiringRequest) {
        resolvedHiringRequest = await HiringRequest.findOne({
            _id: candidate.hiringRequestId?._id || candidate.hiringRequestId,
            companyId
        })
            .select('createdBy ownership assignedUsers analyticsViewers')
            .lean();
    }

    if (capability === TA_CAPABILITIES.EVALUATE_ROUND) {
        if (isCandidateRoundAssignee(candidate, user, roundId)) {
            return true;
        }

        return hasCapabilityPermission(user, capability)
            && canAccessHiringRequestForCapability(resolvedHiringRequest, user, TA_CAPABILITIES.EDIT);
    }

    if (hasGlobalCapabilityPermission(user, capability)) {
        return true;
    }

    if (capability === TA_CAPABILITIES.VIEW && isCandidateRoundAssignee(candidate, user, roundId)) {
        return true;
    }

    return canAccessHiringRequestForCapability(resolvedHiringRequest, user, capability);
};

const buildAccessibleCandidateQueryForCapability = async (
    companyId,
    user,
    extraQuery = {},
    capability = TA_CAPABILITIES.VIEW
) => {
    const baseQuery = {
        companyId,
        ...extraQuery
    };

    if (capability === TA_CAPABILITIES.EVALUATE_ROUND) {
        return {
            $and: [
                baseQuery,
                { 'interviewRounds.assignedTo': user._id }
            ]
        };
    }

    if (isHiringRequestAdmin(user) || hasGlobalCapabilityPermission(user, capability)) {
        return baseQuery;
    }

    const requestMatch = { companyId };
    const assignedClientNames = getAssignedClientNames(user);
    if (capability === TA_CAPABILITIES.VIEW) {
        requestMatch.$or = [
            { createdBy: user._id },
            { 'ownership.hiringManager': user._id },
            { 'ownership.recruiter': user._id },
            { assignedUsers: user._id },
            { 'ownership.interviewPanel': user._id }
        ];
    } else if (capability === TA_CAPABILITIES.EDIT) {
        requestMatch.$or = [
            { createdBy: user._id },
            { 'ownership.hiringManager': user._id },
            { 'ownership.recruiter': user._id },
            { assignedUsers: user._id }
        ];
    } else if (capability === TA_CAPABILITIES.MAKE_DECISION) {
        requestMatch.$or = [
            { createdBy: user._id },
            { 'ownership.hiringManager': user._id },
            { 'ownership.recruiter': user._id }
        ];
    } else if (capability === TA_CAPABILITIES.TRANSFER) {
        requestMatch.$or = [
            { createdBy: user._id },
            { 'ownership.hiringManager': user._id },
            { 'ownership.recruiter': user._id },
            { assignedUsers: user._id }
        ];
    }
    if (requestMatch.$or && assignedClientNames.length > 0) {
        requestMatch.$or.push({ client: { $in: assignedClientNames } });
    }

    const accessibleRequestIds = requestMatch.$or
        ? await HiringRequest.find(requestMatch).distinct('_id')
        : [];

    const accessOr = [];
    if (accessibleRequestIds.length > 0) {
        accessOr.push({ hiringRequestId: { $in: accessibleRequestIds } });
    }

    if (capability === TA_CAPABILITIES.VIEW) {
        accessOr.push({ 'interviewRounds.assignedTo': user._id });
    }

    if (!accessOr.length) {
        return {
            $and: [
                baseQuery,
                { _id: { $in: [] } }
            ]
        };
    }

    return {
        $and: [
            baseQuery,
            { $or: accessOr }
        ]
    };
};

const isInterviewerOnlyView = async ({ candidate, hiringRequest, companyId, user }) => {
    if (!candidate || !user?._id) return false;
    if (!isCandidateRoundAssignee(candidate, user)) return false;

    const hasParentViewAccess = canAccessHiringRequestForCapability(
        hiringRequest || await HiringRequest.findOne({
            _id: candidate.hiringRequestId?._id || candidate.hiringRequestId,
            companyId
        }).select('createdBy ownership assignedUsers analyticsViewers').lean(),
        user,
        TA_CAPABILITIES.VIEW
    );

    return !hasParentViewAccess;
};

const sanitizeCandidateForInterviewer = (candidate) => {
    if (!candidate) return candidate;

    return MINIMUM_INTERVIEWER_CANDIDATE_FIELDS.reduce((accumulator, field) => {
        if (candidate[field] !== undefined) {
            accumulator[field] = candidate[field];
        }
        return accumulator;
    }, {});
};

module.exports = {
    TA_CAPABILITIES,
    MINIMUM_INTERVIEWER_CANDIDATE_FIELDS,
    buildAccessibleCandidateQueryForCapability,
    canAccessCandidateThroughHiringRequest,
    canAccessHiringRequestForCapability,
    hasCapabilityPermission,
    hasAssignedCapabilityPermission,
    hasGlobalCapabilityPermission,
    isCandidateRoundAssignee,
    isInterviewerOnlyView,
    sanitizeCandidateForInterviewer
};
