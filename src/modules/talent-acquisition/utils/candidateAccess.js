const Candidate = require('../model/candidate.model');
const { HiringRequest } = require('../model/hiringRequest.model');
const PublicApplication = require('../model/publicApplication.model');
const {
    TA_CAPABILITIES,
    buildAccessibleCandidateQueryForCapability,
    canAccessCandidateThroughHiringRequest,
    canAccessHiringRequestForCapability,
    isInterviewerOnlyView,
    sanitizeCandidateForInterviewer
} = require('./taAccess');
const { canAccessHiringRequest } = require('./hiringRequestAccess');
const { serializeCandidateForViewer, canViewCandidateDetailsPage } = require('./taVisibility');
const {
    isDynamicHiringRequest,
    findPhaseById,
    findPhaseByOrder,
    getPhaseStatusOption,
    matchObjectId
} = require('./phaseTemplateUtils');

const DUPLICATE_CANDIDATE_MESSAGE = 'A candidate with this email or mobile number already exists for this hiring request.';
const DEFAULT_LEGACY_CANDIDATE_STATUS = 'Total Sourced';

const APPLICANT_REVIEW_SELECT = [
    'firstName', 'lastName', 'email', 'mobile', 'headline', 'summary',
    'currentCity', 'currentState', 'currentCountry', 'willingToRelocate',
    'preferredLocations', 'preferredJobTypes', 'preferredDepartments',
    'jobSearchStatus', 'currentCTC', 'expectedCTC', 'noticePeriod',
    'totalExperienceYears', 'workExperience', 'education', 'skills',
    'certifications', 'languages', 'linkedinUrl', 'githubUrl',
    'portfolioUrl', 'otherLinks', 'resumeUrl', 'resumeFileName',
    'resumeUpdatedAt', 'profilePhotoUrl', 'profileCompletionScore',
    'createdAt', 'updatedAt'
].join(' ');

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

const parseStringArrayQuery = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) {
        return val.flatMap(v => parseStringArrayQuery(v)).filter(Boolean);
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed || trimmed === '[]' || trimmed === 'null' || trimmed === 'undefined') {
            return [];
        }
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.map(s => String(s).trim()).filter(Boolean);
                }
            } catch (e) {
                // Ignore parse errors and fallback to string splitting
            }
        }
        return trimmed.split(',').map(s => s.trim().replace(/^\[|\]$/g, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    }
    return [];
};

const parseBooleanQueryValue = (val) => {
    if (val === true || val === 'true' || val === 1 || val === '1') return true;
    if (val === false || val === 'false' || val === 0 || val === '0') return false;
    return undefined;
};

const applyDateRangeFilterToCandidateQuery = (filterQuery, startDate, endDate, field = 'createdAt') => {
    if (!startDate && !endDate) return filterQuery;
    const range = {};
    if (startDate) range.$gte = new Date(startDate);
    if (endDate) range.$lte = new Date(endDate);
    filterQuery[field] = range;
    return filterQuery;
};

const getCandidateUploadedByName = (candidate) => {
    if (!candidate) return 'Unknown';
    if (candidate.uploadedBy) {
        if (typeof candidate.uploadedBy === 'string') return candidate.uploadedBy;
        return `${candidate.uploadedBy.firstName || ''} ${candidate.uploadedBy.lastName || ''}`.trim() || 'System';
    }
    return candidate.source || 'Direct';
};

const getCandidateUploadType = (candidate) => {
    if (!candidate) return 'Direct';
    if (candidate.isPublicApplication) return 'Public Application';
    return candidate.source || 'Direct';
};

const isProfileSharedCandidate = (candidate) => {
    if (!candidate) return false;

    const phase1Dropped = ['Rejected', 'Did Not Turn Up', 'Left in between'].includes(candidate.decision);
    const hasExplicitPhase2Activity = Boolean(
        (candidate.phase2Decision && candidate.phase2Decision !== 'None') ||
        (candidate.phase2InterviewStatus && candidate.phase2InterviewStatus !== 'None') ||
        Boolean(candidate.phase2InterviewerFeedback) ||
        (Array.isArray(candidate.interviewRounds) && candidate.interviewRounds.some(r => Number(r.phaseOrder) === 2 || Number(r.roundNumber) === 2 || Number(r.phase) === 2))
    );

    if (phase1Dropped && !hasExplicitPhase2Activity) {
        return false;
    }

    return Boolean(
        candidate.profileShared === true ||
        candidate.isProfileShared === true ||
        candidate.profileSharedAt ||
        candidate.decision === 'Shortlisted' ||
        candidate.decision === 'Profile Shared' ||
        hasExplicitPhase2Activity
    );
};

