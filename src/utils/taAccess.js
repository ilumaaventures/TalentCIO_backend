const Candidate = require('../models/Candidate');
const { HiringRequest } = require('../models/HiringRequest');
const { getAssignedClientNames, getUserPermissionKeys, hasAssignedClientAccess, isHiringRequestAdmin } = require('./hiringRequestAccess');
const { buildTABacHiringRequestConstraint, getTABacActionForCapability, matchesTABacHiringRequest } = require('./taABAC');

const TA_CAPABILITIES = {
    VIEW: 'candidate.view',
    EDIT: 'candidate.edit',
    SCHEDULE_INTERVIEW: 'candidate.schedule_interview',
    EVALUATE_ROUND: 'candidate.evaluate_round',
    MAKE_DECISION: 'candidate.make_decision',
    TRANSFER: 'candidate.transfer',
    CONFIG_ACCESS: 'ta.config.access'
};

const GLOBAL_CAPABILITY_PERMISSION_MAP = {
    [TA_CAPABILITIES.VIEW]: ['ta.candidate.manage.all', 'ta.view'],
    [TA_CAPABILITIES.EDIT]: ['ta.candidate.manage.all', 'ta.edit'],
    [TA_CAPABILITIES.SCHEDULE_INTERVIEW]: ['ta.candidate.manage.all', 'ta.edit'],
    [TA_CAPABILITIES.EVALUATE_ROUND]: ['ta.candidate.manage.all', 'ta.interview.evaluate'],
    [TA_CAPABILITIES.MAKE_DECISION]: ['ta.candidate.manage.all'],
    [TA_CAPABILITIES.TRANSFER]: ['ta.candidate.manage.all', 'ta.bulk_transfer'],
    [TA_CAPABILITIES.CONFIG_ACCESS]: ['ta.config.view', 'ta.config.edit']
};

const ASSIGNED_CAPABILITY_PERMISSION_MAP = {
    [TA_CAPABILITIES.VIEW]: ['ta.candidate.manage.assigned', 'ta.candidate.view'],
    [TA_CAPABILITIES.EDIT]: ['ta.candidate.manage.assigned', 'ta.candidate.edit'],
    [TA_CAPABILITIES.SCHEDULE_INTERVIEW]: ['ta.candidate.manage.assigned', 'ta.candidate.edit'],
    [TA_CAPABILITIES.EVALUATE_ROUND]: ['ta.candidate.manage.assigned', 'ta.interview.evaluate', 'ta.candidate.edit'],
    [TA_CAPABILITIES.MAKE_DECISION]: ['ta.candidate.manage.assigned', 'ta.candidate.make_decision', 'ta.candidate.edit'],
    [TA_CAPABILITIES.TRANSFER]: ['ta.candidate.manage.assigned', 'ta.candidate.transfer']
};

const MINIMUM_INTERVIEWER_CANDIDATE_FIELDS = [
    '_id',
    'candidateName',
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
    'hiringRequestId'
];

const normalizeId = (value) => String(value?._id || value || '');

const isCandidateOwnedByUser = (candidate, user) => (
    normalizeId(candidate?.uploadedBy) === normalizeId(user?._id)
);

const isAssignedCandidateRestrictedActor = (actors, capability = TA_CAPABILITIES.VIEW) => {
    if (!actors.isAssignedUser || actors.isOwner || actors.isHiringManager || actors.isAnalyticsViewer) {
        return false;
    }

    if (capability === TA_CAPABILITIES.VIEW && actors.isInterviewPanel) {
        return false;
    }

    return true;
};

const hasUnrestrictedCandidateCapabilityPermission = (user, capability) => {
    const permissions = getUserPermissionKeys(user);
    if (permissions.includes('*')) {
        return true;
    }

    if (capability === TA_CAPABILITIES.CONFIG_ACCESS) {
        return false;
    }

    return permissions.includes('ta.candidate.manage.all');
};

const findAccessibleHiringRequestIds = async ({
    companyId,
    user,
    capability,
    requestOr = [],
    includeAssignedClients = false
}) => {
    if (!requestOr.length) {
        return [];
    }

    const requestMatch = {
        companyId,
        $or: [...requestOr]
    };

    if (includeAssignedClients) {
        const assignedClientNames = getAssignedClientNames(user);
        if (assignedClientNames.length > 0) {
            requestMatch.$or.push({ client: { $in: assignedClientNames } });
        }
    }

    const abacConstraint = await buildTABacHiringRequestConstraint({
        companyId,
        user,
        action: getTABacActionForCapability(capability)
    });

    if (abacConstraint) {
        requestMatch.$and = Array.isArray(requestMatch.$and) ? requestMatch.$and : [];
        requestMatch.$and.push(abacConstraint);
    }

    return HiringRequest.find(requestMatch).distinct('_id');
};

