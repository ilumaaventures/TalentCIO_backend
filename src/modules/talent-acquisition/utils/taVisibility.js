const { getUserPermissionKeys, isHiringRequestAdmin } = require('./hiringRequestAccess');
const { sanitizeCandidateForInterviewer } = require('./taAccess');

const CONFIDENTIAL_CLIENT_LABEL = 'Confidential Client';

const maskEmail = (value = '') => {
    const normalized = String(value || '').trim();
    const [localPart, domainPart] = normalized.split('@');
    if (!localPart || !domainPart) {
        return normalized;
    }

    const visiblePrefix = localPart.slice(0, 1);
    return `${visiblePrefix}***@${domainPart}`;
};

const maskPhone = (value = '') => {
    const normalized = String(value || '').replace(/\D/g, '');
    if (normalized.length <= 4) {
        return normalized;
    }

    return `${normalized.slice(0, 2)}******${normalized.slice(-2)}`;
};

const omitFields = (value, fieldNames = []) => {
    if (!value || typeof value !== 'object') {
        return value;
    }

    const clone = { ...value };
    fieldNames.forEach((fieldName) => {
        delete clone[fieldName];
    });
    return clone;
};

const canViewConfidentialClient = (user) => {
    const permissions = getUserPermissionKeys(user);
    return isHiringRequestAdmin(user)
        || permissions.includes('ta.requisition.view.client_name')
        || permissions.includes('ta.client.confidential.view')
        || permissions.includes('*');
};

const canViewCandidatePII = (user) => {
    const permissions = getUserPermissionKeys(user);
    return isHiringRequestAdmin(user)
        || permissions.includes('ta.candidate.sensitive.view')
        || permissions.includes('*');
};

const canViewBudget = (user) => {
    const permissions = getUserPermissionKeys(user);
    return isHiringRequestAdmin(user) || permissions.includes('ta.requisition.view.budget') || permissions.includes('*');
};

const canDownloadResume = (user) => {
    const permissions = getUserPermissionKeys(user);
    return isHiringRequestAdmin(user) || permissions.includes('ta.resume.download') || permissions.includes('*');
};

const canViewOfferDetails = (user) => {
    const permissions = getUserPermissionKeys(user);
    return isHiringRequestAdmin(user)
        || permissions.includes('ta.candidate.make_decision')
        || permissions.includes('ta.candidate.manage.assigned')
        || permissions.includes('ta.candidate.manage.all')
        || permissions.includes('*');
};

const canViewAllInterviewFeedback = (user) => {
    const permissions = getUserPermissionKeys(user);
    return isHiringRequestAdmin(user)
        || permissions.includes('ta.interview.feedback.view_all')
        || permissions.includes('ta.candidate.manage.all')
        || permissions.includes('*');
};

const canViewCandidateDetailsPage = (user) => {
    if (!user) return false;
    if (isHiringRequestAdmin(user) || user.isAdmin || user.isSystemAdmin || user.isSuperAdmin || user.hasAllPermissions) {
        return true;
    }
    const permissions = getUserPermissionKeys(user);
    return permissions.includes('*')
        || permissions.includes('admin')
        || permissions.includes('ta.candidate.manage.all')
        || permissions.includes('ta.candidate.manage.assigned')
        || permissions.includes('ta.candidate.view')
        || permissions.includes('ta.view')
        || permissions.includes('ta.create')
        || permissions.includes('ta.edit');
};

const normalizeId = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        if ('_id' in value && value._id && value._id !== value) {
            return normalizeId(value._id);
        }
        if (value.buffer && (value.buffer instanceof Uint8Array || Array.isArray(value.buffer) || ArrayBuffer.isView(value.buffer))) {
            const buf = Uint8Array.from(value.buffer);
            if (buf.length === 12) {
                return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
            }
        }
        if (typeof value.toString === 'function') {
            const str = value.toString();
            if (str !== '[object Object]') return str;
        }
    }
    const strVal = String(value);
    return strVal === '[object Object]' ? '' : strVal;
};