const getLegacyRoundsForPhase = (candidate, phaseOrder) => {
    if (!candidate || !Array.isArray(candidate.interviewRounds)) return [];
    const targetPhase = Number(phaseOrder) || 1;
    return candidate.interviewRounds.filter(r => (
        Number(r.phaseOrder) === targetPhase ||
        Number(r.roundNumber) === targetPhase ||
        Number(r.phase || 1) === targetPhase
    ));
};

const hasLegacyPhase2InterviewActivity = (candidate) => {
    const rounds = getLegacyRoundsForPhase(candidate, 2);
    return rounds.length > 0 || Boolean(candidate?.phase2InterviewerFeedback);
};

const getLegacyAverageRatingForPhase = (candidate, phaseOrder) => {
    const rounds = getLegacyRoundsForPhase(candidate, phaseOrder);
    const ratings = rounds.map(r => r.rating).filter(r => typeof r === 'number' && !isNaN(r));
    if (!ratings.length) return 0;
    return ratings.reduce((a, b) => a + b, 0) / ratings.length;
};

const ensureCandidateCapability = async (candidate, companyId, user, capability = TA_CAPABILITIES.VIEW, options = {}) => {
    const hasAccess = await canAccessCandidateThroughHiringRequest({
        candidate,
        companyId,
        user,
        capability,
        hiringRequest: options?.hiringRequest,
        roundId: options?.roundId
    });
    return { hasAccess };
};

const normalizeSkillItem = (item) => {
    if (!item) return null;
    if (typeof item === 'string') {
        const trimmed = item.trim();
        return trimmed ? { skill: trimmed, experience: 0 } : null;
    }
    if (typeof item === 'object') {
        const skillName = (item.skill || item.name || item.skillName || item.title || '').trim();
        if (!skillName) return null;
        const expNum = Number(item.experience);
        const experience = !isNaN(expNum) && expNum >= 0 ? expNum : 0;
        return { skill: skillName, experience };
    }
    return null;
};

const normalizeSkillList = (skills) => {
    if (!skills) return [];

    let itemsToProcess = [];

    if (Array.isArray(skills)) {
        itemsToProcess = skills;
    } else if (typeof skills === 'string') {
        itemsToProcess = skills.split(',');
    } else if (typeof skills === 'object') {
        if (Array.isArray(skills.technical) || Array.isArray(skills.softSkills)) {
            itemsToProcess = [
                ...(Array.isArray(skills.technical) ? skills.technical : []),
                ...(Array.isArray(skills.softSkills) ? skills.softSkills : [])
            ];
        } else {
            itemsToProcess = [skills];
        }
    }

    const result = [];
    const seenSkills = new Set();

    for (const rawItem of itemsToProcess) {
        if (typeof rawItem === 'string' && rawItem.includes(',')) {
            const parts = rawItem.split(',');
            for (const part of parts) {
                const normalized = normalizeSkillItem(part);
                if (normalized && !seenSkills.has(normalized.skill.toLowerCase())) {
                    seenSkills.add(normalized.skill.toLowerCase());
                    result.push(normalized);
                }
            }
        } else {
            const normalized = normalizeSkillItem(rawItem);
            if (normalized && !seenSkills.has(normalized.skill.toLowerCase())) {
                seenSkills.add(normalized.skill.toLowerCase());
                result.push(normalized);
            }
        }
    }

    return result;
};

const normalizePhase2InterviewStatus = (status) => {
    if (!status || typeof status !== 'string') return 'None';
    const trimmed = status.trim();
    if (!trimmed) return 'None';
    // Must match the candidate model enum exactly
    const VALID_PHASE2_INTERVIEW_STATUSES = ['Scheduled', 'Rejected', 'Shortlisted', 'Did not Turn up', 'Left in between', 'None', ''];
    const matched = VALID_PHASE2_INTERVIEW_STATUSES.find(v => v.toLowerCase() === trimmed.toLowerCase());
    return matched !== undefined ? matched : null; // null = invalid, caller should reject
};

const hasMeaningfulOfferValue = (val) => {
    if (val === undefined || val === null) return false;
    const str = String(val).trim();
    return str !== '' && str !== '0' && str.toLowerCase() !== 'null' && str.toLowerCase() !== 'undefined';
};