const findRestrictedAssignedHiringRequestIds = async ({
    companyId,
    user,
    capability
}) => {
    const assignedClientNames = getAssignedClientNames(user);
    const restrictedQuery = {
        companyId,
        assignedUsers: user._id,
        createdBy: { $ne: user._id },
        'ownership.hiringManager': { $ne: user._id },
        analyticsViewers: { $ne: user._id }
    };

    if (capability === TA_CAPABILITIES.VIEW) {
        restrictedQuery['ownership.interviewPanel'] = { $ne: user._id };
    }

    if (assignedClientNames.length > 0) {
        restrictedQuery.client = { $nin: assignedClientNames };
    }

    const abacConstraint = await buildTABacHiringRequestConstraint({
        companyId,
        user,
        action: getTABacActionForCapability(capability)
    });

    if (abacConstraint) {
        restrictedQuery.$and = Array.isArray(restrictedQuery.$and) ? restrictedQuery.$and : [];
        restrictedQuery.$and.push(abacConstraint);
    }

    return HiringRequest.find(restrictedQuery).distinct('_id');
};

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

const canAccessHiringRequestForCapability = async (hiringRequest, user, capability = TA_CAPABILITIES.VIEW, companyId = null) => {
    if (!hiringRequest || !user?._id) {
        return false;
    }

    if (isHiringRequestAdmin(user) || hasUnrestrictedCandidateCapabilityPermission(user, capability)) {
        return matchesTABacHiringRequest({
            companyId: companyId || hiringRequest.companyId,
            user,
            hiringRequest,
            action: getTABacActionForCapability(capability)
        });
    }

    const actors = getHiringRequestActorState(hiringRequest, user);
    let hasBaseAccess = false;

    switch (capability) {
        case TA_CAPABILITIES.VIEW:
            hasBaseAccess = actors.isOwner
                || actors.isHiringManager
                || actors.isAnalyticsViewer
                || actors.isAssignedUser
                || actors.isInterviewPanel
                || actors.isClientAssigned;
            break;
        case TA_CAPABILITIES.EDIT:
            hasBaseAccess = actors.isOwner
                || actors.isHiringManager
                || actors.isAnalyticsViewer
                || actors.isAssignedUser
                || actors.isClientAssigned;
            break;
        case TA_CAPABILITIES.SCHEDULE_INTERVIEW:
            hasBaseAccess = actors.isOwner
                || actors.isHiringManager
                || actors.isAnalyticsViewer
                || actors.isAssignedUser
                || actors.isClientAssigned;
            break;
        case TA_CAPABILITIES.MAKE_DECISION:
            hasBaseAccess = actors.isOwner
                || actors.isHiringManager
                || actors.isClientAssigned;
            break;
        case TA_CAPABILITIES.TRANSFER:
            hasBaseAccess = actors.isOwner
                || actors.isHiringManager
                || actors.isAssignedUser
                || actors.isClientAssigned;
            break;
        case TA_CAPABILITIES.CONFIG_ACCESS:
            hasBaseAccess = false;
            break;
        default:
            hasBaseAccess = false;
            break;
    }

    if (!hasBaseAccess) {
        return false;
    }

    return matchesTABacHiringRequest({
        companyId: companyId || hiringRequest.companyId,
        user,
        hiringRequest,
        action: getTABacActionForCapability(capability)
    });
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
            && await canAccessHiringRequestForCapability(resolvedHiringRequest, user, TA_CAPABILITIES.EDIT, companyId);
    }

    if (capability === TA_CAPABILITIES.VIEW && isCandidateRoundAssignee(candidate, user, roundId)) {
        return true;
    }

    const actorState = getHiringRequestActorState(resolvedHiringRequest, user);
    if (isAssignedCandidateRestrictedActor(actorState, capability) && !isCandidateOwnedByUser(candidate, user)) {
        return false;
    }

    if (hasUnrestrictedCandidateCapabilityPermission(user, capability) || hasGlobalCapabilityPermission(user, capability)) {
        return true;
    }

    return canAccessHiringRequestForCapability(resolvedHiringRequest, user, capability, companyId);
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

    if (isHiringRequestAdmin(user) || hasUnrestrictedCandidateCapabilityPermission(user, capability)) {
        return baseQuery;
    }

    if (hasGlobalCapabilityPermission(user, capability)) {
        const restrictedAssignedRequestIds = await findRestrictedAssignedHiringRequestIds({
            companyId,
            user,
            capability
        });

        if (!restrictedAssignedRequestIds.length) {
            return baseQuery;
        }

        const globalAccessOr = [
            { hiringRequestId: { $nin: restrictedAssignedRequestIds } },
            {
                hiringRequestId: { $in: restrictedAssignedRequestIds },
                uploadedBy: user._id
            }
        ];

        if (capability === TA_CAPABILITIES.VIEW) {
            globalAccessOr.push({ 'interviewRounds.assignedTo': user._id });
        }

        return {
            $and: [
                baseQuery,
                { $or: globalAccessOr }
            ]
        };
    }

    const broadActorRequestOr = [];
    const assignedRequestOr = [];
    const clientAssignedNames = getAssignedClientNames(user);

    if (capability === TA_CAPABILITIES.VIEW) {
        broadActorRequestOr.push(
            { createdBy: user._id },
            { 'ownership.hiringManager': user._id },
            { analyticsViewers: user._id },
            { 'ownership.interviewPanel': user._id }
        );
        assignedRequestOr.push({ assignedUsers: user._id });
    } else if (capability === TA_CAPABILITIES.EDIT) {
        broadActorRequestOr.push(
            { createdBy: user._id },
            { 'ownership.hiringManager': user._id },
            { analyticsViewers: user._id }
        );
        assignedRequestOr.push({ assignedUsers: user._id });
    } else if (capability === TA_CAPABILITIES.SCHEDULE_INTERVIEW) {
        broadActorRequestOr.push(
            { createdBy: user._id },
            { 'ownership.hiringManager': user._id },
            { analyticsViewers: user._id }
        );
        assignedRequestOr.push({ assignedUsers: user._id });
    } else if (capability === TA_CAPABILITIES.MAKE_DECISION) {
        broadActorRequestOr.push(
            { createdBy: user._id },
            { 'ownership.hiringManager': user._id }
        );
    } else if (capability === TA_CAPABILITIES.TRANSFER) {
        broadActorRequestOr.push(
            { createdBy: user._id },
            { 'ownership.hiringManager': user._id },
            { analyticsViewers: user._id }
        );
        assignedRequestOr.push({ assignedUsers: user._id });
    }

    const accessOr = [];
    const broadActorRequestIds = await findAccessibleHiringRequestIds({
        companyId,
        user,
        capability,
        requestOr: broadActorRequestOr,
        includeAssignedClients: false
    });
    if (broadActorRequestIds.length > 0) {
        accessOr.push({ hiringRequestId: { $in: broadActorRequestIds } });
    }

    const assignedRequestIds = await findAccessibleHiringRequestIds({
        companyId,
        user,
        capability,
        requestOr: assignedRequestOr,
        includeAssignedClients: false
    });
    if (assignedRequestIds.length > 0) {
        accessOr.push({
            hiringRequestId: { $in: assignedRequestIds },
            uploadedBy: user._id
        });
    }

    if (clientAssignedNames.length > 0) {
        const clientAssignedRequestIds = await findAccessibleHiringRequestIds({
            companyId,
            user,
            capability,
            requestOr: [{ client: { $in: clientAssignedNames } }],
            includeAssignedClients: false
        });

        const unrestrictedClientRequestIds = clientAssignedRequestIds.filter(
            (requestId) => !assignedRequestIds.some((assignedId) => normalizeId(assignedId) === normalizeId(requestId))
        );

        if (unrestrictedClientRequestIds.length > 0) {
            accessOr.push({ hiringRequestId: { $in: unrestrictedClientRequestIds } });
        }
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

    const hasParentViewAccess = await canAccessHiringRequestForCapability(
        hiringRequest || await HiringRequest.findOne({
            _id: candidate.hiringRequestId?._id || candidate.hiringRequestId,
            companyId
        }).select('createdBy ownership assignedUsers analyticsViewers').lean(),
        user,
        TA_CAPABILITIES.VIEW,
        companyId
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
