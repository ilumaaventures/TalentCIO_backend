const Candidate = require('../../../models/Candidate');
const { HiringRequest } = require('../../../models/HiringRequest');
const mongoose = require('mongoose');
const Company = require('../../../models/Company');
const PublicApplication = require('../../../models/PublicApplication');
const {
    buildInitialDynamicPhaseState,
    isDynamicHiringRequest
} = require('../../../utils/phaseTemplateUtils');
const { canAccessHiringRequest, getUserPermissionKeys } = require('../../../utils/hiringRequestAccess');
const {
    TA_CAPABILITIES,
    buildAccessibleCandidateQuery,
    canAccessCandidate,
    canAccessHiringRequestForCapability,
    isInterviewerOnlyView,
    sanitizeCandidateForInterviewer
} = require('../../../utils/candidateAccess');
const { serializeCandidateForViewer } = require('../../../utils/taVisibility');

const LEGACY_STATUS_VALUES = new Set([
    'Interested',
    'Not Interested',
    'Not Relevant',
    'Not Picking',
    'In Interview',
    'High expectation',
    'Long Notice period',
    'Location Not suitable',
    ''
]);

const DEFAULT_LEGACY_CANDIDATE_STATUS = '';
const DUPLICATE_CANDIDATE_MESSAGE = 'This candidate already exists in the system.';

const normalizeStatusKey = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

const normalizeCandidateEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeCandidateMobile = (value) => String(value || '').trim();
const normalizeEntityId = (value) => String(value?._id || value || '');

const canViewCandidateDetailsPage = (user) => {
    const permissionKeys = getUserPermissionKeys(user);
    return permissionKeys.includes('*')
        || permissionKeys.includes('ta.candidate.manage.all')
        || permissionKeys.includes('ta.candidate.manage.assigned')
        || permissionKeys.includes('ta.interview.evaluate')
        || user?.isTAParticipant === true;
};

const getUserDisplayName = (user) => {
    if (!user) return '';

    const fullName = [user.firstName, user.lastName]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(' ');

    return fullName || String(user.email || '').trim();
};

const buildDuplicateCandidateQuery = ({ companyId, hiringRequestId = null, email, mobile, excludeCandidateId = null }) => {
    const duplicateConditions = [];
    const normalizedEmail = normalizeCandidateEmail(email);
    const normalizedMobile = normalizeCandidateMobile(mobile);

    if (normalizedEmail) {
        duplicateConditions.push({ email: normalizedEmail });
    }

    if (normalizedMobile) {
        duplicateConditions.push({ mobile: normalizedMobile });
    }

    if (!duplicateConditions.length) {
        return null;
    }

    const duplicateQuery = {
        companyId,
        $or: duplicateConditions
    };

    if (hiringRequestId) {
        duplicateQuery.hiringRequestId = hiringRequestId;
    }

    if (excludeCandidateId) {
        duplicateQuery._id = { $ne: excludeCandidateId };
    }

    return duplicateQuery;
};

const findDuplicateCandidateInCompany = async ({ companyId, hiringRequestId = null, email, mobile, excludeCandidateId = null }) => {
    const duplicateQuery = buildDuplicateCandidateQuery({ companyId, hiringRequestId, email, mobile, excludeCandidateId });
    if (!duplicateQuery) {
        return null;
    }

    return Candidate.findOne(duplicateQuery)
        .select('_id candidateName hiringRequestId email mobile uploadedBy')
        .populate('uploadedBy', 'firstName lastName email')
        .lean();
};

const isCandidateOwnedByUser = (candidate, userId) => (
    normalizeEntityId(candidate?.uploadedBy) === normalizeEntityId(userId)
);

const canOverrideDuplicateCandidateOwnership = async ({ user, companyId, hiringRequest }) => {
    const permissionKeys = getUserPermissionKeys(user);
    if (!permissionKeys.includes('ta.requisition.manage.assigned')) {
        return false;
    }

    return canAccessHiringRequest(hiringRequest, companyId, user, { action: 'edit' });
};