const findDuplicateCandidateInCompany = async ({ companyId, hiringRequestId, email, mobile, excludeCandidateId }) => {
    const conditions = [];
    if (email && String(email).trim()) {
        conditions.push({ email: String(email).trim().toLowerCase() });
    }
    if (mobile && String(mobile).trim()) {
        conditions.push({ mobile: String(mobile).trim() });
    }
    if (!conditions.length) return null;

    const query = {
        companyId,
        $or: conditions
    };
    if (hiringRequestId) {
        query.hiringRequestId = hiringRequestId;
    }
    if (excludeCandidateId) {
        query._id = { $ne: excludeCandidateId };
    }
    return Candidate.findOne(query).lean();
};

const isCandidateOwnedByUser = (candidate, userId) => {
    if (!candidate || !userId) return false;
    const uId = String(userId);
    const uploadedBy = candidate.uploadedBy?._id || candidate.uploadedBy;
    return String(uploadedBy) === uId;
};

const canOverrideDuplicateCandidateOwnership = (userOrOptions) => {
    const user = userOrOptions?.user || userOrOptions;
    if (!user || typeof user !== 'object') return false;
    if (user.isAdmin || user.isSystemAdmin || user.isSuperAdmin || user.hasAllPermissions) {
        return true;
    }
    const roles = Array.isArray(user.roles) ? user.roles : [];
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    return roles.some((role) => role?.isSystem || ['Admin', 'Super Admin', 'System Admin'].includes(role?.name)) ||
        permissions.includes('*') ||
        permissions.includes('ta.candidate.manage.all');
};

const buildDuplicateCandidateMessage = (duplicateCandidate) => {
    if (!duplicateCandidate) return DUPLICATE_CANDIDATE_MESSAGE;
    return `A candidate with this email or mobile number already exists for this hiring request (${duplicateCandidate.candidateName || 'Candidate'}).`;
};

const getUserDisplayName = (user) => {
    if (!user) return 'System';
    if (typeof user === 'string') return user;
    const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    return name || user.email || 'System';
};

const hasMeaningfulStatus = (status) => Boolean(status && typeof status === 'string' && status.trim() !== '');

const toLegacySafeStatus = (status) => {
    if (!status || typeof status !== 'string') return DEFAULT_LEGACY_CANDIDATE_STATUS;
    return status.trim() || DEFAULT_LEGACY_CANDIDATE_STATUS;
};

const hasCandidateMovedToPhase2 = (candidate) => {
    if (!candidate) return false;
    if (candidate.activePhase && Number(candidate.activePhase) >= 2) return true;
    if (Array.isArray(candidate.interviewRounds) && candidate.interviewRounds.some(r => Number(r.phaseOrder) >= 2 || Number(r.roundNumber) >= 2 || Number(r.phase) >= 2)) return true;
    return Boolean(
        (candidate.phase2Decision && candidate.phase2Decision !== 'None') ||
        (candidate.phase2InterviewStatus && candidate.phase2InterviewStatus !== 'None') ||
        Boolean(candidate.phase2InterviewerFeedback) ||
        candidate.decision === 'Shortlisted' ||
        candidate.decision === 'Profile Shared' ||
        candidate.profileShared === true ||
        candidate.isProfileShared === true
    );
};

const hasRealResume = (candidate) => Boolean(candidate?.resumeUrl && candidate.resumeUrl.trim() !== '');

const applyDynamicImportedStatus = (candidate, hiringRequest, status) => {
    if (!candidate || !isDynamicHiringRequest(hiringRequest)) {
        return false;
    }

    if (!status || typeof status !== 'string' || status.trim() === '') {
        return false;
    }

    const trimmedStatus = status.trim();

    let phase = null;
    if (candidate.currentPhaseId) {
        phase = findPhaseById(hiringRequest.phases, candidate.currentPhaseId);
    }
    if (!phase && candidate.currentPhaseOrder) {
        phase = findPhaseByOrder(hiringRequest.phases, candidate.currentPhaseOrder);
    }
    if (!phase && Array.isArray(hiringRequest.phases) && hiringRequest.phases.length > 0) {
        const sortedPhases = [...hiringRequest.phases].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
        phase = sortedPhases[0];
    }

    if (!phase) {
        return false;
    }

    const statusOption = getPhaseStatusOption(phase, trimmedStatus);
    if (!statusOption) {
        return false;
    }

    candidate.currentPhaseStatus = statusOption.value;

    if (Array.isArray(candidate.phaseHistory)) {
        const activeEntry = candidate.phaseHistory.find(
            (entry) => (!entry.exitedAt) &&
                (matchObjectId(entry.phaseId, phase.phaseId || phase._id) || Number(entry.phaseOrder) === Number(phase.order))
        );
        if (activeEntry) {
            activeEntry.status = statusOption.value;
        }
    }

    if (typeof candidate.status === 'object') {
        candidate.status = '';
    }

    return true;
};

