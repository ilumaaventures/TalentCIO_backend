const { isHiringRequestAdmin } = require('./hiringRequestAccess');

const buildAccessibleCandidateQuery = (companyId, user, extraQuery = {}) => {
    const query = {
        companyId,
        ...extraQuery
    };

    if (!isHiringRequestAdmin(user)) {
        query.uploadedBy = user?._id;
    }

    return query;
};

const canAccessCandidate = (candidate, user) => {
    if (!candidate || !user?._id) {
        return false;
    }

    if (isHiringRequestAdmin(user)) {
        return true;
    }

    return String(candidate.uploadedBy?._id || candidate.uploadedBy || '') === String(user._id);
};

module.exports = {
    buildAccessibleCandidateQuery,
    canAccessCandidate
};