const buildDuplicateCandidateMessage = (candidate, userId, canAutoUpdate = false) => {
    if (isCandidateOwnedByUser(candidate, userId)) {
        return canAutoUpdate
            ? 'Candidate already exists. Your bulk import will update the existing record.'
            : 'Candidate already exists. Open the existing record to update it.';
    }

    if (canAutoUpdate) {
        return 'Candidate already exists. Your requisition access allows the bulk import to update the existing record.';
    }

    const uploaderName = getUserDisplayName(candidate?.uploadedBy);
    return uploaderName
        ? `Candidate already exists and was uploaded by ${uploaderName}.`
        : DUPLICATE_CANDIDATE_MESSAGE;
};

const resolveDynamicStatusOption = (phase, rawStatus) => {
    const normalizedTarget = normalizeStatusKey(rawStatus);
    if (!normalizedTarget) {
        return null;
    }

    return (phase?.statusOptions || []).find((option) => (
        normalizeStatusKey(option?.value) === normalizedTarget ||
        normalizeStatusKey(option?.label) === normalizedTarget
    )) || null;
};

const getInitialDynamicPhaseAssignees = (hiringRequest) => (
    Array.isArray(hiringRequest?.assignedUsers) && hiringRequest.assignedUsers.length > 0
        ? hiringRequest.assignedUsers
        : []
);

const applyDynamicImportedStatus = (candidate, hiringRequest, rawStatus) => {
    if (!isDynamicHiringRequest(hiringRequest)) {
        return false;
    }

    const phases = [...(hiringRequest.phases || [])].sort((left, right) => (left.order || 0) - (right.order || 0));
    if (!phases.length) {
        return false;
    }

    if (!Array.isArray(candidate.phaseHistory) || candidate.phaseHistory.length === 0) {
        const initialDynamicState = buildInitialDynamicPhaseState(
            hiringRequest,
            getInitialDynamicPhaseAssignees(hiringRequest)
        );

        if (initialDynamicState.phaseHistory?.length) {
            candidate.phaseHistory = initialDynamicState.phaseHistory;
            candidate.currentPhaseId = initialDynamicState.currentPhaseId;
            candidate.currentPhaseOrder = initialDynamicState.currentPhaseOrder;
            candidate.currentPhaseStatus = initialDynamicState.currentPhaseStatus;
            candidate.currentPhaseName = initialDynamicState.currentPhaseName;
        }
    }

    const currentPhaseEntry = (candidate.phaseHistory || []).find((entry) => !entry.exitedAt) || candidate.phaseHistory?.[0];
    if (!currentPhaseEntry) {
        return false;
    }

    const currentPhase = phases.find((phase) =>
        String(phase.phaseId || phase._id || '') === String(currentPhaseEntry.phaseId || '') ||
        Number(phase.order) === Number(currentPhaseEntry.phaseOrder)
    );

    if (!hasMeaningfulStatus(rawStatus)) {
        currentPhaseEntry.status = '';
        currentPhaseEntry.phaseName = currentPhase?.name || currentPhaseEntry.phaseName;
        currentPhaseEntry.phaseOrder = currentPhase?.order || currentPhaseEntry.phaseOrder;
        candidate.currentPhaseId = currentPhaseEntry.phaseId;
        candidate.currentPhaseOrder = currentPhaseEntry.phaseOrder;
        candidate.currentPhaseStatus = '';
        candidate.currentPhaseName = currentPhaseEntry.phaseName;
        return true;
    }

    const matchedStatusOption = resolveDynamicStatusOption(currentPhase, rawStatus);
    if (!matchedStatusOption) {
        return false;
    }

    currentPhaseEntry.status = matchedStatusOption.value;
    currentPhaseEntry.phaseName = currentPhase?.name || currentPhaseEntry.phaseName;
    currentPhaseEntry.phaseOrder = currentPhase?.order || currentPhaseEntry.phaseOrder;
    candidate.currentPhaseId = currentPhaseEntry.phaseId;
    candidate.currentPhaseOrder = currentPhaseEntry.phaseOrder;
    candidate.currentPhaseStatus = matchedStatusOption.value;
    candidate.currentPhaseName = currentPhaseEntry.phaseName;

    return true;
};

const normalizePhase2InterviewStatus = (rawStatus) => {
    const normalized = String(rawStatus || '').trim().toLowerCase();
    if (!normalized || normalized === 'none') {
        return 'None';
    }

    if (normalized === 'scheduled') {
        return 'Scheduled';
    }

    if (normalized === 'rejected') {
        return 'Rejected';
    }

    if (normalized === 'shortlisted') {
        return 'Shortlisted';
    }

    if (normalized === 'did not turn up') {
        return 'Did not Turn up';
    }

    return null;
};