const enrichCandidatesWithPublicProfiles = async (candidatesOrCandidate, companyId) => {
    if (!candidatesOrCandidate) return candidatesOrCandidate;

    const isArray = Array.isArray(candidatesOrCandidate);
    const candidatesList = isArray ? candidatesOrCandidate : [candidatesOrCandidate];

    const publicAppIds = candidatesList
        .map(c => c?.publicApplicationId?._id || c?.publicApplicationId)
        .filter(Boolean);

    if (publicAppIds.length === 0) {
        return candidatesOrCandidate;
    }

    try {
        const publicApps = await PublicApplication.find({
            _id: { $in: publicAppIds }
        }).lean();

        const publicAppMap = new Map(publicApps.map(app => [String(app._id), app]));

        const enrichedList = candidatesList.map(c => {
            const appId = String(c?.publicApplicationId?._id || c?.publicApplicationId || '');
            const publicApp = publicAppMap.get(appId);
            if (publicApp) {
                const candidateObj = (typeof c.toObject === 'function') ? c.toObject() : { ...c };
                return {
                    ...candidateObj,
                    publicApplication: publicApp,
                    profileSnapshot: candidateObj.profileSnapshot || publicApp.profileSnapshot || null
                };
            }
            return c;
        });

        return isArray ? enrichedList : enrichedList[0];
    } catch (err) {
        console.error('Error enriching candidates with public profiles:', err);
        return candidatesOrCandidate;
    }
};

const buildLegacyCandidateListResponse = ({ candidates = [], filters = {}, page = 1, limit = 50 }) => {
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const totalCount = candidates.length;
    const totalPages = Math.ceil(totalCount / limitNum) || 1;
    const startIndex = (pageNum - 1) * limitNum;
    const paginatedCandidates = candidates.slice(startIndex, startIndex + limitNum);

    return {
        candidates: paginatedCandidates,
        count: totalCount,
        currentPage: pageNum,
        totalPages: totalPages,
        pagination: {
            total: totalCount,
            page: pageNum,
            limit: limitNum,
            pages: totalPages
        },
        filters
    };
};

const getCandidateHiringRequestForAccess = async (candidate, companyId) => {
    if (!candidate) return null;
    const reqId = candidate.hiringRequestId?._id || candidate.hiringRequestId;
    if (!reqId) return null;
    return HiringRequest.findOne({ _id: reqId, companyId })
        .select('createdBy ownership assignedUsers analyticsViewers client clientConfidential hiringDetails')
        .lean();
};

module.exports = {
    TA_CAPABILITIES,
    DUPLICATE_CANDIDATE_MESSAGE,
    DEFAULT_LEGACY_CANDIDATE_STATUS,
    APPLICANT_REVIEW_SELECT,
    buildAccessibleCandidateQuery,
    canAccessCandidate,
    ensureCandidateCapability,
    canAccessHiringRequestForCapability,
    canAccessHiringRequest,
    isInterviewerOnlyView,
    sanitizeCandidateForInterviewer,
    serializeCandidateForViewer,
    canViewCandidateDetailsPage,
    parseStringArrayQuery,
    parseBooleanQueryValue,
    applyDateRangeFilterToCandidateQuery,
    getCandidateUploadedByName,
    getCandidateUploadType,
    isProfileSharedCandidate,
    getLegacyRoundsForPhase,
    hasLegacyPhase2InterviewActivity,
    getLegacyAverageRatingForPhase,
    normalizeSkillList,
    normalizePhase2InterviewStatus,
    hasMeaningfulOfferValue,
    findDuplicateCandidateInCompany,
    isCandidateOwnedByUser,
    canOverrideDuplicateCandidateOwnership,
    buildDuplicateCandidateMessage,
    getUserDisplayName,
    hasMeaningfulStatus,
    toLegacySafeStatus,
    hasCandidateMovedToPhase2,
    hasRealResume,
    applyDynamicImportedStatus,
    enrichCandidatesWithPublicProfiles,
    buildLegacyCandidateListResponse,
    getCandidateHiringRequestForAccess
};