const canViewRoundFeedback = (round, user, candidate = null) => {
    const userId = normalizeId(user?._id);
    if (!userId || !round) {
        return false;
    }

    const assignedToIds = Array.isArray(round.assignedTo) ? round.assignedTo.map(normalizeId) : [];
    if (assignedToIds.includes(userId) || normalizeId(round.evaluatedBy) === userId) {
        return true;
    }

    if (candidate && Array.isArray(candidate.interviewRounds)) {
        const isUserAssignedToAnyRound = candidate.interviewRounds.some(r => {
            const rAssigned = Array.isArray(r.assignedTo) ? r.assignedTo.map(normalizeId) : [];
            return rAssigned.includes(userId) || normalizeId(r.evaluatedBy) === userId;
        });
        if (isUserAssignedToAnyRound) {
            return true;
        }
    }

    return false;
};

const serializeHiringRequestForViewer = (request, user) => {
    if (!request) return request;

    const serialized = {
        ...request,
        hiringDetails: request.hiringDetails ? { ...request.hiringDetails } : request.hiringDetails
    };

    if (serialized.clientConfidential && !canViewConfidentialClient(user)) {
        serialized.client = CONFIDENTIAL_CLIENT_LABEL;
    }

    if (serialized.hiringDetails?.budgetRange && !canViewBudget(user)) {
        serialized.hiringDetails = {
            ...serialized.hiringDetails,
            budgetRange: {
                ...serialized.hiringDetails.budgetRange,
                min: null,
                max: null,
                currency: null,
                isOpen: false,
                isHidden: true
            }
        };
    }

    return serialized;
};

const serializeCandidateForViewer = ({
    candidate,
    user,
    hiringRequest = null,
    interviewerOnly = false
}) => {
    if (!candidate) return candidate;

    let serialized = interviewerOnly
        ? sanitizeCandidateForInterviewer(candidate)
        : { ...candidate };

    if (!canViewCandidatePII(user)) {
        if (serialized.email) {
            serialized.email = maskEmail(serialized.email);
        }
        if (serialized.mobile) {
            serialized.mobile = maskPhone(serialized.mobile);
        }
        if (serialized.applicantId && typeof serialized.applicantId === 'object') {
            serialized.applicantId = {
                ...serialized.applicantId,
                email: serialized.applicantId.email ? maskEmail(serialized.applicantId.email) : serialized.applicantId.email,
                mobile: serialized.applicantId.mobile ? maskPhone(serialized.applicantId.mobile) : serialized.applicantId.mobile
            };
        }
    }

    if (!canDownloadResume(user)) {
        serialized = omitFields(serialized, ['resumeUrl', 'resumePublicId']);
    }

    if (!canViewOfferDetails(user)) {
        serialized = {
            ...serialized,
            offerCompany: undefined,
            offerCTC: undefined,
            offerJoiningDate: undefined
        };
    }

    if (!canViewAllInterviewFeedback(user)) {
        const userId = normalizeId(user?._id);
        const isUserAssignedToAnyRound = Array.isArray(serialized.interviewRounds) &&
            serialized.interviewRounds.some(r => {
                const rAssigned = Array.isArray(r.assignedTo) ? r.assignedTo.map(normalizeId) : [];
                return rAssigned.includes(userId) || normalizeId(r.evaluatedBy) === userId;
            });

        if (Array.isArray(serialized.interviewRounds)) {
            serialized.interviewRounds = serialized.interviewRounds.map((round) => {
                if (canViewRoundFeedback(round, user, serialized)) {
                    return round;
                }

                return {
                    ...round,
                    feedback: '',
                    rating: undefined,
                    evaluatedBy: undefined,
                    evaluatedAt: undefined,
                    skillRatings: []
                };
            });
        }

        if (!isUserAssignedToAnyRound && serialized.phase2InterviewerFeedback !== undefined) {
            serialized.phase2InterviewerFeedback = '';
        }
    }

    if (serialized.hiringRequestId && typeof serialized.hiringRequestId === 'object') {
        serialized.hiringRequestId = serializeHiringRequestForViewer(
            { ...serialized.hiringRequestId, ...(hiringRequest || {}) },
            user
        );
    } else if (hiringRequest) {
        serialized.hiringRequest = serializeHiringRequestForViewer(hiringRequest, user);
    }

    return serialized;
};

module.exports = {
    canViewConfidentialClient,
    canViewCandidatePII,
    canViewBudget,
    canDownloadResume,
    canViewOfferDetails,
    canViewAllInterviewFeedback,
    canViewRoundFeedback,
    canViewCandidateDetailsPage,
    serializeCandidateForViewer,
    serializeHiringRequestForViewer
};