const getImplicitPhase2InterviewStatus = (rawDecision) => {
    const normalizedDecision = String(rawDecision || '').trim();

    if (normalizedDecision === 'Rejected') {
        return 'Rejected';
    }

    if (normalizedDecision === 'Selected') {
        return 'Shortlisted';
    }

    if (normalizedDecision === 'Shortlisted' || normalizedDecision === 'None' || normalizedDecision === '') {
        return 'None';
    }

    return undefined;
};

const hasCandidateMovedToPhase2 = (candidate = {}) => {
    const phase2Decision = String(candidate?.phase2Decision || '').trim();
    const phase2InterviewStatus = String(candidate?.phase2InterviewStatus || '').trim();
    const phase2InterviewerFeedback = String(candidate?.phase2InterviewerFeedback || '').trim();

    return candidate?.profileShared === true
        || (candidate?.profileShared == null && candidate?.decision === 'Shortlisted')
        || Boolean(phase2Decision && phase2Decision !== 'None')
        || Boolean(phase2InterviewStatus && phase2InterviewStatus !== 'None')
        || Boolean(phase2InterviewerFeedback);
};

const toLegacySafeStatus = (rawStatus) => {
    const normalizedStatus = String(rawStatus || '').trim();
    return LEGACY_STATUS_VALUES.has(normalizedStatus) ? normalizedStatus : '';
};

const hasMeaningfulStatus = (rawStatus) => Boolean(String(rawStatus || '').trim());

const hasRealResume = (resumeUrl) => (
    typeof resumeUrl === 'string' &&
    /^https?:\/\//i.test(resumeUrl.trim())
);

const hasMeaningfulOfferValue = (value) => {
    if (value === null || value === undefined) return false;
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    return String(value).trim() !== '';
};

const normalizeSkillEntry = (skillEntry = {}) => {
    const skill = String(skillEntry?.skill || '').trim();
    if (!skill) return null;

    let experience = skillEntry?.experience;
    if (experience === '' || experience === null || experience === undefined) {
        experience = 0;
    } else if (typeof experience === 'string') {
        const match = experience.match(/(\d+(\.\d+)?)/);
        experience = match ? Number(match[1]) : 0;
    } else {
        experience = Number(experience);
    }

    return {
        skill,
        experience: Number.isFinite(experience) && experience >= 0 ? experience : 0
    };
};

const normalizeSkillList = (skills = []) => (
    Array.isArray(skills)
        ? skills.map(normalizeSkillEntry).filter(Boolean)
        : []
);

const APPLICANT_REVIEW_SELECT = [
    'firstName',
    'lastName',
    'email',
    'mobile',
    'headline',
    'summary',
    'currentCity',
    'currentState',
    'currentCountry',
    'willingToRelocate',
    'preferredLocations',
    'preferredJobTypes',
    'preferredDepartments',
    'jobSearchStatus',
    'currentCTC',
    'expectedCTC',
    'noticePeriod',
    'totalExperienceYears',
    'workExperience',
    'education',
    'skills',
    'certifications',
    'languages',
    'linkedinUrl',
    'githubUrl',
    'portfolioUrl',
    'otherLinks',
    'resumeUrl',
    'resumeFileName',
    'resumeUpdatedAt',
    'profilePhotoUrl',
    'profileCompletionScore',
    'createdAt',
    'updatedAt'
].join(' ');

const getCandidateHiringRequestForAccess = async (candidate, companyId) => (
    HiringRequest.findOne({
        _id: candidate?.hiringRequestId?._id || candidate?.hiringRequestId,
        companyId
    })
        .select('createdBy ownership assignedUsers analyticsViewers requestId roleDetails requirements')
        .lean()
);

const ensureCandidateCapability = async (candidate, companyId, user, capability, options = {}) => {
    const hiringRequest = options.hiringRequest || await getCandidateHiringRequestForAccess(candidate, companyId);
    const hasAccess = await canAccessCandidate(candidate, user, {
        companyId,
        hiringRequest,
        capability,
        roundId: options.roundId || null
    });

    return {
        hasAccess,
        hiringRequest
    };
};

