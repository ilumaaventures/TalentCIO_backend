const {
    TA_CAPABILITIES,
    buildAccessibleCandidateQueryForCapability,
    canAccessCandidateThroughHiringRequest,
    canAccessHiringRequestForCapability,
    isInterviewerOnlyView,
    sanitizeCandidateForInterviewer
} = require('./taAccess');

const buildAccessibleCandidateQuery = async (companyId, user, extraQuery = {}, options = {}) => (
    buildAccessibleCandidateQueryForCapability(
        companyId,
        user,
        extraQuery,
        options.capability || TA_CAPABILITIES.VIEW
    )
);

const canAccessCandidate = async (candidate, user, options = {}) => (
    canAccessCandidateThroughHiringRequest({
        candidate,
        user,
        companyId: options.companyId,
        hiringRequest: options.hiringRequest,
        capability: options.capability || TA_CAPABILITIES.VIEW,
        roundId: options.roundId || null
    })
);

module.exports = {
    TA_CAPABILITIES,
    buildAccessibleCandidateQuery,
    canAccessCandidate,
    canAccessHiringRequestForCapability,
    isInterviewerOnlyView,
    sanitizeCandidateForInterviewer
};
