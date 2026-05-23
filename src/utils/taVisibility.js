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

const normalizeId = (value) => String(value?._id || value || '');

const canViewRoundFeedback = (round, user) => {
    const userId = normalizeId(user?._id);
    if (!userId || !round) {
        return false;
    }

    const assignedToIds = Array.isArray(round.assignedTo) ? round.assignedTo.map(normalizeId) : [];
    return assignedToIds.includes(userId) || normalizeId(round.evaluatedBy) === userId;
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
        if (Array.isArray(serialized.interviewRounds)) {
            serialized.interviewRounds = serialized.interviewRounds.map((round) => {
                if (canViewRoundFeedback(round, user)) {
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

        if (serialized.phase2InterviewerFeedback !== undefined) {
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
    serializeCandidateForViewer,
    serializeHiringRequestForViewer
};