const enrichCandidatesWithPublicProfiles = async (candidates, companyId) => {
    const candidateList = Array.isArray(candidates) ? candidates : [candidates].filter(Boolean);
    if (!candidateList.length) return candidates;

    const missingPublicProfileIds = candidateList
        .filter((candidate) => !candidate.publicApplicationId && !candidate.applicantId && !candidate.profileSnapshot)
        .map((candidate) => candidate._id)
        .filter(Boolean);

    let applicationsByCandidate = new Map();
    if (missingPublicProfileIds.length) {
        const publicApplications = await PublicApplication.find({
            companyId,
            transferredCandidateId: { $in: missingPublicProfileIds }
        })
            .populate('applicantId', APPLICANT_REVIEW_SELECT)
            .lean();

        applicationsByCandidate = new Map(
            publicApplications.map((application) => [application.transferredCandidateId?.toString(), application])
        );
    }

    const enriched = candidateList.map((candidate) => {
        const publicApplication = applicationsByCandidate.get(candidate._id?.toString());
        if (!publicApplication) return candidate;

        return {
            ...candidate,
            applicantId: candidate.applicantId || publicApplication.applicantId,
            publicApplicationId: candidate.publicApplicationId || publicApplication._id,
            profileSnapshot: candidate.profileSnapshot || publicApplication.profileSnapshot,
            publicApplicationReviewStatus: publicApplication.reviewStatus,
            publicApplicationAppliedAt: publicApplication.createdAt,
            coverNote: candidate.coverNote || publicApplication.coverNote
        };
    });

    return Array.isArray(candidates) ? enriched : enriched[0];
};

const applyDateRangeFilterToCandidateQuery = (query, rawDateField, rawStartDate, rawEndDate) => {
    const allowedDateFields = new Set(['createdAt', 'updatedAt']);
    const dateField = allowedDateFields.has(String(rawDateField || '')) ? String(rawDateField) : '';

    if (!dateField) {
        return query;
    }

    const dateFilter = {};

    if (rawStartDate) {
        const startDate = new Date(rawStartDate);
        if (!Number.isNaN(startDate.getTime())) {
            startDate.setHours(0, 0, 0, 0);
            dateFilter.$gte = startDate;
        }
    }

    if (rawEndDate) {
        const endDate = new Date(rawEndDate);
        if (!Number.isNaN(endDate.getTime())) {
            endDate.setHours(23, 59, 59, 999);
            dateFilter.$lte = endDate;
        }
    }

    if (Object.keys(dateFilter).length > 0) {
        query[dateField] = dateFilter;
    }

    return query;
};

const parseBooleanQueryValue = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
    return fallback;
};

const parseStringArrayQuery = (value) => {
    if (Array.isArray(value)) {
        return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return [];
        }

        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return [...new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean))];
                }
            } catch (error) {
                // Fall back to comma-separated parsing below.
            }
        }

        return [...new Set(trimmed.split(',').map((item) => item.trim()).filter(Boolean))];
    }

    return [];
};

const getCandidateUploadType = (candidate = {}) => (
    hasRealResume(candidate?.resumeUrl) ? 'CV' : 'Excel'
);

const getCandidateUploadedByName = (candidate = {}) => (
    `${candidate?.uploadedBy?.firstName || ''} ${candidate?.uploadedBy?.lastName || ''}`.trim()
);

const isProfileSharedCandidate = (candidate = {}) => (
    candidate?.profileShared === true
    || (candidate?.profileShared == null && candidate?.decision === 'Shortlisted')
);

const getLegacyRoundsForPhase = (candidate = {}, phase = 1) => (
    Array.isArray(candidate?.interviewRounds)
        ? candidate.interviewRounds.filter((round) => Number(round?.phase || 1) === Number(phase))
        : []
);

const getPhase2InterviewStatusValue = (candidate = {}) => {
    const normalized = String(candidate?.phase2InterviewStatus || '').trim();
    if (['Scheduled', 'Rejected', 'Shortlisted', 'Did not Turn up'].includes(normalized)) {
        return normalized;
    }

    if (candidate?.phase2Decision === 'Rejected') {
        return 'Rejected';
    }

    if (candidate?.phase2Decision === 'Selected') {
        return 'Shortlisted';
    }

    return '';
};

const getLegacyDisplayInterviewRoundsForPhase = (candidate = {}, phase = 1) => {
    const rounds = getLegacyRoundsForPhase(candidate, phase);
    if (phase !== 2 || rounds.length > 0) {
        return rounds;
    }

    const phase2InterviewStatus = getPhase2InterviewStatusValue(candidate);
    const phase2Feedback = String(candidate?.phase2InterviewerFeedback || '').trim();
    if (!phase2InterviewStatus && !phase2Feedback) {
        return [];
    }

    return [{
        _id: 'phase2-imported-interview-summary',
        phase: 2,
        status: phase2InterviewStatus === 'Rejected'
            ? 'Failed'
            : phase2InterviewStatus === 'Shortlisted'
                ? 'Passed'
                : phase2InterviewStatus === 'Did not Turn up'
                    ? 'Skipped'
                    : 'Scheduled',
        feedback: candidate?.phase2InterviewerFeedback || '',
        rating: null,
        skillRatings: []
    }];
};

const hasLegacyPhase2InterviewActivity = (candidate = {}) => (
    getLegacyDisplayInterviewRoundsForPhase(candidate, 2).length > 0
);

const getLegacyInterviewFilterValue = (rounds = []) => {
    if (!Array.isArray(rounds) || rounds.length === 0) {
        return null;
    }

    const hasFailed = rounds.some((round) => round.status === 'Failed');
    if (hasFailed) {
        return 'Failed';
    }

    const hasScheduled = rounds.some((round) => ['Pending', 'Scheduled'].includes(round.status));
    if (hasScheduled) {
        return 'Scheduled';
    }

    const allClosed = rounds.every((round) => ['Passed', 'Skipped'].includes(round.status));
    if (allClosed) {
        return 'Shortlisted';
    }

    return 'Scheduled';
};

const matchesLegacyInterviewFilter = (rounds = [], filterValue = 'All') => {
    if (filterValue === 'All') {
        return true;
    }

    if (filterValue === 'Scheduled') {
        return Array.isArray(rounds) && rounds.length > 0;
    }

    return getLegacyInterviewFilterValue(rounds) === filterValue;
};

const getLegacyAverageRatingForPhase = (candidate = {}, phase = 1) => {
    const rounds = getLegacyRoundsForPhase(candidate, phase);
    const ratedRounds = rounds.filter((round) => Number(round?.rating) > 0);
    if (!ratedRounds.length) {
        return null;
    }

    return ratedRounds.reduce((sum, round) => sum + Number(round.rating || 0), 0) / ratedRounds.length;
};

const buildLegacyCandidateListResponse = ({ candidates = [], filters = {}, page = 1, limit = 15 }) => {
    const {
        activePhase = 1,
        search = '',
        filterPreference = 'All',
        filterStatus = 'All',
        filterDecision = 'All',
        filterExperience = '',
        filterInterviewStatus = 'All',
        filterRating = 'All',
        filterPulledBy = [],
        filterUploadedBy = [],
        filterUploadType = 'All',
        filterTransferred = 'All',
        filterProfileShared = false,
        filterInterviewRound = '',
        filterDynamicStage = 'All'
    } = filters;

    const normalizedSearch = String(search || '').trim().toLowerCase();
    const normalizedPulledBy = parseStringArrayQuery(filterPulledBy);
    const normalizedUploadedBy = parseStringArrayQuery(filterUploadedBy);
    const normalizedActivePhase = Number(activePhase) || 1;
    const minExperience = filterExperience === '' ? null : Number(filterExperience);
    const minRating = filterRating === 'All' ? null : Number(filterRating);

    const matchesSearch = (candidate) => (
        !normalizedSearch || String(candidate?.candidateName || '').toLowerCase().includes(normalizedSearch)
    );

    const isNotScheduledFilter = filterDynamicStage && String(filterDynamicStage).startsWith('NotScheduled_');

    const matchesDynamicStageFilter = (candidate, phase) => {
        if (!filterDynamicStage || filterDynamicStage === 'All') return true;
        const parts = String(filterDynamicStage).split('_');
        const statusType = parts[0];
        const targetRoundName = parts.slice(1).join('_').trim().toLowerCase();
        const rounds = Array.isArray(candidate?.interviewRounds) ? candidate.interviewRounds : [];

        if (statusType === 'NotScheduled' || statusType === 'Unscheduled') {
            const hasTargetRound = rounds.some(
                (r) => Number(r.phase || 1) === phase && String(r.levelName || '').trim().toLowerCase() === targetRoundName
            );
            return !hasTargetRound;
        }

        const targetRoundObj = rounds.find(
            (r) => Number(r.phase || 1) === phase && String(r.levelName || '').trim().toLowerCase() === targetRoundName
        );

        if (!targetRoundObj) return false;
        const s = String(targetRoundObj.status || 'Pending').trim();
        if (statusType === 'Cleared') {
            return s === 'Passed' || s === 'Pass' || s === 'Shortlisted';
        }
        if (statusType === 'Failed') {
            return s === 'Failed' || s === 'Fail' || s === 'Rejected';
        }
        if (statusType === 'DNTU') {
            return s === 'Did Not Turn Up' || s === 'Did Not Turnup' || s === 'Did Not Turn up' || s === 'Skipped' || s === 'No Show' || s === 'DNTU';
        }
        if (statusType === 'LIB') {
            return s === 'Left in between' || s === 'Left In Between' || s === 'LIB';
        }
        if (statusType === 'Pending') {
            return s === 'Pending' || s === 'Scheduled';
        }
        return true;
    };

    const matchesCommonStructuralFilters = (candidate) => {
        const matchesPulledBy = !normalizedPulledBy.length || normalizedPulledBy.includes(String(candidate?.profilePulledBy || '').trim());
        const matchesUploadedBy = !normalizedUploadedBy.length || normalizedUploadedBy.includes(getCandidateUploadedByName(candidate));
        const matchesUploadType = filterUploadType === 'All' || getCandidateUploadType(candidate) === filterUploadType;
        const matchesTransferred = filterTransferred === 'All'
            ? true
            : filterTransferred === 'Transferred'
                ? candidate?.isTransferred === true
                : candidate?.isTransferred !== true;

        return matchesSearch(candidate) && matchesPulledBy && matchesUploadedBy && matchesUploadType && matchesTransferred;
    };

    const matchesBaseFiltersForPhase = (candidate, phase) => {
        const matchesPreference = filterPreference === 'All' || candidate?.preference === filterPreference;
        const matchesExperience = minExperience === null
            || (candidate?.totalExperience !== undefined && candidate?.totalExperience !== null && Number(candidate.totalExperience) >= minExperience);

        let matchesRating = true;
        if (minRating !== null && Number.isFinite(minRating)) {
            const averageRating = getLegacyAverageRatingForPhase(candidate, phase);
            matchesRating = averageRating !== null && averageRating >= minRating;
        }

        return matchesPreference && matchesExperience && matchesRating;
    };

    const structuralPhase1Candidates = candidates.filter((candidate) => matchesCommonStructuralFilters(candidate));
    const basePhase1Candidates = structuralPhase1Candidates.filter((candidate) => matchesBaseFiltersForPhase(candidate, 1));
    const filteredPhase1Candidates = basePhase1Candidates.filter((candidate) => {
        const mainStatuses = ['Interested', 'Not Interested', 'Not Relevant', 'Not Picking', 'High expectation', 'Long Notice period', 'Location Not suitable'];
        const matchesStatus = filterStatus === 'All'
            ? true
            : ['Other', 'None', 'OTH'].includes(filterStatus)
                ? !mainStatuses.includes(candidate?.status)
                : candidate?.status === filterStatus;
        const matchesDecision = filterDecision === 'All' || (candidate?.decision || 'None') === filterDecision;
        const matchesProfileShared = !filterProfileShared || isProfileSharedCandidate(candidate);
        const matchesInterviewStatus = filterInterviewStatus === 'All'
            || matchesLegacyInterviewFilter(getLegacyRoundsForPhase(candidate, 1), filterInterviewStatus);
        const matchesInterviewRound = !filterInterviewRound
            || isNotScheduledFilter
            || (candidate?.interviewRounds || []).some((r) =>
                String(r.levelName || '').trim().toLowerCase() === String(filterInterviewRound).trim().toLowerCase()
            );
        const matchesDynamic = matchesDynamicStageFilter(candidate, 1);

        return matchesStatus && matchesDecision && matchesInterviewStatus && matchesProfileShared && matchesInterviewRound && matchesDynamic;
    });

    const structuralPhase2Candidates = candidates.filter((candidate) => (
        isProfileSharedCandidate(candidate) && matchesCommonStructuralFilters(candidate)
    ));
    const basePhase2Candidates = structuralPhase2Candidates.filter((candidate) => matchesBaseFiltersForPhase(candidate, 2));
    const filteredPhase2Candidates = basePhase2Candidates.filter((candidate) => {
        const matchesDecision = filterDecision === 'All'
            || (filterDecision === 'Shortlisted_Selected'
                ? (candidate?.phase2Decision === 'Shortlisted' || candidate?.phase2Decision === 'Selected')
                : (candidate?.phase2Decision || 'None') === filterDecision);

        const matchesInterviewStatus = filterInterviewStatus === 'All'
            || (filterInterviewStatus === 'Scheduled'
                ? hasLegacyPhase2InterviewActivity(candidate)
                : matchesLegacyInterviewFilter(getLegacyRoundsForPhase(candidate, 2), filterInterviewStatus));

        const matchesInterviewRound = !filterInterviewRound
            || isNotScheduledFilter
            || (candidate?.interviewRounds || []).some((r) =>
                String(r.levelName || '').trim().toLowerCase() === String(filterInterviewRound).trim().toLowerCase()
            );
        const matchesDynamic = matchesDynamicStageFilter(candidate, 2);

        return matchesDecision && matchesInterviewStatus && matchesInterviewRound && matchesDynamic;
    });

    const structuralPhase3Candidates = candidates.filter((candidate) => (
        candidate?.phase2Decision === 'Selected' && matchesCommonStructuralFilters(candidate)
    ));
    const basePhase3Candidates = structuralPhase3Candidates.filter((candidate) => matchesBaseFiltersForPhase(candidate, 3));
    const filteredPhase3Candidates = basePhase3Candidates.filter((candidate) => {
        const phase3Decision = candidate?.phase3Decision || 'None';
        const matchesDecision = filterDecision === 'All'
            || (filterDecision === 'No Show_Offer Declined'
                ? (phase3Decision === 'No Show' || phase3Decision === 'Offer Declined')
                : filterDecision === 'Offer Sent'
                    ? ['Offer Sent', 'Offer Accepted', 'Joined'].includes(phase3Decision)
                    : filterDecision === 'Offer Accepted'
                        ? ['Offer Accepted', 'Joined'].includes(phase3Decision)
                        : phase3Decision === filterDecision);

        const matchesInterviewStatus = filterInterviewStatus === 'All'
            || matchesLegacyInterviewFilter(getLegacyRoundsForPhase(candidate, 3), filterInterviewStatus);

        const matchesInterviewRound = !filterInterviewRound
            || (candidate?.interviewRounds || []).some((r) =>
                String(r.levelName || '').trim().toLowerCase() === String(filterInterviewRound).trim().toLowerCase()
            );
        const matchesDynamic = matchesDynamicStageFilter(candidate, 3);

        return matchesDecision && matchesInterviewStatus && matchesInterviewRound && matchesDynamic;
    });

    const filteredCandidates = normalizedActivePhase === 2
        ? filteredPhase2Candidates
        : normalizedActivePhase === 3
            ? filteredPhase3Candidates
            : filteredPhase1Candidates;

    const safeLimit = Math.max(Number(limit) || 15, 1);
    const safePage = Math.max(Number(page) || 1, 1);
    const totalCandidates = filteredCandidates.length;
    const totalPages = Math.max(Math.ceil(totalCandidates / safeLimit), 1);
    const currentPage = Math.min(safePage, totalPages);
    const skip = (currentPage - 1) * safeLimit;
    const paginatedCandidates = filteredCandidates.slice(skip, skip + safeLimit);

    return {
        currentPage,
        totalPages,
        count: totalCandidates,
        limit: safeLimit,
        candidates: paginatedCandidates,
        summary: {
            phase1Metrics: {
                total: structuralPhase1Candidates.length,
                interested: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Interested').length,
                interviewScheduled: structuralPhase1Candidates.filter((candidate) => getLegacyRoundsForPhase(candidate, 1).length > 0).length,
                shortlisted: structuralPhase1Candidates.filter((candidate) => candidate?.decision === 'Shortlisted').length,
                rejected: structuralPhase1Candidates.filter((candidate) => candidate?.decision === 'Rejected').length,
                didNotTurnUp: structuralPhase1Candidates.filter((candidate) => candidate?.decision === 'Did Not Turn Up').length,
                onHold: structuralPhase1Candidates.filter((candidate) => candidate?.decision === 'On Hold').length,
                profileShared: structuralPhase1Candidates.filter((candidate) => isProfileSharedCandidate(candidate)).length,
                transferred: structuralPhase1Candidates.filter((candidate) => candidate?.isTransferred === true).length
            },
            phase2Metrics: {
                totalShortlisted: structuralPhase2Candidates.length,
                totalScreened: structuralPhase2Candidates.filter((candidate) => candidate?.phase2Decision === 'Shortlisted' || candidate?.phase2Decision === 'Selected').length,
                selected: structuralPhase2Candidates.filter((candidate) => candidate?.phase2Decision === 'Selected').length,
                rejected: structuralPhase2Candidates.filter((candidate) => candidate?.phase2Decision === 'Rejected').length,
                interviewScheduled: structuralPhase2Candidates.filter((candidate) => hasLegacyPhase2InterviewActivity(candidate)).length
            },
            phase3Metrics: {
                total: structuralPhase3Candidates.length,
                offerSent: structuralPhase3Candidates.filter((candidate) => ['Offer Sent', 'Offer Accepted', 'Joined'].includes(candidate?.phase3Decision)).length,
                offerAccepted: structuralPhase3Candidates.filter((candidate) => ['Offer Accepted', 'Joined'].includes(candidate?.phase3Decision)).length,
                joined: structuralPhase3Candidates.filter((candidate) => candidate?.phase3Decision === 'Joined').length,
                noShow: structuralPhase3Candidates.filter((candidate) => candidate?.phase3Decision === 'No Show' || candidate?.phase3Decision === 'Offer Declined').length
            },
            phaseBaseCounts: {
                phase1: basePhase1Candidates.length,
                phase2: basePhase2Candidates.length,
                phase3: basePhase3Candidates.length
            }
        }
    };
};

module.exports = {
    LEGACY_STATUS_VALUES,
    DEFAULT_LEGACY_CANDIDATE_STATUS,
    DUPLICATE_CANDIDATE_MESSAGE,
    canAccessHiringRequest,
    serializeCandidateForViewer,
    normalizeStatusKey,
    normalizeCandidateEmail,
    normalizeCandidateMobile,
    normalizeEntityId,
    canViewCandidateDetailsPage,
    getUserDisplayName,
    buildDuplicateCandidateQuery,
    findDuplicateCandidateInCompany,
    isCandidateOwnedByUser,
    canOverrideDuplicateCandidateOwnership,
    buildDuplicateCandidateMessage,
    resolveDynamicStatusOption,
    getInitialDynamicPhaseAssignees,
    applyDynamicImportedStatus,
    normalizePhase2InterviewStatus,
    getImplicitPhase2InterviewStatus,
    hasCandidateMovedToPhase2,
    toLegacySafeStatus,
    hasMeaningfulStatus,
    hasRealResume,
    hasMeaningfulOfferValue,
    normalizeSkillEntry,
    normalizeSkillList,
    APPLICANT_REVIEW_SELECT,
    getCandidateHiringRequestForAccess,
    ensureCandidateCapability,
    enrichCandidatesWithPublicProfiles,
    applyDateRangeFilterToCandidateQuery,
    parseBooleanQueryValue,
    parseStringArrayQuery,
    getCandidateUploadType,
    getCandidateUploadedByName,
    isProfileSharedCandidate,
    getLegacyRoundsForPhase,
    getPhase2InterviewStatusValue,
    getLegacyDisplayInterviewRoundsForPhase,
    hasLegacyPhase2InterviewActivity,
    getLegacyInterviewFilterValue,
    matchesLegacyInterviewFilter,
    getLegacyAverageRatingForPhase,
    buildLegacyCandidateListResponse
};
