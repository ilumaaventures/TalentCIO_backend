const Candidate = require('../models/Candidate');
const { HiringRequest } = require('../models/HiringRequest');
const mongoose = require('mongoose');
const Company = require('../models/Company');
const { sendEmail } = require('../services/emailService');
const { sendEmailForCompany } = require('../services/companyEmailService');
const EmailTemplate = require('../models/EmailTemplate');
const TAEmailLog = require('../models/TAEmailLog');
const NotificationService = require('../services/notificationService');
const OnboardingEmployee = require('../models/OnboardingEmployee');
const CandidateSource = require('../models/CandidateSource');
const { parseCV } = require('../utils/cvParser');
const PublicApplication = require('../models/PublicApplication');
const {
    buildInitialDynamicPhaseState,
    isDynamicHiringRequest
} = require('../utils/phaseTemplateUtils');
const { canAccessHiringRequest, getUserPermissionKeys } = require('../utils/hiringRequestAccess');
const {
    TA_CAPABILITIES,
    buildAccessibleCandidateQuery,
    canAccessCandidate,
    canAccessHiringRequestForCapability,
    isInterviewerOnlyView,
    sanitizeCandidateForInterviewer
} = require('../utils/candidateAccess');
const { serializeCandidateForViewer } = require('../utils/taVisibility');

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
        filterProfileShared = false
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
        const matchesStatus = filterStatus === 'All' || candidate?.status === filterStatus;
        const matchesDecision = filterDecision === 'All' || (candidate?.decision || 'None') === filterDecision;
        const matchesProfileShared = !filterProfileShared || isProfileSharedCandidate(candidate);
        const matchesInterviewStatus = filterInterviewStatus === 'All'
            || matchesLegacyInterviewFilter(getLegacyRoundsForPhase(candidate, 1), filterInterviewStatus);

        return matchesStatus && matchesDecision && matchesInterviewStatus && matchesProfileShared;
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
                : matchesLegacyInterviewFilter(getLegacyDisplayInterviewRoundsForPhase(candidate, 2), filterInterviewStatus));

        return matchesDecision && matchesInterviewStatus;
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

        return matchesDecision && matchesInterviewStatus;
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

// Upload resume to Cloudinary
exports.uploadResume = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;

        console.log('📤 Upload resume request for hiring request:', hiringRequestId);

        // Verify hiring request exists
        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }
        const canManageHiringRequest = await canAccessHiringRequestForCapability(hiringRequest, req.user, TA_CAPABILITIES.EDIT, req.companyId);
        if (!canManageHiringRequest) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to upload candidates for this requisition' });
        }
        const isDynamicRequest = isDynamicHiringRequest(hiringRequest);

        // Check if file is uploaded
        if (!req.file) {
            console.log('❌ No file in request');
            return res.status(400).json({ message: 'No file uploaded' });
        }

        console.log('📄 File received:', {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            path: req.file.path
        });

        // File is already uploaded to Cloudinary by multer middleware
        // req.file.path contains the Cloudinary URL
        const resumeUrl = req.file.path;

        // Extract public_id from the Cloudinary URL
        const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');
        const resumePublicId = extractPublicIdFromUrl(resumeUrl);

        console.log('✅ Resume uploaded successfully to Cloudinary');
        console.log('📎 Public ID:', resumePublicId);
        console.log('📎 Resume URL:', resumeUrl);

        res.status(200).json({
            message: 'Resume uploaded successfully',
            resumeUrl: resumeUrl,
            resumePublicId: resumePublicId
        });

    } catch (error) {
        console.error('❌ Error uploading resume:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Parse resume without saving to DB
exports.parseResume = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No resume file uploaded' });
        }

        const fileBuffer = req.file.buffer;
        const fileType = req.file.mimetype;

        const parsedData = await parseCV(fileBuffer, fileType);

        res.status(200).json({
            message: 'Resume parsed successfully',
            data: parsedData
        });

    } catch (error) {
        console.error('Error parsing resume:', error);
        res.status(500).json({ message: 'Failed to parse resume', error: error.message });
    }
};

exports.checkDuplicateCandidate = async (req, res) => {
    try {
        const { hiringRequestId, email, mobile, allowOwnedDuplicateUpdate } = req.query;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const canManageHiringRequest = await canAccessHiringRequestForCapability(
            hiringRequest,
            req.user,
            TA_CAPABILITIES.EDIT,
            req.companyId
        );

        if (!canManageHiringRequest) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to add candidates to this requisition' });
        }

        const duplicateCandidate = await findDuplicateCandidateInCompany({
            companyId: req.companyId,
            hiringRequestId,
            email,
            mobile
        });

        const ownedByCurrentUser = duplicateCandidate
            ? isCandidateOwnedByUser(duplicateCandidate, req.user?._id)
            : false;
        const hasDuplicateOverrideAccess = duplicateCandidate
            ? await canOverrideDuplicateCandidateOwnership({
                user: req.user,
                companyId: req.companyId,
                hiringRequest
            })
            : false;
        const canAutoUpdate = Boolean(allowOwnedDuplicateUpdate) && (ownedByCurrentUser || hasDuplicateOverrideAccess);

        return res.status(200).json({
            exists: Boolean(duplicateCandidate),
            canAutoUpdate,
            ownedByCurrentUser,
            uploadedByName: getUserDisplayName(duplicateCandidate?.uploadedBy),
            message: duplicateCandidate
                ? buildDuplicateCandidateMessage(duplicateCandidate, req.user?._id, canAutoUpdate)
                : ''
        });
    } catch (error) {
        console.error('Error checking duplicate candidate:', error);
        return res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const handleCandidateShortlist = async (candidate, req) => {
    const companyId = req.companyId;
    const userId = req.user._id;

    // 1. Auto Interested:
    if (candidate.status !== 'Interested') {
        candidate.status = 'Interested';
        candidate.statusHistory.push({
            status: 'Interested',
            changedBy: userId,
            changedAt: new Date(),
            remark: `Auto-updated to Interested on ${candidate.decision}`
        });
    }

    // 2. Schedule interview
    const phase1Rounds = (candidate.interviewRounds || []).filter(round => Number(round.phase || 1) === 1);
    
    if (phase1Rounds.length === 0) {
        // Find hiring request to see if it has an interview workflow
        const hiringRequest = await HiringRequest.findOne({ _id: candidate.hiringRequestId, companyId }).populate('interviewWorkflowId');
        
        let roundsToAdd = [];
        if (hiringRequest && hiringRequest.interviewWorkflowId && hiringRequest.interviewWorkflowId.rounds && hiringRequest.interviewWorkflowId.rounds.length > 0) {
            roundsToAdd = hiringRequest.interviewWorkflowId.rounds.map((r, index) => ({
                levelName: `Round ${index + 1}`,
                assignedTo: [], // Evaluator is always unassigned on shortlist; assigned manually later
                status: 'Scheduled',
                phase: 1
            }));
        } else {
            roundsToAdd = [{
                levelName: 'Round 1',
                assignedTo: [],
                status: 'Scheduled',
                phase: 1
            }];
        }
        
        if (!candidate.interviewRounds) {
            candidate.interviewRounds = [];
        }
        candidate.interviewRounds.push(...roundsToAdd);
        return { hasNewRounds: true, roundsToAdd };
    }
    return { hasNewRounds: false };
};

const sendAutoScheduleNotifications = async (candidate, roundsToAdd, req) => {
    const app = req.app;
    const io = app ? app.get('io') : null;
    if (!io) return;

    const origin = req.headers ? req.headers.origin : undefined;
    
    const notifications = [];
    candidate.interviewRounds.forEach(savedRound => {
        const matchedInput = roundsToAdd.find(r => r.levelName === savedRound.levelName && Number(savedRound.phase || 1) === 1);
        if (matchedInput && savedRound.assignedTo && savedRound.assignedTo.length > 0) {
            const roundPhase = Number(savedRound.phase || 1);
            savedRound.assignedTo.forEach(userId => {
                notifications.push({
                    user: userId,
                    companyId: req.companyId,
                    preferenceKey: 'interview_assigned',
                    title: 'New Interview Assigned',
                    message: `You have been assigned to evaluate ${candidate.candidateName} for the ${savedRound.levelName} round.`,
                    type: 'Interview',
                    link: `/ta/hiring-request/${candidate.hiringRequestId._id || candidate.hiringRequestId}/candidate/${candidate._id}/view?phase=${roundPhase}`,
                    origin: origin,
                    metadata: {
                        candidateId: candidate._id,
                        roundId: savedRound._id,
                        hiringRequestId: candidate.hiringRequestId._id || candidate.hiringRequestId,
                        phase: roundPhase
                    }
                });
            });
        }
    });

    if (notifications.length > 0) {
        await NotificationService.createManyNotifications(io, notifications);

        notifications.forEach(notif => {
            NotificationService.emitToUser(io, notif.user, 'interview_update', {
                candidateId: candidate._id,
                candidateName: candidate.candidateName,
                roundId: notif.metadata.roundId
            });
        });
    }
};

// Create new candidate
exports.createCandidate = async (req, res) => {
    try {
        const {
            hiringRequestId,
            resumeUrl,
            resumePublicId,
            candidateName,
            email,
            mobile,
            source,
            referralName,
            profilePulledBy,
            calledBy,
            rate,
            currentCTC,
            expectedCTC,
            profileShared,
            phase2Decision,
            phase2InterviewerFeedback,
            phase2InterviewStatus,
            inHandOffer,
            offerCompany,
            offerCTC,
            offerJoiningDate,
            preference,
            totalExperience,
            qualification,
            currentCompany,
            pastExperience,
            currentLocation,
            preferredLocation,
            tatToJoin,
            noticePeriod,
            lastWorkingDay,
            status,
            remark,
            mustHaveSkills,
            niceToHaveSkills,
            interviewRounds
        } = req.body;
        const normalizedMustHaveSkills = normalizeSkillList(mustHaveSkills);
        const normalizedNiceToHaveSkills = normalizeSkillList(niceToHaveSkills);

        const normalizedSource = String(source || '').trim();
        const normalizedReferralName = normalizedSource === 'Referral'
            ? String(referralName || '').trim()
            : '';
        const normalizedPhase2InterviewStatus = phase2InterviewStatus === undefined
            ? undefined
            : normalizePhase2InterviewStatus(phase2InterviewStatus);
        const shouldMarkProfileSharedForPhase2 = normalizedPhase2InterviewStatus && normalizedPhase2InterviewStatus !== 'None';
        const normalizedInHandOffer = Boolean(inHandOffer) ||
            hasMeaningfulOfferValue(offerCompany) ||
            hasMeaningfulOfferValue(offerCTC) ||
            hasMeaningfulOfferValue(offerJoiningDate);
        const allowOwnedDuplicateUpdate = Boolean(req.body.allowOwnedDuplicateUpdate);

        if (phase2InterviewStatus !== undefined && normalizedPhase2InterviewStatus === null) {
            return res.status(400).json({ message: 'Phase 2 Interview Status must be Scheduled, Rejected, Shortlisted, or Did not Turn up' });
        }

        // Verify hiring request exists
        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        let candidate = null;
        if (req.body._id && mongoose.Types.ObjectId.isValid(req.body._id)) {
            candidate = await Candidate.findOne({
                _id: req.body._id,
                hiringRequestId,
                companyId: req.companyId
            }).populate('uploadedBy', 'firstName lastName email');
        }

        if (!candidate) {
            const orConditions = [];
            if (email && typeof email === 'string') {
                orConditions.push({ email: email.toLowerCase().trim() });
            }
            if (mobile && typeof mobile === 'string') {
                orConditions.push({ mobile: mobile.trim() });
            }

            if (orConditions.length > 0) {
                candidate = await Candidate.findOne({
                    hiringRequestId,
                    $or: orConditions,
                    companyId: req.companyId
                }).populate('uploadedBy', 'firstName lastName email');
            }
        }

        const { isCandidateRoundAssignee } = require('../utils/taAccess');
        const isInterviewerForCandidate = candidate ? isCandidateRoundAssignee(candidate, req.user) : false;

        const canManageHiringRequest = await canAccessHiringRequestForCapability(hiringRequest, req.user, TA_CAPABILITIES.EDIT, req.companyId);
        if (!canManageHiringRequest && !isInterviewerForCandidate) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to add candidates to this requisition' });
        }

        const isDynamicRequest = isDynamicHiringRequest(hiringRequest);
        const normalizedLegacyStatus = isDynamicRequest
            ? ''
            : toLegacySafeStatus(hasMeaningfulStatus(status) ? status : DEFAULT_LEGACY_CANDIDATE_STATUS);

        if (candidate) {
            const ownedByCurrentUser = isCandidateOwnedByUser(candidate, req.user?._id);
            const hasDuplicateOverrideAccess = await canOverrideDuplicateCandidateOwnership({
                user: req.user,
                companyId: req.companyId,
                hiringRequest
            });
            const canAutoUpdateExistingCandidate = allowOwnedDuplicateUpdate && (ownedByCurrentUser || hasDuplicateOverrideAccess || isInterviewerForCandidate);

            if (!canAutoUpdateExistingCandidate) {
                return res.status(409).json({
                    message: buildDuplicateCandidateMessage(candidate, req.user?._id, canAutoUpdateExistingCandidate),
                    ownedByCurrentUser,
                    canAutoUpdate: canAutoUpdateExistingCandidate,
                    uploadedByName: getUserDisplayName(candidate.uploadedBy)
                });
            }

            const { hasAccess } = await ensureCandidateCapability(
                candidate,
                req.companyId,
                req.user,
                TA_CAPABILITIES.EDIT,
                { hiringRequest }
            );
            if (!hasAccess) {
                return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
            }
            // Update mode
            console.log('🔄 Existing candidate found, updating fields...');

            // Track status change for history
            const statusChanged = !isDynamicRequest && normalizedLegacyStatus && candidate.status !== normalizedLegacyStatus;
            const updatedFields = [];
            const compareAndUpdate = (field, newValue, label) => {
                if (newValue !== undefined && newValue !== null && newValue !== '' && candidate[field] !== newValue) {
                    candidate[field] = newValue;
                    updatedFields.push(label || field);
                }
            };
            const forceUpdateField = (field, newValue, label) => {
                if (candidate[field] !== newValue) {
                    candidate[field] = newValue;
                    updatedFields.push(label || field);
                }
            };

            if (canManageHiringRequest) {
                compareAndUpdate('candidateName', candidateName, 'Name');
                compareAndUpdate('source', normalizedSource, 'Source');
                if (candidate.referralName !== normalizedReferralName) {
                    candidate.referralName = normalizedReferralName;
                    updatedFields.push('Referral Name');
                }
                compareAndUpdate('profilePulledBy', profilePulledBy, 'Pulled By');
                compareAndUpdate('calledBy', calledBy, 'Called By');
                compareAndUpdate('rate', rate, 'Rate');
                compareAndUpdate('currentCTC', currentCTC, 'Current CTC');
                compareAndUpdate('expectedCTC', expectedCTC, 'Expected CTC');
                compareAndUpdate('inHandOffer', normalizedInHandOffer, 'Offer in Hand');
                compareAndUpdate('offerCompany', offerCompany, 'Offer Company');
                compareAndUpdate('offerCTC', offerCTC, 'Offer CTC');
                compareAndUpdate('offerJoiningDate', offerJoiningDate, 'Offer Joining Date');
                compareAndUpdate('totalExperience', totalExperience, 'Experience');
                compareAndUpdate('qualification', qualification, 'Qualification');
                compareAndUpdate('currentCompany', currentCompany, 'Company');
                compareAndUpdate('currentLocation', currentLocation, 'Location');
                compareAndUpdate('preferredLocation', preferredLocation, 'Preferred Location');
                compareAndUpdate('tatToJoin', tatToJoin, 'TAT Join');
                compareAndUpdate('noticePeriod', noticePeriod, 'Notice Period');
                compareAndUpdate('lastWorkingDay', lastWorkingDay, 'DOJ/LWD');
                if (isDynamicRequest) {
                    const previousDynamicStatus = candidate.currentPhaseStatus || '';
                    const dynamicStatusApplied = applyDynamicImportedStatus(candidate, hiringRequest, status);
                    if (hasMeaningfulStatus(status) && !dynamicStatusApplied) {
                        return res.status(400).json({
                            message: `Status "${status}" is not valid for the current dynamic phase`
                        });
                    }
                    if (dynamicStatusApplied && previousDynamicStatus !== candidate.currentPhaseStatus) {
                        updatedFields.push('Status');
                    }
                } else {
                    compareAndUpdate('status', normalizedLegacyStatus, 'Status');
                }
                if (allowOwnedDuplicateUpdate) {
                    const importedDecision = String(req.body.decision || '').trim() || 'None';
                    forceUpdateField('decision', importedDecision, 'Decision');
                    forceUpdateField('profileShared', Boolean(profileShared), 'Profile Shared');
                } else {
                    const phase1Locked = hasCandidateMovedToPhase2(candidate);
                    if (!phase1Locked) {
                        compareAndUpdate('decision', req.body.decision, 'Decision');
                    }
                    if (!phase1Locked || profileShared !== false) {
                        compareAndUpdate('profileShared', profileShared, 'Profile Shared');
                    }
                }
                compareAndUpdate('phase2Decision', phase2Decision, 'Phase 2 Decision');
                compareAndUpdate('remark', remark, 'Remark');
                if (phase2InterviewerFeedback !== undefined) {
                    compareAndUpdate('phase2InterviewerFeedback', phase2InterviewerFeedback, 'Phase 2 Interviewer Feedback');
                }
                if (normalizedPhase2InterviewStatus !== undefined) {
                    compareAndUpdate('phase2InterviewStatus', normalizedPhase2InterviewStatus, 'Phase 2 Interview Status');
                } else {
                    const implicitPhase2InterviewStatus = getImplicitPhase2InterviewStatus(phase2Decision);
                    if (implicitPhase2InterviewStatus !== undefined) {
                        compareAndUpdate('phase2InterviewStatus', implicitPhase2InterviewStatus, 'Phase 2 Interview Status');
                    }
                }
                if ((shouldMarkProfileSharedForPhase2 || Boolean(String(phase2InterviewerFeedback || '').trim())) && !candidate.profileShared) {
                    candidate.profileShared = true;
                    updatedFields.push('Profile Shared');
                }

                if (hasRealResume(resumeUrl) && !hasRealResume(candidate.resumeUrl)) {
                    candidate.resumeUrl = resumeUrl;
                    candidate.resumePublicId = resumePublicId;
                    updatedFields.push('Resume');
                }

                if (mustHaveSkills && Array.isArray(mustHaveSkills)) {
                    const existingSkills = candidate.mustHaveSkills || [];
                    const skillsChanged = existingSkills.length !== normalizedMustHaveSkills.length ||
                        normalizedMustHaveSkills.some((s, idx) =>
                            !existingSkills[idx] ||
                            existingSkills[idx].skill !== s.skill ||
                            existingSkills[idx].experience !== s.experience
                        );

                    if (skillsChanged) {
                        candidate.mustHaveSkills = normalizedMustHaveSkills;
                        updatedFields.push('Skills');
                    }
                }
                if (niceToHaveSkills && Array.isArray(niceToHaveSkills)) {
                    candidate.niceToHaveSkills = normalizedNiceToHaveSkills;
                }
                if (interviewRounds && Array.isArray(interviewRounds)) {
                    const existingRounds = candidate.interviewRounds || [];
                    const mergedRounds = interviewRounds.map((incomingRound, idx) => {
                        const existingRound = existingRounds.find(er => 
                            String(er.levelName).trim().toLowerCase() === String(incomingRound.levelName).trim().toLowerCase()
                        ) || existingRounds[idx];

                        if (existingRound) {
                            return {
                                ...incomingRound,
                                assignedTo: (incomingRound.assignedTo && incomingRound.assignedTo.length > 0)
                                    ? incomingRound.assignedTo
                                    : existingRound.assignedTo,
                                evaluatedBy: incomingRound.evaluatedBy || existingRound.evaluatedBy,
                                evaluatedAt: incomingRound.evaluatedAt || existingRound.evaluatedAt,
                                _id: existingRound._id
                            };
                        }
                        return incomingRound;
                    });

                    const roundsChanged = existingRounds.length !== mergedRounds.length ||
                        mergedRounds.some((r, idx) => {
                            const er = existingRounds[idx];
                            if (!er) return true;
                            return er.levelName !== r.levelName ||
                                er.status !== r.status ||
                                er.feedback !== r.feedback ||
                                er.rating !== r.rating ||
                                er.evaluatedBy?.toString() !== r.evaluatedBy?.toString() ||
                                JSON.stringify(er.assignedTo?.map(id => id.toString())) !== JSON.stringify(r.assignedTo?.map(id => id.toString()));
                        });

                    if (roundsChanged) {
                        candidate.interviewRounds = mergedRounds;
                        updatedFields.push('Interview History');
                    }
                }
            } else {
                // User is an interviewer: Only update assigned interview rounds, keep everything else as old data
                if (interviewRounds && Array.isArray(interviewRounds)) {
                    const existingRounds = candidate.interviewRounds || [];
                    const userId = req.user._id.toString();
                    let roundsUpdated = false;

                    const updatedRounds = existingRounds.map((er, idx) => {
                        const isAssigned = er.assignedTo && er.assignedTo.some(id => id.toString() === userId || id._id?.toString() === userId);
                        if (isAssigned) {
                            // Find matching round in incoming interviewRounds by name, round number, or fallback to index
                            const erRoundNum = idx + 1;
                            const incoming = interviewRounds.find(r => {
                                const nameMatch = String(r.levelName).trim().toLowerCase() === String(er.levelName).trim().toLowerCase();
                                if (nameMatch) return true;
                                
                                const erMatch = String(er.levelName).toLowerCase().match(/round\s*(\d+)/i);
                                const rMatch = String(r.levelName).toLowerCase().match(/round\s*(\d+)/i);
                                if (rMatch) {
                                    const rNum = parseInt(rMatch[1], 10);
                                    if (erMatch) {
                                        return parseInt(erMatch[1], 10) === rNum;
                                    }
                                    return erRoundNum === rNum;
                                }
                                return false;
                            }) || interviewRounds[idx];

                            if (incoming) {
                                let roundChanged = false;
                                if (incoming.status && er.status !== incoming.status) {
                                    er.status = incoming.status;
                                    roundChanged = true;
                                }
                                if (incoming.scheduledDate && (!er.scheduledDate || new Date(er.scheduledDate).getTime() !== new Date(incoming.scheduledDate).getTime())) {
                                    er.scheduledDate = incoming.scheduledDate;
                                    roundChanged = true;
                                }
                                if (incoming.feedback !== undefined && er.feedback !== incoming.feedback) {
                                    er.feedback = incoming.feedback;
                                    roundChanged = true;
                                }
                                if (incoming.rating !== undefined && er.rating !== incoming.rating) {
                                    er.rating = incoming.rating;
                                    roundChanged = true;
                                }
                                if (incoming.evaluatedBy && er.evaluatedBy?.toString() !== incoming.evaluatedBy?.toString()) {
                                    er.evaluatedBy = incoming.evaluatedBy;
                                    roundChanged = true;
                                }
                                if (incoming.skillRatings && Array.isArray(incoming.skillRatings)) {
                                    er.skillRatings = incoming.skillRatings;
                                    roundChanged = true;
                                }

                                if (roundChanged) {
                                    roundsUpdated = true;
                                }
                            }
                        }
                        return er;
                    });

                    if (roundsUpdated) {
                        candidate.interviewRounds = updatedRounds;
                        updatedFields.push('Interview History');
                    }
                }
            }

            if (statusChanged) {
                candidate.statusHistory.push({
                    status: normalizedLegacyStatus,
                    changedBy: req.user._id,
                    changedAt: new Date(),
                    remark: `Updated via Bulk Import: ${remark || ''}`
                });
            }

            let shortlistResult = null;
            if (['Shortlisted', 'Rejected', 'Did Not Turn Up'].includes(candidate.decision)) {
                shortlistResult = await handleCandidateShortlist(candidate, req);
            }

            await candidate.save();

            if (shortlistResult && shortlistResult.hasNewRounds) {
                await sendAutoScheduleNotifications(candidate, shortlistResult.roundsToAdd, req);
            }

            const populatedUpdate = await Candidate.findOne({ _id: candidate._id, companyId: req.companyId })
                .populate('uploadedBy', 'firstName lastName email')
                .populate('hiringRequestId', 'requestId roleDetails')
                .populate('interviewRounds.assignedTo', 'firstName lastName email')
                .populate('interviewRounds.evaluatedBy', 'firstName lastName');

            return res.status(200).json({
                message: 'Candidate updated successfully',
                candidate: populatedUpdate,
                isUpdate: true,
                updatedFields
            });
        }

        // Create mode (original logic continue)
        const legacySafeStatus = normalizedLegacyStatus;

        candidate = new Candidate({
            companyId: req.companyId,
            hiringRequestId,
            resumeUrl,
            resumePublicId,
            uploadedBy: req.user._id,
            candidateName,
            email: normalizeCandidateEmail(email),
            mobile: normalizeCandidateMobile(mobile),
            source: normalizedSource,
            referralName: normalizedReferralName,
            profilePulledBy,
            calledBy,
            rate,
            currentCTC,
            expectedCTC,
            profileShared: Boolean(profileShared) || Boolean(phase2Decision && phase2Decision !== 'None') || Boolean(String(phase2InterviewerFeedback || '').trim()) || Boolean(shouldMarkProfileSharedForPhase2),
            phase2Decision: phase2Decision || 'None',
            phase2InterviewerFeedback,
            phase2InterviewStatus: normalizedPhase2InterviewStatus || getImplicitPhase2InterviewStatus(phase2Decision) || 'None',
            inHandOffer: normalizedInHandOffer,
            offerCompany,
            offerCTC,
            offerJoiningDate,
            preference,
            totalExperience,
            qualification,
            currentCompany,
            pastExperience,
            currentLocation,
            preferredLocation,
            tatToJoin,
            noticePeriod,
            lastWorkingDay,
            decision: req.body.decision || 'None',
            status: legacySafeStatus,
            remark,
            mustHaveSkills: normalizedMustHaveSkills,
            niceToHaveSkills: normalizedNiceToHaveSkills,
            interviewRounds: interviewRounds || [],
            statusHistory: legacySafeStatus ? [{
                status: legacySafeStatus,
                changedBy: req.user._id,
                changedAt: new Date(),
                remark
            }] : []
        });

        if (isDynamicRequest) {
            const dynamicStatusApplied = applyDynamicImportedStatus(candidate, hiringRequest, status);
            if (hasMeaningfulStatus(status) && !dynamicStatusApplied) {
                return res.status(400).json({
                    message: `Status "${status}" is not valid for the current dynamic phase`
                });
            }
        }

        let shortlistResult = null;
        if (['Shortlisted', 'Rejected', 'Did Not Turn Up'].includes(candidate.decision)) {
            shortlistResult = await handleCandidateShortlist(candidate, req);
        }

        await candidate.save();

        if (shortlistResult && shortlistResult.hasNewRounds) {
            await sendAutoScheduleNotifications(candidate, shortlistResult.roundsToAdd, req);
        }

        const populatedCandidate = await Candidate.findOne({ _id: candidate._id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        res.status(201).json({
            message: 'Candidate created successfully',
            candidate: populatedCandidate,
            isUpdate: false
        });

    } catch (error) {
        console.error('Error creating candidate:', error);
        if (error.code === 11000) {
            return res.status(409).json({ message: DUPLICATE_CANDIDATE_MESSAGE });
        }
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get all candidates for a hiring request
exports.getCandidatesByHiringRequest = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;
        const {
            dateField,
            startDate,
            endDate,
            paginate,
            page = 1,
            limit = 15
        } = req.query;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasHiringRequestAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });

        if (!hasHiringRequestAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        const candidateQuery = await buildAccessibleCandidateQuery(
            req.companyId,
            req.user,
            { hiringRequestId },
            { capability: TA_CAPABILITIES.VIEW }
        );

        applyDateRangeFilterToCandidateQuery(candidateQuery, dateField, startDate, endDate);

        const candidates = await Candidate.find(candidateQuery)
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('applicantId', APPLICANT_REVIEW_SELECT)
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName')
            .sort({ uploadedAt: -1 })
            .lean();

        const enrichedCandidates = await enrichCandidatesWithPublicProfiles(candidates, req.companyId);
        const serializedCandidates = enrichedCandidates.map((candidate) => serializeCandidateForViewer({
            candidate,
            user: req.user,
            hiringRequest
        }));

        if (parseBooleanQueryValue(paginate)) {
            const paginatedResponse = buildLegacyCandidateListResponse({
                candidates: serializedCandidates,
                filters: {
                    activePhase: req.query.activePhase,
                    search: req.query.search,
                    filterPreference: req.query.filterPreference,
                    filterStatus: req.query.filterStatus,
                    filterDecision: req.query.filterDecision,
                    filterExperience: req.query.filterExperience,
                    filterInterviewStatus: req.query.filterInterviewStatus,
                    filterRating: req.query.filterRating,
                    filterPulledBy: req.query.filterPulledBy,
                    filterUploadedBy: req.query.filterUploadedBy,
                    filterUploadType: req.query.filterUploadType,
                    filterTransferred: req.query.filterTransferred,
                    filterProfileShared: parseBooleanQueryValue(req.query.filterProfileShared)
                },
                page,
                limit
            });

            return res.status(200).json(paginatedResponse);
        }

        res.status(200).json({
            count: serializedCandidates.length,
            candidates: serializedCandidates
        });

    } catch (error) {
        console.error('Error fetching candidates:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get shortlisted candidates for a hiring request with pagination
exports.getShortlistedCandidates = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasHiringRequestAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });

        if (!hasHiringRequestAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        const query = await buildAccessibleCandidateQuery(req.companyId, req.user, {
            hiringRequestId,
            $or: [
                { profileShared: true },
                { profileShared: { $exists: false }, decision: 'Shortlisted' }
            ]
        }, { capability: TA_CAPABILITIES.VIEW });

        const totalOptions = await Candidate.countDocuments(query);
        const candidates = await Candidate.find(query)
            .populate('uploadedBy', 'firstName lastName')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName') // only pull what is necessary
            .populate('interviewRounds.evaluatedBy', 'firstName lastName')
            .select('candidateName email mobile status decision profileShared uploadedAt interviewRounds profilePulledBy calledBy rate totalExperience currentCTC expectedCTC pastExperience currentCompany offerCompany offerJoiningDate lastWorkingDay currentLocation preferredLocation noticePeriod tatToJoin qualification remark customRemark mustHaveSkills skillRatings phase2Decision phase2InterviewerFeedback phase2InterviewStatus')
            .sort({ uploadedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const serializedCandidates = candidates.map((candidate) => serializeCandidateForViewer({
            candidate,
            user: req.user,
            hiringRequest
        }));

        res.status(200).json({
            count: totalOptions,
            totalPages: Math.ceil(totalOptions / limit),
            currentPage: page,
            candidates: serializedCandidates
        });

    } catch (error) {
        console.error('Error fetching shortlisted candidates:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const getCandidateByIdPayload = async (req) => {
    const { id } = req.params;

    let candidateData = await Candidate.findOne({ _id: id, companyId: req.companyId })
        .populate('uploadedBy', 'firstName lastName email')
        .populate('hiringRequestId', 'requestId roleDetails requirements')
        .populate('applicantId', APPLICANT_REVIEW_SELECT)
        .populate('statusHistory.changedBy', 'firstName lastName')
        .populate('interviewRounds.assignedTo', 'firstName lastName email')
        .populate('interviewRounds.evaluatedBy', 'firstName lastName')
        .lean();

    if (!candidateData) {
        return { status: 404, body: { message: 'Candidate not found' } };
    }

    const hiringRequest = await getCandidateHiringRequestForAccess(candidateData, req.companyId);
    const { hasAccess } = await ensureCandidateCapability(
        candidateData,
        req.companyId,
        req.user,
        TA_CAPABILITIES.VIEW,
        { hiringRequest }
    );
    if (!hasAccess) {
        return { status: 403, body: { message: 'Forbidden: You do not have permission to view this candidate' } };
    }

    if (candidateData.hiringRequestId?.requirements) {
        const hrr = candidateData.hiringRequestId.requirements;
        const currentRatings = candidateData.skillRatings || [];
        let hasChanges = false;

        const syncSkills = (skills, category) => {
            if (!skills || !Array.isArray(skills)) return;
            skills.forEach((skill) => {
                const exists = currentRatings.some((rating) => rating.skill.toLowerCase() === skill.toLowerCase());
                if (!exists) {
                    currentRatings.push({ skill, rating: 0, category });
                    hasChanges = true;
                }
            });
        };

        const mustHaveSkillList = Array.isArray(hrr.mustHaveSkills)
            ? hrr.mustHaveSkills
            : [
                ...(Array.isArray(hrr.mustHaveSkills?.technical) ? hrr.mustHaveSkills.technical : []),
                ...(Array.isArray(hrr.mustHaveSkills?.softSkills) ? hrr.mustHaveSkills.softSkills : [])
            ];

        syncSkills(mustHaveSkillList, 'Must-Have');
        syncSkills(hrr.niceToHaveSkills, 'Nice-To-Have');

        if (hasChanges) {
            await Candidate.findOneAndUpdate({ _id: id, companyId: req.companyId }, { $set: { skillRatings: currentRatings } });
            candidateData.skillRatings = currentRatings;
        }
    }

    let candidate = await enrichCandidatesWithPublicProfiles(candidateData, req.companyId);
    const hasHiringRequestAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });

    if (!hasHiringRequestAccess) {
        const interviewerOnly = await isInterviewerOnlyView({
            candidate,
            hiringRequest,
            companyId: req.companyId,
            user: req.user
        });

        if (!interviewerOnly) {
            return { status: 403, body: { message: 'Forbidden: You do not have permission to view this candidate' } };
        }

        candidate = sanitizeCandidateForInterviewer(candidate);
    }

    return {
        status: 200,
        body: serializeCandidateForViewer({
            candidate,
            user: req.user,
            hiringRequest,
            interviewerOnly: !hasHiringRequestAccess
        })
    };
};

// Get single candidate by ID
exports.getCandidateById = async (req, res) => {
    try {
        const response = await getCandidateByIdPayload(req);
        res.status(response.status).json(response.body);
    } catch (error) {
        console.error('Error fetching candidate:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.getCandidateDetailsById = async (req, res) => {
    try {
        const { id } = req.params;
        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { isCandidateRoundAssignee } = require('../utils/taAccess');
        const isInterviewer = isCandidateRoundAssignee(candidate, req.user);

        if (!canViewCandidateDetailsPage(req.user) && !isInterviewer) {
            return res.status(403).json({
                message: 'Forbidden: Candidate details page requires ta.candidate.manage.all or ta.candidate.manage.assigned'
            });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({
                message: 'Forbidden: You do not have permission to open this candidate details page'
            });
        }

        const response = await getCandidateByIdPayload(req);
        res.status(response.status).json(response.body);
    } catch (error) {
        console.error('Error fetching candidate details:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate
exports.updateCandidate = async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        // Check if email is being changed and if it conflicts
        if (updateData.email && updateData.email !== candidate.email) {
            const existingCandidate = await Candidate.findOne({ hiringRequestId: candidate.hiringRequestId, email: updateData.email, _id: { $ne: id }, companyId: req.companyId });
            if (existingCandidate) {
                return res.status(400).json({ message: 'Another candidate with this email already exists for this hiring request' });
            }
        }

        // Track status change
        if (updateData.status !== undefined && updateData.status !== candidate.status) {
            candidate.statusHistory.push({
                status: updateData.status,
                changedBy: req.user._id,
                changedAt: new Date(),
                remark: updateData.remark || ''
            });
        }

        // Update fields securely (prevent mass assignment)
        const allowedUpdates = [
            'candidateName', 'email', 'mobile', 'source', 'referralName',
            'profilePulledBy', 'calledBy', 'rate', 'currentCTC', 'expectedCTC', 'inHandOffer', 'offerCompany', 'offerCTC', 'offerJoiningDate',
            'preference', 'totalExperience', 'qualification', 'currentCompany', 'pastExperience',
            'currentLocation', 'preferredLocation', 'tatToJoin', 'noticePeriod',
            'status', 'remark', 'lastWorkingDay',
            'mustHaveSkills', 'niceToHaveSkills',
            'phase2InterviewerFeedback', 'phase2InterviewStatus'
        ];

        if (updateData.source !== undefined) {
            updateData.source = String(updateData.source || '').trim();
        }

        if (updateData.referralName !== undefined || updateData.source === 'Referral') {
            updateData.referralName = updateData.source === 'Referral'
                ? String(updateData.referralName || '').trim()
                : '';
        }

        updateData.inHandOffer = Boolean(updateData.inHandOffer) ||
            hasMeaningfulOfferValue(updateData.offerCompany) ||
            hasMeaningfulOfferValue(updateData.offerCTC) ||
            hasMeaningfulOfferValue(updateData.offerJoiningDate);

        if (updateData.mustHaveSkills !== undefined) {
            updateData.mustHaveSkills = normalizeSkillList(updateData.mustHaveSkills);
        }

        if (updateData.niceToHaveSkills !== undefined) {
            updateData.niceToHaveSkills = normalizeSkillList(updateData.niceToHaveSkills);
        }

        if (updateData.phase2InterviewStatus !== undefined) {
            updateData.phase2InterviewStatus = normalizePhase2InterviewStatus(updateData.phase2InterviewStatus);
            if (updateData.phase2InterviewStatus === null) {
                return res.status(400).json({ message: 'Phase 2 Interview Status must be Scheduled, Rejected, Shortlisted, or Did not Turn up' });
            }
        } else if (updateData.phase2Decision !== undefined) {
            const implicitPhase2InterviewStatus = getImplicitPhase2InterviewStatus(updateData.phase2Decision);
            if (implicitPhase2InterviewStatus !== undefined) {
                updateData.phase2InterviewStatus = implicitPhase2InterviewStatus;
            }
        }

        allowedUpdates.forEach(field => {
            if (updateData[field] !== undefined) {
                candidate[field] = updateData[field];
            }
        });

        if (updateData.profileShared !== undefined) {
            if (Boolean(updateData.profileShared)) {
                candidate.profileShared = true;
            } else if (hasCandidateMovedToPhase2(candidate)) {
                return res.status(400).json({ message: 'Phase 2 candidates cannot be removed from the next phase using this action' });
            } else {
                candidate.profileShared = false;
            }
        }

        if (
            (updateData.phase2InterviewStatus && updateData.phase2InterviewStatus !== 'None')
            || Boolean(String(updateData.phase2InterviewerFeedback || '').trim())
        ) {
            candidate.profileShared = true;
        }

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Candidate updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating candidate:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Delete candidate
exports.deleteCandidate = async (req, res) => {
    try {
        const { id } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to delete this candidate' });
        }

        // Clear isTransferredToOnboarding and delete onboarding record if candidate was transferred
        if (candidate.isTransferredToOnboarding) {
            candidate.isTransferredToOnboarding = false;
            await candidate.save();
            await OnboardingEmployee.deleteOne({ candidateId: id, companyId: req.companyId });
        }

        await candidate.softDelete(req.user._id);

        res.status(200).json({ message: 'Candidate moved to bin' });

    } catch (error) {
        console.error('Error deleting candidate:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate status
exports.updateCandidateStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, remark } = req.body;

        if (!status) {
            return res.status(400).json({ message: 'Status is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        // Add to status history
        candidate.statusHistory.push({
            status,
            changedBy: req.user._id,
            changedAt: new Date(),
            remark: remark || ''
        });

        candidate.status = status;
        if (remark) candidate.remark = remark;

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('statusHistory.changedBy', 'firstName lastName');

        res.status(200).json({
            message: 'Status updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate remark
exports.updateCandidateRemark = async (req, res) => {
    try {
        const { id } = req.params;
        const { remark } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.remark = remark;
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Remark updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating remark:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate internal remark (separate from sourcing remark)
exports.updateCandidateInternalRemark = async (req, res) => {
    try {
        const { id } = req.params;
        const { internalRemark } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.internalRemark = internalRemark;
        await candidate.save();

        res.status(200).json({
            message: 'Internal remark updated successfully',
            internalRemark: candidate.internalRemark
        });

    } catch (error) {
        console.error('Error updating internal remark:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate decision
exports.updateCandidateDecision = async (req, res) => {
    try {
        const { id } = req.params;
        const { decision, profileShared } = req.body;

        if (!decision) {
            return res.status(400).json({ message: 'Decision is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.MAKE_DECISION);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        if (hasCandidateMovedToPhase2(candidate)) {
            return res.status(400).json({ message: 'Phase 1 decision cannot be changed after the candidate has moved to Phase 2' });
        }

        candidate.decision = decision;
        if (profileShared !== undefined) {
            candidate.profileShared = Boolean(profileShared);
        }

        let shortlistResult = null;
        if (['Shortlisted', 'Rejected', 'Did Not Turn Up', 'Left in between'].includes(decision)) {
            shortlistResult = await handleCandidateShortlist(candidate, req);
        }

        await candidate.save();

        if (shortlistResult && shortlistResult.hasNewRounds) {
            await sendAutoScheduleNotifications(candidate, shortlistResult.roundsToAdd, req);
        }

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Decision updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating decision:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Bulk update candidate decision
exports.bulkUpdateDecision = async (req, res) => {
    try {
        const { candidateIds, decision, phaseId, phase } = req.body;

        if (!decision) {
            return res.status(400).json({ message: 'Decision is required' });
        }

        if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
            return res.status(400).json({ message: 'At least one candidate must be selected' });
        }

        const validCandidateIds = candidateIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        if (validCandidateIds.length === 0) {
            return res.status(400).json({ message: 'No valid candidate IDs provided' });
        }

        const candidates = await Candidate.find({
            _id: { $in: validCandidateIds },
            companyId: req.companyId
        });

        let updatedCount = 0;
        for (const candidate of candidates) {
            try {
                const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.MAKE_DECISION);
                if (!hasAccess) continue;

                if (phaseId && candidate.currentPhaseId && String(candidate.currentPhaseId) === String(phaseId)) {
                    const targetPhaseIdStr = String(phaseId);
                    let phaseEntryIndex = (candidate.phaseHistory || []).findIndex(
                        entry => entry.phaseId && String(entry.phaseId) === targetPhaseIdStr
                    );

                    if (phaseEntryIndex >= 0) {
                        candidate.phaseHistory[phaseEntryIndex].decision = decision;
                        candidate.phaseHistory[phaseEntryIndex].updatedAt = new Date();
                    } else {
                        candidate.phaseHistory.push({
                            phaseId,
                            phaseName: 'Dynamic Phase',
                            phaseOrder: candidate.currentPhaseOrder || 1,
                            status: '',
                            decision,
                            enteredAt: new Date()
                        });
                    }

                    if (['Shortlisted', 'Selected', 'Rejected', 'On Hold', 'Did Not Turn Up', 'Left in between'].includes(decision)) {
                        candidate.decision = decision;
                    }
                    await candidate.save();
                    updatedCount++;
                } else if (Number(phase) === 2) {
                    candidate.phase2Decision = decision;
                    if (decision === 'Selected') {
                        candidate.profileShared = true;
                        candidate.phase2InterviewStatus = 'Shortlisted';
                    } else if (decision === 'Shortlisted') {
                        candidate.profileShared = true;
                        candidate.phase2InterviewStatus = 'None';
                    } else if (decision === 'Rejected') {
                        candidate.phase2InterviewStatus = 'Rejected';
                    }
                    await candidate.save();
                    updatedCount++;
                } else if (Number(phase) === 3) {
                    candidate.phase3Decision = decision;
                    await candidate.save();
                    updatedCount++;
                } else {
                    candidate.decision = decision;
                    if (['Shortlisted', 'Rejected', 'Did Not Turn Up', 'Left in between'].includes(decision)) {
                        await handleCandidateShortlist(candidate, req);
                    }
                    await candidate.save();
                    updatedCount++;
                }
            } catch (err) {
                console.error(`Error updating decision for candidate ${candidate._id}:`, err);
            }
        }

        res.status(200).json({
            message: `Updated decision to "${decision}" for ${updatedCount} candidate(s)`,
            updatedCount
        });
    } catch (error) {
        console.error('Error in bulk decision update:', error);
        res.status(500).json({ message: 'Server error during bulk decision update', error: error.message });
    }
};

// Update candidate Phase 2 decision
exports.updatePhase2Decision = async (req, res) => {
    try {
        const { id } = req.params;
        const { phase2Decision } = req.body;

        if (!phase2Decision) {
            return res.status(400).json({ message: 'Phase 2 Decision is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.MAKE_DECISION);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.phase2Decision = phase2Decision;
        if (phase2Decision === 'Selected') {
            candidate.profileShared = true;
            candidate.phase2InterviewStatus = 'Shortlisted';
        } else if (phase2Decision === 'Shortlisted') {
            candidate.profileShared = true;
            candidate.phase2InterviewStatus = 'None';
        } else if (phase2Decision === 'Rejected') {
            candidate.phase2InterviewStatus = 'Rejected';
        } else if (!phase2Decision || phase2Decision === 'None') {
            candidate.phase2InterviewStatus = 'None';
        }
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Phase 2 Decision updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating Phase 2 decision:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Move candidate back from Phase 2 to Phase 1
exports.moveCandidateToPreviousPhase = async (req, res) => {
    try {
        const { id } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.SCHEDULE_INTERVIEW);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: candidate.hiringRequestId, companyId: req.companyId });
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        if (isDynamicHiringRequest(hiringRequest)) {
            return res.status(400).json({ message: 'Move back to previous phase is only available for the legacy phase flow' });
        }

        if (!hasCandidateMovedToPhase2(candidate)) {
            return res.status(400).json({ message: 'Candidate is not currently in Phase 2' });
        }

        if (candidate.phase3Decision && candidate.phase3Decision !== 'None') {
            return res.status(400).json({ message: 'Candidate cannot be moved back after progressing to Phase 3' });
        }

        if (candidate.isTransferredToOnboarding) {
            return res.status(400).json({ message: 'Candidate cannot be moved back after being transferred to onboarding' });
        }

        candidate.profileShared = false;
        candidate.phase2Decision = 'None';
        candidate.phase2InterviewerFeedback = '';
        candidate.phase2InterviewStatus = 'None';
        candidate.interviewRounds = (candidate.interviewRounds || []).filter((round) => Number(round?.phase || 1) !== 2);

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        res.status(200).json({
            message: 'Candidate moved back to Phase 1 successfully',
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error moving candidate back to previous phase:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update candidate Phase 3 decision (Offer & Onboarding)
exports.updatePhase3Decision = async (req, res) => {
    try {
        const { id } = req.params;
        const { phase3Decision } = req.body;

        if (!phase3Decision) {
            return res.status(400).json({ message: 'Phase 3 Decision is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess: hasDecisionAccess } = await ensureCandidateCapability(
            candidate,
            req.companyId,
            req.user,
            TA_CAPABILITIES.MAKE_DECISION
        );

        if (!hasDecisionAccess) {
            return res.status(403).json({
                message: requiredOfferPermission
                    ? `Forbidden: You need ${requiredOfferPermission} or candidate decision access to set ${phase3Decision}`
                    : 'Forbidden: You do not have permission to update this candidate'
            });
        }

        candidate.phase3Decision = phase3Decision;
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('uploadedBy', 'firstName lastName email')
            .populate('hiringRequestId', 'requestId roleDetails');

        res.status(200).json({
            message: 'Phase 3 Decision updated successfully',
            candidate: updatedCandidate
        });

    } catch (error) {
        console.error('Error updating Phase 3 decision:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get distinct candidate sources + stored custom sources
exports.getCandidateSources = async (req, res) => {
    try {
        // 1. Get sources from actual candidates
        const existingSources = await Candidate.distinct('source', { companyId: req.companyId });

        // 2. Get sources from CandidateSource master data
        const masterSources = await CandidateSource.find({ companyId: req.companyId });

        const defaultSources = ['Job Portal', 'Referral', 'LinkedIn', 'Consultancy', 'Internal Database', 'Other'];

        // Format master sources to include ID for deletion
        const customSources = masterSources.map(s => ({
            _id: s._id,
            name: s.name,
            isCustom: true
        }));

        // Combine all and return as objects to differentiate custom ones
        const combined = [...defaultSources.map(s => ({ name: s, isCustom: false }))];

        // Add existing from candidates if not in default
        existingSources.forEach(s => {
            if (!combined.some(c => c.name === s)) {
                combined.push({ name: s, isCustom: false });
            }
        });

        // Add custom from master data
        customSources.forEach(s => {
            if (!combined.some(c => c.name === s.name)) {
                combined.push(s);
            } else {
                // If already there but we have a custom record, mark it as custom
                const index = combined.findIndex(c => c.name === s.name);
                combined[index] = s;
            }
        });

        res.status(200).json(combined.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error) {
        console.error('Error fetching sources:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Add a new custom candidate source
exports.addCandidateSource = async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ message: 'Source name is required' });
        }

        const existing = await CandidateSource.findOne({ name, companyId: req.companyId });
        if (existing) {
            return res.status(400).json({ message: 'Source already exists' });
        }

        const newSource = new CandidateSource({
            name,
            companyId: req.companyId,
            createdBy: req.user._id
        });

        await newSource.save();
        res.status(201).json({ message: 'Source added successfully', source: newSource });
    } catch (error) {
        console.error('Error adding source:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Delete a custom candidate source
exports.deleteCandidateSource = async (req, res) => {
    try {
        const { id } = req.params;
        const source = await CandidateSource.findOneAndDelete({ _id: id, companyId: req.companyId });

        if (!source) {
            return res.status(404).json({ message: 'Source not found' });
        }

        res.status(200).json({ message: 'Source deleted successfully' });
    } catch (error) {
        console.error('Error deleting source:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- INTERVIEW ROUNDS MANAGEMENT ---

const sendInterviewScheduleEmails = async ({ companyId, candidate, round, user, cc, bcc, emailAccountId }) => {
    try {
        if (!candidate) return;

        const roleTitle = candidate.hiringRequestId?.roleDetails?.title || candidate.roleTitle || candidate.position || '';

        let template = null;
        if (round.emailTemplateId) {
            template = await EmailTemplate.findOne({ _id: round.emailTemplateId, companyId }).lean();
        }

        const effectiveCc = cc !== undefined ? cc : (round.cc || '');
        const effectiveBcc = bcc !== undefined ? bcc : (round.bcc || '');
        const effectiveEmailAccountId = emailAccountId || round.emailAccountId || undefined;

        let customFieldsHtml = '';
        if (Array.isArray(round.customFields) && round.customFields.length > 0) {
            const validFields = round.customFields.filter(f => f.key && String(f.key).trim());
            if (validFields.length > 0) {
                const rowsHtml = validFields.map(f => `
                    <tr>
                        <td style="padding: 8px 12px; font-weight: bold; color: #334155; border-bottom: 1px solid #e2e8f0; width: 35%;">${f.key}:</td>
                        <td style="padding: 8px 12px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${f.value || 'N/A'}</td>
                    </tr>
                `).join('');

                customFieldsHtml = `
                    <div style="margin-top: 20px; padding: 16px; background-color: #f8fafc; border-radius: 12px; border: 1px solid #cbd5e1;">
                        <h4 style="margin: 0 0 12px 0; color: #1e293b; font-size: 14px; font-weight: bold;">Interview Details & Additional Information:</h4>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            ${rowsHtml}
                        </table>
                    </div>
                `;
            }
        }

        const scheduledDateFormatted = round.scheduledDate
            ? new Date(round.scheduledDate).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
            : 'To Be Confirmed';

        const clientName = candidate.hiringRequestId?.client || candidate.companyName || '';
        const interviewersList = Array.isArray(round.assignedTo) && round.assignedTo.length > 0
            ? round.assignedTo.map(u => typeof u === 'object' ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : u).filter(Boolean).join(', ')
            : 'Unassigned';

        const processTemplate = (text, isBody = false) => {
            if (!text) return '';
            const candFirstName = candidate.candidateName ? candidate.candidateName.split(' ')[0] : '';
            const candLastName = candidate.candidateName ? candidate.candidateName.split(' ').slice(1).join(' ') : '';

            let processed = text
                .replace(/\{\{?candidateName\}\}?/gi, candidate.candidateName || '')
                .replace(/\{\{?fullName\}\}?/gi, candidate.candidateName || '')
                .replace(/\{\{?firstName\}\}?/gi, candFirstName)
                .replace(/\{\{?lastName\}\}?/gi, candLastName)
                .replace(/\{\{?candidateEmail\}\}?/gi, candidate.email || '')
                .replace(/\{\{?workEmail\}\}?/gi, candidate.email || '')
                .replace(/\{\{?email\}\}?/gi, candidate.email || '')
                .replace(/\{\{?phone\}\}?/gi, candidate.phone || candidate.mobile || '')
                .replace(/\{\{?mobile\}\}?/gi, candidate.phone || candidate.mobile || '')
                .replace(/\{\{?phoneNumber\}\}?/gi, candidate.phone || candidate.mobile || '')
                .replace(/\{\{?roleTitle\}\}?/gi, roleTitle)
                .replace(/\{\{?jobTitle\}\}?/gi, roleTitle)
                .replace(/\{\{?designation\}\}?/gi, roleTitle)
                .replace(/\{\{?roundName\}\}?/gi, round.levelName || 'Interview Round')
                .replace(/\{\{?interviewRound\}\}?/gi, round.levelName || 'Interview Round')
                .replace(/\{\{?scheduledDate\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewDate\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewTime\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewerName\}\}?/gi, interviewersList)
                .replace(/\{\{?clientName\}\}?/gi, clientName)
                .replace(/\{\{?client\}\}?/gi, clientName)
                .replace(/\{\{?companyName\}\}?/gi, clientName)
                .replace(/\{\{?company\}\}?/gi, clientName)
                .replace(/\{\{?location\}\}?/gi, candidate.location || candidate.currentCity || '')
                .replace(/\{\{?workLocation\}\}?/gi, candidate.location || candidate.currentCity || '')
                .replace(/\{\{?currentDate\}\}?/gi, new Date().toLocaleDateString('en-US', { dateStyle: 'medium' }))
                .replace(/\{\{?currentYear\}\}?/gi, String(new Date().getFullYear()));

            const isOriginalHtml = /<(p|div|table|tr|td|h[1-6]|ul|ol|li|br|strong|b|em|i)\b[^>]*>/i.test(text);

            if (isBody) {
                if (!isOriginalHtml) {
                    processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                    processed = processed.replace(/^(\s*)[\*\-]\s+(.+)$/gm, '$1&bull; $2');
                    processed = processed.replace(/\r\n|\r|\n/g, '<br />');
                }

                const hasCustomFieldsTag = /\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/i.test(processed);
                if (hasCustomFieldsTag) {
                    processed = processed.replace(/\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/gi, customFieldsHtml);
                } else if (customFieldsHtml) {
                    const signatureRegex = /(<p[^>]*>\s*)?\b(regards|best regards|kind regards|warm regards|thanks\s*&\s*regards|thanks|sincerely)\b([\s\S]*)/i;
                    if (signatureRegex.test(processed)) {
                        processed = processed.replace(signatureRegex, `${customFieldsHtml}<br />$1$2$3`);
                    } else {
                        processed += `<br />${customFieldsHtml}`;
                    }
                }
            } else {
                processed = processed.replace(/\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/gi, '');
            }
            return processed;
        };

        const defaultSubject = `Interview Scheduled: ${round.levelName || 'Interview Round'} - ${candidate.candidateName}`;
        const defaultCandidateBody = `
            <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <h2 style="color: #2563eb; margin-top: 0;">Interview Scheduled</h2>
                <p>Hello <strong>${candidate.candidateName}</strong>,</p>
                <p>Your interview for <strong>${round.levelName}</strong> (${roleTitle}) has been scheduled.</p>
                <div style="background: #f1f5f9; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
                    <p style="margin: 4px 0;"><strong>Date & Time:</strong> ${scheduledDateFormatted}</p>
                    <p style="margin: 4px 0;"><strong>Interviewer(s):</strong> ${interviewersList}</p>
                </div>
                ${customFieldsHtml}
                <p style="margin-top: 20px; color: #64748b; font-size: 12px;">Thank you,<br/>Talent Acquisition Team</p>
            </div>
        `;

        const defaultInterviewerBody = `
            <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <h2 style="color: #2563eb; margin-top: 0;">New Interview Assignment</h2>
                <p>Hello,</p>
                <p>You have been assigned to conduct an interview for candidate <strong>${candidate.candidateName}</strong> for the round <strong>${round.levelName}</strong> (${roleTitle}).</p>
                <div style="background: #f1f5f9; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
                    <p style="margin: 4px 0;"><strong>Candidate:</strong> ${candidate.candidateName} (${candidate.email || 'N/A'})</p>
                    <p style="margin: 4px 0;"><strong>Date & Time:</strong> ${scheduledDateFormatted}</p>
                </div>
                ${customFieldsHtml}
                <p style="margin-top: 20px; color: #64748b; font-size: 12px;">Please log in to your portal to submit feedback after the interview.</p>
            </div>
        `;

        if (candidate.email) {
            const subject = template?.subject ? processTemplate(template.subject, false) : defaultSubject;
            const htmlBody = template?.htmlBody ? processTemplate(template.htmlBody, true) : defaultCandidateBody;
            try {
                await sendEmailForCompany({
                    companyId,
                    emailAccountId: effectiveEmailAccountId,
                    to: candidate.email,
                    cc: effectiveCc || undefined,
                    bcc: effectiveBcc || undefined,
                    subject,
                    html: htmlBody,
                    user
                });

                await TAEmailLog.create({
                    companyId,
                    sentBy: user?._id || null,
                    senderEmail: user?.email || '',
                    senderName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Recruiter',
                    hiringRequestId: candidate.hiringRequestId?._id || candidate.hiringRequestId || null,
                    hiringRequestTitle: candidate.hiringRequestId?.roleDetails?.title || roleTitle || '',
                    candidateId: candidate._id,
                    recipientName: candidate.candidateName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate',
                    recipientEmail: candidate.email,
                    cc: String(effectiveCc || ''),
                    bcc: String(effectiveBcc || ''),
                    templateId: template?._id || null,
                    templateName: template?.name || 'Interview Invitation',
                    subject,
                    body: htmlBody,
                    status: 'Sent',
                    sentAt: new Date()
                });

                round.mailSent = true;
                round.mailSentAt = new Date();
                round.lastMailDetails = {
                    sentAt: new Date(),
                    subject,
                    htmlBody,
                    senderEmail: user?.email || '',
                    candidateEmail: candidate.email,
                    cc: String(effectiveCc || ''),
                    bcc: String(effectiveBcc || ''),
                    interviewers: Array.isArray(round.assignedTo) ? round.assignedTo.map(u => ({
                        name: typeof u === 'object' ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : String(u),
                        email: typeof u === 'object' ? u.email || '' : ''
                    })) : []
                };
                await candidate.save();
            } catch (candEmailErr) {
                console.error('Error sending interview schedule email to candidate:', candEmailErr);
                try {
                    await TAEmailLog.create({
                        companyId,
                        sentBy: user?._id || null,
                        senderEmail: user?.email || '',
                        senderName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Recruiter',
                        hiringRequestId: candidate.hiringRequestId?._id || candidate.hiringRequestId || null,
                        hiringRequestTitle: candidate.hiringRequestId?.roleDetails?.title || roleTitle || '',
                        candidateId: candidate._id,
                        recipientName: candidate.candidateName || `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim() || 'Candidate',
                        recipientEmail: candidate.email,
                        cc: String(effectiveCc || ''),
                        bcc: String(effectiveBcc || ''),
                        templateId: template?._id || null,
                        templateName: template?.name || 'Interview Invitation',
                        subject,
                        body: htmlBody,
                        status: 'Failed',
                        errorReason: candEmailErr.message,
                        sentAt: new Date()
                    });
                } catch (logErr) {}
            }
        }

        if (Array.isArray(round.assignedTo) && round.assignedTo.length > 0) {
            for (const interviewerObj of round.assignedTo) {
                const email = typeof interviewerObj === 'object' ? interviewerObj.email : null;
                const interviewerName = typeof interviewerObj === 'object'
                    ? `${interviewerObj.firstName || ''} ${interviewerObj.lastName || ''}`.trim()
                    : 'Interviewer';
                if (email) {
                    const subject = `[Interviewer Notice] Interview Scheduled: ${round.levelName} - ${candidate.candidateName}`;
                    const htmlBody = template?.htmlBody
                        ? processTemplate(template.htmlBody, true)
                        : defaultInterviewerBody;
                    try {
                        await sendEmailForCompany({
                            companyId,
                            emailAccountId: effectiveEmailAccountId,
                            to: email,
                            cc: effectiveCc || undefined,
                            bcc: effectiveBcc || undefined,
                            subject,
                            html: htmlBody,
                            user
                        });

                        await TAEmailLog.create({
                            companyId,
                            sentBy: user?._id || null,
                            senderEmail: user?.email || '',
                            senderName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Recruiter',
                            hiringRequestId: candidate.hiringRequestId?._id || candidate.hiringRequestId || null,
                            hiringRequestTitle: candidate.hiringRequestId?.roleDetails?.title || roleTitle || '',
                            candidateId: candidate._id,
                            recipientName: interviewerName ? `[Interviewer] ${interviewerName}` : '[Interviewer]',
                            recipientEmail: email,
                            cc: String(effectiveCc || ''),
                            bcc: String(effectiveBcc || ''),
                            templateId: template?._id || null,
                            templateName: 'Interviewer Notice',
                            subject,
                            body: htmlBody,
                            status: 'Sent',
                            sentAt: new Date()
                        });
                    } catch (intErr) {
                        console.error('Error sending interviewer schedule email:', intErr);
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error sending interview schedule email notifications:', err);
    }
};

// Add a new interview round
exports.addInterviewRound = async (req, res) => {
    try {
        const { id } = req.params;
        const { levelName, assignedTo, scheduledDate, phase, customFields, emailTemplateId, emailAccountId, cc, bcc } = req.body;

        if (!levelName) {
            return res.status(400).json({ message: 'Level name is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.SCHEDULE_INTERVIEW);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        const newRound = {
            levelName,
            assignedTo: assignedTo || [],
            status: 'Pending',
            scheduledDate,
            phase: phase || 1,
            customFields: Array.isArray(customFields) ? customFields.filter(f => f.key && String(f.key).trim()) : [],
            emailTemplateId: emailTemplateId || null,
            emailAccountId: emailAccountId || null,
            cc: cc || '',
            bcc: bcc || ''
        };

        candidate.interviewRounds.push(newRound);
        await candidate.save();

        const savedRound = candidate.interviewRounds[candidate.interviewRounds.length - 1];
        const roundPhase = Number(savedRound?.phase) > 0 ? Number(savedRound.phase) : 1;

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId client roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const populatedRound = updatedCandidate.interviewRounds[updatedCandidate.interviewRounds.length - 1];

        // Create notification for assigned interviewers and emit real-time updates
        if (assignedTo && assignedTo.length > 0) {
            const io = req.app.get('io');
            const notifications = assignedTo.map(userId => ({
                user: userId,
                companyId: req.companyId,
                preferenceKey: 'interview_assigned',
                title: 'New Interview Assigned',
                message: `You have been assigned to evaluate ${candidate.candidateName} for the ${levelName} round.`,
                type: 'Interview',
                link: `/ta/hiring-request/${candidate.hiringRequestId._id || candidate.hiringRequestId}/candidate/${candidate._id}/view?phase=${roundPhase}`,
                origin: req.headers.origin,
                metadata: {
                    candidateId: candidate._id,
                    roundId: savedRound?._id,
                    hiringRequestId: candidate.hiringRequestId._id || candidate.hiringRequestId,
                    phase: roundPhase
                }
            }));
            await NotificationService.createManyNotifications(io, notifications);

            // Also emit an 'interview_update' event to each assigned user to refresh their list
            assignedTo.forEach(userId => {
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    candidateId: candidate._id,
                    candidateName: candidate.candidateName,
                    roundId: savedRound?._id
                });
            });
        }

        // Send email notifications to Candidate and Interviewer(s) ONLY if explicitly requested
        if (req.body.sendEmail) {
            sendInterviewScheduleEmails({
                companyId: req.companyId,
                candidate: updatedCandidate,
                round: populatedRound,
                user: req.user,
                cc,
                bcc,
                emailAccountId
            });
        }

        res.status(201).json({
            message: 'Interview round added successfully',
            round: populatedRound,
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error adding interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Update an existing interview round (e.g., reschedule, change assignment)
exports.updateInterviewRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { levelName, assignedTo, scheduledDate, phase, customFields, emailTemplateId, emailAccountId, cc, bcc, sendEmail } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.SCHEDULE_INTERVIEW);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        if (levelName) round.levelName = levelName;
        if (assignedTo !== undefined) round.assignedTo = assignedTo;
        if (scheduledDate !== undefined) round.scheduledDate = scheduledDate;
        if (phase !== undefined) round.phase = phase;
        if (customFields !== undefined) round.customFields = Array.isArray(customFields) ? customFields.filter(f => f.key && String(f.key).trim()) : [];
        if (emailTemplateId !== undefined) round.emailTemplateId = emailTemplateId || null;
        if (emailAccountId !== undefined) round.emailAccountId = emailAccountId || null;
        if (cc !== undefined) round.cc = cc || '';
        if (bcc !== undefined) round.bcc = bcc || '';

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId client roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const updatedRound = updatedCandidate.interviewRounds.id(roundId);

        const io = req.app.get('io');
        // Notify assigned interviewers about the update
        if (updatedRound && updatedRound.assignedTo) {
            updatedRound.assignedTo.forEach(user => {
                const userId = user._id || user;
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    candidateId: updatedCandidate._id,
                    candidateName: updatedCandidate.candidateName,
                    roundId: roundId,
                    type: 'UPDATE'
                });
            });
        }

        // Send email notifications ONLY if explicitly requested via sendEmail flag
        if (sendEmail && updatedRound) {
            sendInterviewScheduleEmails({
                companyId: req.companyId,
                candidate: updatedCandidate,
                round: updatedRound,
                user: req.user,
                cc,
                bcc,
                emailAccountId
            });
        }

        res.status(200).json({
            message: 'Interview round updated successfully',
            round: updatedRound,
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error updating interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Send mail explicitly per interview round with template, CC, BCC, customFields and emailAccountId selection
exports.sendInterviewRoundEmail = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { emailTemplateId, emailAccountId, cc, bcc, customFields } = req.body;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.SCHEDULE_INTERVIEW);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to send emails for this candidate' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        if (emailTemplateId !== undefined) round.emailTemplateId = emailTemplateId || null;
        if (emailAccountId !== undefined) round.emailAccountId = emailAccountId || null;
        if (cc !== undefined) round.cc = cc || '';
        if (bcc !== undefined) round.bcc = bcc || '';
        if (Array.isArray(customFields)) {
            round.customFields = customFields.filter(f => f.key && String(f.key).trim());
        }
        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId client roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const updatedRound = updatedCandidate.interviewRounds.id(roundId);

        await sendInterviewScheduleEmails({
            companyId: req.companyId,
            candidate: updatedCandidate,
            round: updatedRound,
            user: req.user,
            cc: cc !== undefined ? cc : round.cc,
            bcc: bcc !== undefined ? bcc : round.bcc,
            emailAccountId: emailAccountId || round.emailAccountId
        });

        res.status(200).json({
            message: 'Interview round email sent successfully',
            round: updatedRound
        });
    } catch (error) {
        console.error('Error sending interview round email:', error);
        res.status(500).json({ message: 'Failed to send interview round email', error: error.message });
    }
};

// Get preview details of the email for an interview round
exports.previewInterviewRoundEmail = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const emailTemplateId = req.query.emailTemplateId || req.body?.emailTemplateId;
        const customFieldsInput = req.body?.customFields || (req.query.customFields ? JSON.parse(req.query.customFields) : null);

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId', 'requestId client roleDetails')
            .populate('interviewRounds.assignedTo', 'firstName lastName email');

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        const effectiveTemplateId = emailTemplateId || round.emailTemplateId;
        let template = null;
        if (effectiveTemplateId) {
            template = await EmailTemplate.findOne({ _id: effectiveTemplateId, companyId: req.companyId }).lean();
        }

        const roleTitle = candidate.hiringRequestId?.roleDetails?.title || candidate.roleTitle || candidate.position || '';
        const clientName = candidate.hiringRequestId?.client || candidate.companyName || '';

        const scheduledDateFormatted = round.scheduledDate
            ? new Date(round.scheduledDate).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
            : 'To Be Confirmed';

        const assignedInterviewers = Array.isArray(round.assignedTo) ? round.assignedTo : [];
        const interviewersList = assignedInterviewers.length > 0
            ? assignedInterviewers.map(u => typeof u === 'object' ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : u).filter(Boolean).join(', ')
            : 'Unassigned';

        let customFieldsHtml = '';
        const fieldsToUse = Array.isArray(customFieldsInput) ? customFieldsInput : round.customFields;
        const validFields = Array.isArray(fieldsToUse) ? fieldsToUse.filter(f => f.key && String(f.key).trim()) : [];
        if (validFields.length > 0) {
            const rowsHtml = validFields.map(f => `
                <tr>
                    <td style="padding: 8px 12px; font-weight: bold; color: #334155; border-bottom: 1px solid #e2e8f0; width: 35%;">${f.key}:</td>
                    <td style="padding: 8px 12px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${f.value || 'N/A'}</td>
                </tr>
            `).join('');

            customFieldsHtml = `
                <div style="margin-top: 20px; padding: 16px; background-color: #f8fafc; border-radius: 12px; border: 1px solid #cbd5e1;">
                    <h4 style="margin: 0 0 12px 0; color: #1e293b; font-size: 14px; font-weight: bold;">Interview Details & Additional Information:</h4>
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                        ${rowsHtml}
                    </table>
                </div>
            `;
        }

        const processTemplate = (text, isBody = false) => {
            if (!text) return '';
            const candFirstName = candidate.candidateName ? candidate.candidateName.split(' ')[0] : '';
            const candLastName = candidate.candidateName ? candidate.candidateName.split(' ').slice(1).join(' ') : '';

            let processed = text
                .replace(/\{\{?candidateName\}\}?/gi, candidate.candidateName || '')
                .replace(/\{\{?fullName\}\}?/gi, candidate.candidateName || '')
                .replace(/\{\{?firstName\}\}?/gi, candFirstName)
                .replace(/\{\{?lastName\}\}?/gi, candLastName)
                .replace(/\{\{?candidateEmail\}\}?/gi, candidate.email || '')
                .replace(/\{\{?workEmail\}\}?/gi, candidate.email || '')
                .replace(/\{\{?email\}\}?/gi, candidate.email || '')
                .replace(/\{\{?phone\}\}?/gi, candidate.phone || candidate.mobile || '')
                .replace(/\{\{?mobile\}\}?/gi, candidate.phone || candidate.mobile || '')
                .replace(/\{\{?phoneNumber\}\}?/gi, candidate.phone || candidate.mobile || '')
                .replace(/\{\{?roleTitle\}\}?/gi, roleTitle)
                .replace(/\{\{?jobTitle\}\}?/gi, roleTitle)
                .replace(/\{\{?designation\}\}?/gi, roleTitle)
                .replace(/\{\{?roundName\}\}?/gi, round.levelName || 'Interview Round')
                .replace(/\{\{?interviewRound\}\}?/gi, round.levelName || 'Interview Round')
                .replace(/\{\{?scheduledDate\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewDate\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewTime\}\}?/gi, scheduledDateFormatted)
                .replace(/\{\{?interviewerName\}\}?/gi, interviewersList)
                .replace(/\{\{?clientName\}\}?/gi, clientName)
                .replace(/\{\{?client\}\}?/gi, clientName)
                .replace(/\{\{?companyName\}\}?/gi, clientName)
                .replace(/\{\{?company\}\}?/gi, clientName)
                .replace(/\{\{?location\}\}?/gi, candidate.location || candidate.currentCity || '')
                .replace(/\{\{?workLocation\}\}?/gi, candidate.location || candidate.currentCity || '')
                .replace(/\{\{?currentDate\}\}?/gi, new Date().toLocaleDateString('en-US', { dateStyle: 'medium' }))
                .replace(/\{\{?currentYear\}\}?/gi, String(new Date().getFullYear()));

            const isOriginalHtml = /<(p|div|table|tr|td|h[1-6]|ul|ol|li|br|strong|b|em|i)\b[^>]*>/i.test(text);

            if (isBody) {
                if (!isOriginalHtml) {
                    processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
                    processed = processed.replace(/^(\s*)[\*\-]\s+(.+)$/gm, '$1&bull; $2');
                    processed = processed.replace(/\r\n|\r|\n/g, '<br />');
                }

                const hasCustomFieldsTag = /\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/i.test(processed);
                if (hasCustomFieldsTag) {
                    processed = processed.replace(/\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/gi, customFieldsHtml);
                } else if (customFieldsHtml) {
                    const signatureRegex = /(<p[^>]*>\s*)?\b(regards|best regards|kind regards|warm regards|thanks\s*&\s*regards|thanks|sincerely)\b([\s\S]*)/i;
                    if (signatureRegex.test(processed)) {
                        processed = processed.replace(signatureRegex, `${customFieldsHtml}<br />$1$2$3`);
                    } else {
                        processed += `<br />${customFieldsHtml}`;
                    }
                }
            } else {
                processed = processed.replace(/\{{1,2}(customFields|customFieldsTable|additionalDetails|custom_fields)\}{1,2}/gi, '');
            }
            return processed;
        };

        const defaultSubject = `Interview Scheduled: ${round.levelName || 'Interview Round'} - ${candidate.candidateName}`;
        const defaultCandidateBody = `
            <div style="font-family: Arial, sans-serif; color: #334155; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <h2 style="color: #2563eb; margin-top: 0;">Interview Scheduled</h2>
                <p>Hello <strong>${candidate.candidateName}</strong>,</p>
                <p>Your interview for <strong>${round.levelName}</strong> (${roleTitle}) has been scheduled.</p>
                <div style="background: #f1f5f9; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
                    <p style="margin: 4px 0;"><strong>Date & Time:</strong> ${scheduledDateFormatted}</p>
                    <p style="margin: 4px 0;"><strong>Interviewer(s):</strong> ${interviewersList}</p>
                </div>
                ${customFieldsHtml}
                <p style="margin-top: 20px; color: #64748b; font-size: 12px;">Thank you,<br/>Talent Acquisition Team</p>
            </div>
        `;

        const subject = template?.subject ? processTemplate(template.subject, false) : defaultSubject;
        const htmlBody = template?.htmlBody ? processTemplate(template.htmlBody, true) : defaultCandidateBody;

        res.status(200).json({
            candidateName: candidate.candidateName,
            candidateEmail: candidate.email,
            interviewers: assignedInterviewers.map(u => ({ name: `${u.firstName || ''} ${u.lastName || ''}`.trim(), email: u.email })),
            subject,
            htmlBody,
            customFields: validFields,
            scheduledDateFormatted,
            cc: round.cc || '',
            bcc: round.bcc || ''
        });
    } catch (error) {
        console.error('Error previewing interview round email:', error);
        res.status(500).json({ message: 'Failed to preview email', error: error.message });
    }
};

// Delete an interview round
exports.deleteInterviewRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        candidate.interviewRounds.pull(roundId);
        await candidate.save();

        res.status(200).json({ message: 'Interview round deleted successfully' });
    } catch (error) {
        console.error('Error deleting interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get current user's scheduled interviews
exports.getMyScheduledInterviews = async (req, res) => {
    try {
        const userId = req.user._id;

        // Only return rounds that are actually scheduled for the interviewer.
        // Some rounds are created in a "Pending" state before a date is set, and those
        // should not appear in the "Upcoming Interviews" widgets.
        const candidates = await Candidate.find(await buildAccessibleCandidateQuery(req.companyId, req.user, {
            'interviewRounds': {
                $elemMatch: {
                    $or: [
                        { assignedTo: userId },
                        { evaluatedBy: userId }
                    ],
                    status: { $in: ['Pending', 'Scheduled', 'Passed', 'Failed'] },
                    scheduledDate: { $type: 'date' }
                }
            }
        }, { capability: TA_CAPABILITIES.EVALUATE_ROUND }))
            .populate('hiringRequestId', 'requestId roleDetails')
            .select('candidateName email mobile interviewRounds hiringRequestId');

        // Extract and flatten the specific rounds assigned to the user
        const scheduledInterviews = [];

        candidates.forEach(candidate => {
            candidate.interviewRounds.forEach(round => {
                const hasScheduledDate = Boolean(round.scheduledDate);
                const isAssigned = round.assignedTo.some(id => id.toString() === userId.toString());
                const isEvaluatedByMe = round.evaluatedBy && round.evaluatedBy.toString() === userId.toString();
                if ((isAssigned || isEvaluatedByMe) && hasScheduledDate && ['Pending', 'Scheduled', 'Passed', 'Failed'].includes(round.status)) {
                    scheduledInterviews.push({
                        candidateId: candidate._id,
                        candidateName: candidate.candidateName,
                        candidateEmail: candidate.email,
                        candidateMobile: candidate.mobile,
                        role: candidate.hiringRequestId?.roleDetails?.title || 'Unknown Role',
                        hiringRequestId: candidate.hiringRequestId?._id,
                        roundId: round._id,
                        phase: round.phase || 1,
                        levelName: round.levelName,
                        scheduledDate: round.scheduledDate,
                        status: ['Passed', 'Failed'].includes(round.status) ? round.status : 'Scheduled',
                        rawStatus: round.status
                    });
                }
            });
        });

        // Sort by date (oldest/nearest first), pushing null dates to the end
        scheduledInterviews.sort((a, b) => {
            if (!a.scheduledDate) return 1;
            if (!b.scheduledDate) return -1;
            return new Date(a.scheduledDate) - new Date(b.scheduledDate);
        });

        res.status(200).json(scheduledInterviews);
    } catch (error) {
        console.error('Error fetching user interviews:', error);
        res.status(500).json({ message: 'Server error fetching scheduled interviews', error: error.message });
    }
};

// Get all candidates pulled by a specific user for the User TA Dashboard
exports.getCandidatesByPulledBy = async (req, res) => {
    try {
        const { userName } = req.params;
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
        const skip = (page - 1) * limit;

        const query = await buildAccessibleCandidateQuery(req.companyId, req.user, {
            profilePulledBy: { $regex: new RegExp(`^${userName}$`, 'i') }
        }, { capability: TA_CAPABILITIES.VIEW });

        const [totalCandidates, summaryRows, candidates] = await Promise.all([
            Candidate.countDocuments(query),
            Candidate.aggregate([
                { $match: query },
                {
                    $project: {
                        status: 1,
                        decision: 1,
                        interviewRounds: { $ifNull: ['$interviewRounds', []] }
                    }
                },
                {
                    $addFields: {
                        interviewRoundsCount: { $size: '$interviewRounds' },
                        failedRoundsCount: {
                            $size: {
                                $filter: {
                                    input: '$interviewRounds',
                                    as: 'round',
                                    cond: { $eq: ['$$round.status', 'Failed'] }
                                }
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        interested: {
                            $sum: {
                                $cond: [
                                            {
                                                $and: [
                                                    { $eq: ['$status', 'Interested'] },
                                            { $not: [{ $in: ['$decision', ['Rejected', 'On Hold', 'Did Not Turn Up']] }] },
                                                    { $eq: ['$interviewRoundsCount', 0] }
                                                ]
                                            },
                                    1,
                                    0
                                ]
                            }
                        },
                        inInterviews: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $gt: ['$interviewRoundsCount', 0] },
                                            { $not: [{ $in: ['$decision', ['Rejected', 'On Hold', 'Did Not Turn Up']] }] },
                                            { $eq: ['$failedRoundsCount', 0] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        rejected: {
                            $sum: {
                                $cond: [{ $in: ['$decision', ['Rejected', 'Did Not Turn Up']] }, 1, 0]
                            }
                        },
                        onHold: {
                            $sum: {
                                $cond: [{ $eq: ['$decision', 'On Hold'] }, 1, 0]
                            }
                        }
                    }
                }
            ]),
            Candidate.find(query)
                .populate('hiringRequestId', 'requestId roleDetails')
                .populate('uploadedBy', 'firstName lastName email')
                .sort({ uploadedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        const summary = summaryRows[0] || {
            total: totalCandidates,
            interested: 0,
            inInterviews: 0,
            rejected: 0,
            onHold: 0
        };

        res.status(200).json({
            count: totalCandidates,
            currentPage: page,
            limit,
            totalPages: Math.ceil(totalCandidates / limit) || 1,
            summary,
            candidates
        });

    } catch (error) {
        console.error('Error fetching candidates by pulled by:', error);
        res.status(500).json({ message: 'Server error fetching candidates', error: error.message });
    }
};

// Evaluate an interview round (Pass/Fail) or edit feedback for an already-evaluated round
exports.evaluateInterviewRound = async (req, res) => {
    try {
        const { id, roundId } = req.params;
        const { status, feedback, rating, skillRatings } = req.body; // status: 'Passed', 'Failed' or 'Skipped'; rating: 1-10 when provided

        if (!['Passed', 'Failed', 'Skipped'].includes(status)) {
            return res.status(400).json({ message: 'Status must be Passed, Failed or Skipped' });
        }

        if (!feedback) {
            return res.status(400).json({ message: 'Feedback is required for evaluation' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const round = candidate.interviewRounds.id(roundId);
        if (!round) {
            return res.status(404).json({ message: 'Interview round not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(
            candidate,
            req.companyId,
            req.user,
            TA_CAPABILITIES.EVALUATE_ROUND,
            { roundId }
        );
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You are not authorized to evaluate this round' });
        }

        // Authorization check: User must be an assigned evaluator or have super approve
        const userPermissions = Array.isArray(req.user?.permissions)
            ? req.user.permissions
            : (req.user?.roles || []).flatMap((role) => (role.permissions || []).map((permission) => permission.key));
        const hasSuperApprove = userPermissions.includes('ta.super_approve') || userPermissions.includes('*');
        const isAssigned = round.assignedTo.some(id => (id._id || id).toString() === req.user._id.toString());

        if (!isAssigned && !hasSuperApprove) {
            return res.status(403).json({ message: 'Forbidden: You are not authorized to evaluate this round' });
        }

        round.status = status;
        round.feedback = feedback;
        round.evaluatedBy = req.user._id;
        round.evaluatedAt = new Date();

        // Save rating whenever a valid score is provided, regardless of pass/fail.
        if (rating !== undefined && rating !== null && rating !== '') {
            const parsedRating = parseInt(rating, 10);
            if (parsedRating >= 1 && parsedRating <= 10) {
                round.rating = parsedRating;
            }
        } else {
            round.rating = undefined;
        }

        // Save round-specific skill ratings and update global ones
        if (skillRatings && Array.isArray(skillRatings)) {
            round.skillRatings = skillRatings.map(sr => ({
                skill: sr.skill,
                rating: sr.rating,
                category: sr.category
            }));

            // Sync to global skillRatings
            skillRatings.forEach(newSr => {
                const globalSrIndex = candidate.skillRatings.findIndex(s => s.skill === newSr.skill);
                if (globalSrIndex !== -1) {
                    candidate.skillRatings[globalSrIndex].rating = newSr.rating;
                } else {
                    candidate.skillRatings.push({
                        skill: newSr.skill,
                        rating: newSr.rating,
                        category: newSr.category || 'Additional'
                    });
                }
            });
        }

        await candidate.save();

        const updatedCandidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('interviewRounds.assignedTo', 'firstName lastName email')
            .populate('interviewRounds.evaluatedBy', 'firstName lastName');

        const io = req.app.get('io');
        // Notify assigned interviewers that the round is evaluated (to remove from their "Pending" list)
        if (updatedCandidate.interviewRounds.id(roundId).assignedTo) {
            updatedCandidate.interviewRounds.id(roundId).assignedTo.forEach(user => {
                const userId = user._id || user;
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    candidateId: updatedCandidate._id,
                    candidateName: updatedCandidate.candidateName,
                    roundId: roundId,
                    type: 'EVALUATED',
                    status: status
                });
            });
        }

        res.status(200).json({
            message: `Round evaluated as ${status}`,
            round: updatedCandidate.interviewRounds.id(roundId),
            candidate: updatedCandidate
        });
    } catch (error) {
        console.error('Error evaluating interview round:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// --- SKILL RATINGS MANAGEMENT ---

// Update all skill ratings for a candidate
exports.updateSkillRatings = async (req, res) => {
    try {
        const { id } = req.params;
        const { skillRatings } = req.body; // Expecting an array of { skill, rating, category, _id }

        if (!Array.isArray(skillRatings)) {
            return res.status(400).json({ message: 'Skill ratings must be an array' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.skillRatings = skillRatings;
        await candidate.save();

        res.status(200).json({
            message: 'Skill ratings updated successfully',
            skillRatings: candidate.skillRatings
        });
    } catch (error) {
        console.error('Error updating skill ratings:', error);
        res.status(500).json({ message: 'Server error updating skill ratings', error: error.message });
    }
};

// Add a new skill to candidate's skillRatings
exports.addSkillRating = async (req, res) => {
    try {
        const { id } = req.params;
        const { skill, rating, category } = req.body;

        if (!skill) {
            return res.status(400).json({ message: 'Skill name is required' });
        }

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.skillRatings.push({
            skill,
            rating: rating || 0,
            category: category || 'Additional'
        });

        await candidate.save();

        res.status(200).json({
            message: 'Skill added successfully',
            skillRatings: candidate.skillRatings
        });
    } catch (error) {
        console.error('Error adding skill rating:', error);
        res.status(500).json({ message: 'Server error adding skill rating', error: error.message });
    }
};

// Delete a skill from candidate's skillRatings
exports.deleteSkillRating = async (req, res) => {
    try {
        const { id, skillId } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId });
        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.EDIT);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        candidate.skillRatings.pull(skillId);
        await candidate.save();

        res.status(200).json({
            message: 'Skill deleted successfully',
            skillRatings: candidate.skillRatings
        });
    } catch (error) {
        console.error('Error deleting skill rating:', error);
        res.status(500).json({ message: 'Server error deleting skill rating', error: error.message });
    }
};

// Transfer candidate to Onboarding module
exports.transferToOnboarding = async (req, res) => {
    try {
        const { id } = req.params;

        const candidate = await Candidate.findOne({ _id: id, companyId: req.companyId })
            .populate('hiringRequestId');

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        const { hasAccess } = await ensureCandidateCapability(candidate, req.companyId, req.user, TA_CAPABILITIES.TRANSFER);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this candidate' });
        }

        // Validation: Ensure a valid decision is set (Phase 3 decision or Phase 2 Selected)
        const hasPhase3Decision = candidate.phase3Decision && candidate.phase3Decision !== 'None';
        const hasPhase2Selected = candidate.phase2Decision === 'Selected';

        if (!hasPhase3Decision && !hasPhase2Selected) {
            return res.status(400).json({ message: 'A valid decision (Selected in Phase 2 or any Phase 3 decision) must be set before transferring to onboarding' });
        }

        if (candidate.isTransferredToOnboarding) {
            return res.status(400).json({ message: 'Candidate is already transferred to onboarding' });
        }

        // Check if employee with same email already exists in onboarding
        const existingOnboarding = await OnboardingEmployee.findOne({ email: candidate.email, companyId: req.companyId });
        if (existingOnboarding) {
            candidate.isTransferredToOnboarding = true; // Mark as transferred since they exist
            await candidate.save();
            return res.status(400).json({ message: 'An onboarding record with this email already exists' });
        }


        // Split name into first and last
        const nameParts = candidate.candidateName.trim().split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

        // Generate credentials
        const tempEmployeeId = await OnboardingEmployee.generateTempId(req.companyId);
        const tempPassword = Math.random().toString(36).slice(-8); // Random 8 char password

        // Default document slots
        const defaultDocuments = [
            { type: 'resume', label: 'Updated Resume' },
            { type: 'aadhaar_front', label: 'Aadhaar Card (Front)' },
            { type: 'aadhaar_back', label: 'Aadhaar Card (Back)' },
            { type: 'pan', label: 'PAN Card' },
            { type: 'salary_slip', label: 'Salary Slip' },
            { type: 'passport', label: 'Passport (Optional)' },
            { type: '10th_marksheet', label: '10th Marksheet / Certificate' },
            { type: '12th_marksheet', label: '12th Marksheet / Certificate' },
            { type: 'graduation', label: 'Graduation Marksheet / Certificate' },
            { type: 'relieving_letter', label: 'Previous Employer Relieving Letter' },
            { type: 'experience_certificate', label: 'Experience Certificate' },
            { type: 'passport_photo', label: 'Recent Passport-Size Photograph' },
            { type: 'live_photo', label: 'Live Photograph', requireLivePhoto: true },
            { type: 'character_certificate', label: 'Character Certificate' }
        ];

        console.log('📄 Initializing onboarding documents:', defaultDocuments.length);

        // Create onboarding employee
        const onboardingEmployee = new OnboardingEmployee({
            companyId: req.companyId,
            createdBy: req.user._id,
            sourcedFromTA: true,
            candidateId: candidate._id,
            tempEmployeeId,
            tempPassword, // hashed in pre-save
            firstName,
            lastName,
            email: candidate.email,
            phone: candidate.mobile,
            designation: candidate.hiringRequestId?.roleDetails?.title || '',
            joiningDate: candidate.lastWorkingDay || null,
            workLocation: candidate.preferredLocation || candidate.currentLocation || '',
            salary: {
                annualCTC: candidate.currentCTC?.toString() || ''
            },
            personalDetails: {
                fullName: candidate.candidateName,
                personalEmail: candidate.email,
                personalMobile: candidate.mobile,
                currentAddress: {
                    line1: candidate.currentLocation || '',
                    city: candidate.currentLocation || ''
                }
            },
            status: 'Pending',
            documents: defaultDocuments,
            requestedSections: [],
            requestedDocuments: []
        });

        console.log('💾 Saving onboarding employee with documents:', onboardingEmployee.documents.length);
        await onboardingEmployee.save();
        console.log('✅ Onboarding employee saved successfully:', onboardingEmployee._id);

        // Mark candidate as transferred
        candidate.isTransferredToOnboarding = true;
        await candidate.save();

        // Add audit log to onboarding employee
        try {
            await OnboardingEmployee.findByIdAndUpdate(onboardingEmployee._id, {
                $push: {
                    auditLog: {
                        action: 'TRANSFERRED_FROM_TA',
                        details: 'Candidate successfully transferred from Talent Acquisition'
                    }
                }
            });
        } catch (logError) {
            console.error('Failed to log transfer audit:', logError);
        }

        res.status(200).json({
            message: 'Candidate successfully transferred to onboarding',
            onboardingEmployeeId: onboardingEmployee._id
        });

    } catch (error) {
        console.error('Error transferring to onboarding:', error);
        res.status(500).json({ message: 'Server error during transfer', error: error.message });
    }
};

// --- BULK INTERVIEW SCHEDULING ---

exports.bulkScheduleInterview = async (req, res) => {
    try {
        const { candidateIds, levelName, assignedTo, scheduledDate, phase, customFields, emailTemplateId, emailAccountId, cc, bcc } = req.body;

        if (!levelName || typeof levelName !== 'string' || !levelName.trim()) {
            return res.status(400).json({ message: 'Level name (round name) is required' });
        }

        if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
            return res.status(400).json({ message: 'At least one candidate must be selected' });
        }

        const validCandidateIds = candidateIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        if (validCandidateIds.length === 0) {
            return res.status(400).json({ message: 'No valid candidate IDs provided' });
        }

        const candidates = await Candidate.find({
            _id: { $in: validCandidateIds },
            companyId: req.companyId
        }).populate('hiringRequestId', 'requestId roleDetails');

        if (candidates.length === 0) {
            return res.status(404).json({ message: 'No candidates found for the given IDs' });
        }

        const roundPhase = Number(phase) > 0 ? Number(phase) : 1;
        const normalizedAssignedTo = Array.isArray(assignedTo)
            ? assignedTo.filter((id) => mongoose.Types.ObjectId.isValid(id))
            : [];

        let scheduled = 0;
        const failed = [];
        const scheduledCandidateNames = [];

        for (const candidate of candidates) {
            try {
                const { hasAccess } = await ensureCandidateCapability(
                    candidate,
                    req.companyId,
                    req.user,
                    TA_CAPABILITIES.SCHEDULE_INTERVIEW
                );

                if (!hasAccess) {
                    failed.push({
                        candidateId: candidate._id,
                        candidateName: candidate.candidateName,
                        reason: 'Permission denied'
                    });
                    continue;
                }

                const newRound = {
                    levelName: levelName.trim(),
                    assignedTo: normalizedAssignedTo,
                    status: 'Pending',
                    scheduledDate: scheduledDate || undefined,
                    phase: roundPhase,
                    customFields: Array.isArray(customFields) ? customFields.filter(f => f.key && String(f.key).trim()) : [],
                    emailTemplateId: emailTemplateId || null,
                    emailAccountId: emailAccountId || null,
                    cc: cc || '',
                    bcc: bcc || ''
                };

                candidate.interviewRounds.push(newRound);
                await candidate.save();

                const updatedCandidate = await Candidate.findOne({ _id: candidate._id, companyId: req.companyId })
                    .populate('hiringRequestId', 'requestId client roleDetails')
                    .populate('interviewRounds.assignedTo', 'firstName lastName email');

                const savedRound = updatedCandidate.interviewRounds[updatedCandidate.interviewRounds.length - 1];

                sendInterviewScheduleEmails({
                    companyId: req.companyId,
                    candidate: updatedCandidate,
                    round: savedRound,
                    user: req.user,
                    cc,
                    bcc,
                    emailAccountId
                });

                scheduled += 1;
                scheduledCandidateNames.push(candidate.candidateName);
            } catch (candidateError) {
                failed.push({
                    candidateId: candidate._id,
                    candidateName: candidate.candidateName,
                    reason: candidateError.message || 'Unknown error'
                });
            }
        }

        // Send grouped notifications to assigned interviewers
        if (normalizedAssignedTo.length > 0 && scheduled > 0) {
            const io = req.app.get('io');
            const notifications = normalizedAssignedTo.map((userId) => ({
                user: userId,
                companyId: req.companyId,
                preferenceKey: 'interview_assigned',
                title: 'New Interviews Assigned',
                message: scheduled === 1
                    ? `You have been assigned to evaluate ${scheduledCandidateNames[0]} for the ${levelName} round.`
                    : `You have been assigned to evaluate ${scheduled} candidates for the ${levelName} round.`,
                type: 'Interview',
                link: '/ta',
                origin: req.headers.origin
            }));

            await NotificationService.createManyNotifications(io, notifications);

            // Emit real-time updates to each assigned interviewer
            normalizedAssignedTo.forEach((userId) => {
                NotificationService.emitToUser(io, userId, 'interview_update', {
                    type: 'BULK_SCHEDULED',
                    count: scheduled,
                    levelName
                });
            });
        }

        res.status(200).json({
            message: `Interview round "${levelName}" scheduled for ${scheduled} candidate(s)`,
            scheduled,
            failed: failed.length,
            errors: failed
        });
    } catch (error) {
        console.error('Error in bulk interview scheduling:', error);
        res.status(500).json({ message: 'Server error during bulk scheduling', error: error.message });
    }
};

const calculateCandidateMatchScore = (candidate, query) => {
    let totalActiveWeight = 0;
    let earnedWeight = 0;

    // 1. Search Query
    if (query.search && String(query.search).trim() !== '') {
        const term = String(query.search).trim().toLowerCase();
        const weight = 30;
        totalActiveWeight += weight;

        let scorePercent = 0;

        const name = String(candidate.candidateName || '').toLowerCase();
        const email = String(candidate.email || '').toLowerCase();
        const mobile = String(candidate.mobile || '');
        const currentCompany = String(candidate.currentCompany || '').toLowerCase();
        const currentLocation = String(candidate.currentLocation || '').toLowerCase();

        if (name === term || email === term || mobile === term) {
            scorePercent = 1.0;
        } else if (name.includes(term) || email.includes(term) || mobile.includes(term)) {
            scorePercent = 0.9;
        } else if (currentCompany.includes(term)) {
            scorePercent = 0.7;
        } else if (currentLocation.includes(term)) {
            scorePercent = 0.7;
        }

        earnedWeight += scorePercent * weight;
    }

    // 2. Skills
    if (query.skills) {
        const querySkills = parseStringArrayQuery(query.skills);
        if (querySkills.length > 0) {
            const weight = 35;
            totalActiveWeight += weight;

            const candidateSkills = [];
            if (Array.isArray(candidate.mustHaveSkills)) {
                candidate.mustHaveSkills.forEach(s => { if (s && s.skill) candidateSkills.push(s.skill.toLowerCase()); });
            }
            if (Array.isArray(candidate.niceToHaveSkills)) {
                candidate.niceToHaveSkills.forEach(s => { if (s && s.skill) candidateSkills.push(s.skill.toLowerCase()); });
            }
            if (Array.isArray(candidate.skillRatings)) {
                candidate.skillRatings.forEach(s => { if (s && s.skill) candidateSkills.push(s.skill.toLowerCase()); });
            }

            let matchedCount = 0;
            querySkills.forEach(qs => {
                const qSkillLower = qs.toLowerCase();
                if (candidateSkills.some(cs => cs.includes(qSkillLower) || qSkillLower.includes(cs))) {
                    matchedCount++;
                }
            });

            const matchRatio = matchedCount / querySkills.length;
            earnedWeight += matchRatio * weight;
        }
    }

    // 3. Experience Range
    const hasMinExp = query.minExperience !== undefined && query.minExperience !== '';
    const hasMaxExp = query.maxExperience !== undefined && query.maxExperience !== '';
    if (hasMinExp || hasMaxExp) {
        const weight = 15;
        totalActiveWeight += weight;

        const candidateExp = Number(candidate.totalExperience) || 0;
        let isWithinRange = true;

        if (hasMinExp) {
            const min = Number(query.minExperience);
            if (Number.isFinite(min) && candidateExp < min) {
                isWithinRange = false;
            }
        }
        if (hasMaxExp) {
            const max = Number(query.maxExperience);
            if (Number.isFinite(max) && candidateExp > max) {
                isWithinRange = false;
            }
        }

        if (isWithinRange) {
            earnedWeight += weight;
        }
    }

    // 4. Location
    if (query.location && String(query.location).trim() !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const qLoc = String(query.location).trim().toLowerCase();
        const curLoc = String(candidate.currentLocation || '').toLowerCase();
        const prefLoc = String(candidate.preferredLocation || '').toLowerCase();

        if (curLoc.includes(qLoc) || prefLoc.includes(qLoc)) {
            earnedWeight += weight;
        }
    }

    // 5. Notice Period
    if (query.maxNoticePeriod !== undefined && query.maxNoticePeriod !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const maxNP = Number(query.maxNoticePeriod);
        const candidateNP = Number(candidate.noticePeriod) || 0;

        if (Number.isFinite(maxNP)) {
            if (candidateNP <= maxNP) {
                earnedWeight += weight;
            } else if (candidateNP <= maxNP + 15) {
                earnedWeight += weight * 0.5;
            }
        }
    }

    // 5b. Current CTC Range
    const hasMinCCTC = query.minCurrentCTC !== undefined && query.minCurrentCTC !== '';
    const hasMaxCCTC = query.maxCurrentCTC !== undefined && query.maxCurrentCTC !== '';
    if (hasMinCCTC || hasMaxCCTC) {
        const weight = 10;
        totalActiveWeight += weight;

        const candidateCCTC = Number(candidate.currentCTC) || 0;
        let isWithinRange = true;

        if (hasMinCCTC) {
            const min = Number(query.minCurrentCTC);
            if (Number.isFinite(min) && candidateCCTC < min) {
                isWithinRange = false;
            }
        }
        if (hasMaxCCTC) {
            const max = Number(query.maxCurrentCTC);
            if (Number.isFinite(max) && candidateCCTC > max) {
                isWithinRange = false;
            }
        }

        if (isWithinRange) {
            earnedWeight += weight;
        }
    }

    // 6. Expected CTC Range
    const hasMinECTC = query.minExpectedCTC !== undefined && query.minExpectedCTC !== '';
    const hasMaxECTC = query.maxExpectedCTC !== undefined && query.maxExpectedCTC !== '';
    if (hasMinECTC || hasMaxECTC) {
        const weight = 10;
        totalActiveWeight += weight;

        const candidateECTC = Number(candidate.expectedCTC) || 0;
        let isWithinRange = true;

        if (hasMinECTC) {
            const min = Number(query.minExpectedCTC);
            if (Number.isFinite(min) && candidateECTC < min) {
                isWithinRange = false;
            }
        }
        if (hasMaxECTC) {
            const max = Number(query.maxExpectedCTC);
            if (Number.isFinite(max) && candidateECTC > max) {
                isWithinRange = false;
            }
        }

        if (isWithinRange) {
            earnedWeight += weight;
        }
    }

    // 7. Source
    if (query.source) {
        const querySources = parseStringArrayQuery(query.source);
        if (querySources.length > 0) {
            const weight = 10;
            totalActiveWeight += weight;

            const candSource = String(candidate.source || '').trim().toLowerCase();
            const isMatched = querySources.some(qs => qs.trim().toLowerCase() === candSource);

            if (isMatched) {
                earnedWeight += weight;
            }
        }
    }

    // 8. In Hand Offer
    if (query.inHandOffer !== undefined && query.inHandOffer !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const qInHand = query.inHandOffer === 'true';
        const candInHand = !!candidate.inHandOffer;

        if (qInHand === candInHand) {
            earnedWeight += weight;
        }
    }

    // 9. Client
    if (query.client && String(query.client).trim() !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const qClient = String(query.client).trim().toLowerCase();
        const hrClient = String(candidate.hiringRequestId?.client || '').toLowerCase();

        if (hrClient.includes(qClient)) {
            earnedWeight += weight;
        }
    }

    // 10. Decision
    if (query.decision && String(query.decision).trim() !== '') {
        const weight = 10;
        totalActiveWeight += weight;

        const qDec = String(query.decision).trim().toLowerCase();
        const candDec = String(candidate.decision || '').toLowerCase();
        const candP2Dec = String(candidate.phase2Decision || '').toLowerCase();
        const candP3Dec = String(candidate.phase3Decision || '').toLowerCase();

        if (candDec === qDec || candP2Dec === qDec || candP3Dec === qDec) {
            earnedWeight += weight;
        }
    }

    // Fallback: profile completeness score if no filters/keywords are active
    if (totalActiveWeight === 0) {
        let completeness = 0;
        let totalCompWeight = 0;

        totalCompWeight += 30;
        if (candidate.candidateName) completeness += 10;
        if (candidate.email) completeness += 10;
        if (candidate.mobile) completeness += 10;

        totalCompWeight += 20;
        const hasSkills = (candidate.mustHaveSkills?.length > 0 || candidate.niceToHaveSkills?.length > 0 || candidate.skillRatings?.length > 0);
        if (hasSkills) completeness += 20;

        totalCompWeight += 15;
        if (candidate.totalExperience !== undefined && candidate.totalExperience !== null) completeness += 15;

        totalCompWeight += 15;
        if (candidate.resumeUrl) completeness += 15;

        totalCompWeight += 10;
        if (candidate.noticePeriod !== undefined && candidate.noticePeriod !== null) completeness += 10;

        totalCompWeight += 10;
        if (candidate.currentLocation || candidate.preferredLocation) completeness += 10;

        return Math.round((completeness / totalCompWeight) * 100);
    }

    return Math.round((earnedWeight / totalActiveWeight) * 100);
};

exports.globalSearchCandidates = async (req, res) => {
    try {
        const filterQuery = { isDeleted: { $ne: true } };

        let includeCandidates = true;
        let includePublicApps = true;
        let candidateSources = [];

        if (req.query.source) {
            const sources = parseStringArrayQuery(req.query.source);
            includePublicApps = sources.some(s => new RegExp('^public application$', 'i').test(s));
            
            sources.forEach(s => {
                if (new RegExp('^public application$', 'i').test(s)) {
                    candidateSources.push('Public Job Board');
                    candidateSources.push('Public Application');
                } else {
                    candidateSources.push(s);
                }
            });
            includeCandidates = candidateSources.length > 0;
        }

        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search.trim(), 'i');
            filterQuery.$or = [
                { candidateName: searchRegex },
                { email: searchRegex },
                { mobile: searchRegex },
                { currentLocation: searchRegex },
                { currentCompany: searchRegex }
            ];
        }

        if (req.query.minExperience !== undefined || req.query.maxExperience !== undefined) {
            filterQuery.totalExperience = {};
            if (req.query.minExperience !== undefined && req.query.minExperience !== '') {
                const minExp = Number(req.query.minExperience);
                if (Number.isFinite(minExp)) {
                    filterQuery.totalExperience.$gte = minExp;
                }
            }
            if (req.query.maxExperience !== undefined && req.query.maxExperience !== '') {
                const maxExp = Number(req.query.maxExperience);
                if (Number.isFinite(maxExp)) {
                    filterQuery.totalExperience.$lte = maxExp;
                }
            }
            if (Object.keys(filterQuery.totalExperience).length === 0) {
                delete filterQuery.totalExperience;
            }
        }

        if (req.query.skills) {
            const skillsList = parseStringArrayQuery(req.query.skills);
            if (skillsList.length > 0) {
                const skillsRegexList = skillsList.map(s => new RegExp(s.trim(), 'i'));
                filterQuery.$and = filterQuery.$and || [];
                filterQuery.$and.push({
                    $or: [
                        { 'mustHaveSkills.skill': { $in: skillsRegexList } },
                        { 'niceToHaveSkills.skill': { $in: skillsRegexList } },
                        { 'skillRatings.skill': { $in: skillsRegexList } }
                    ]
                });
            }
        }

        if (req.query.client) {
            const clientHiringRequests = await HiringRequest.find({
                companyId: req.companyId,
                client: new RegExp(req.query.client.trim(), 'i')
            }).select('_id').lean();
            
            const hiringRequestIds = clientHiringRequests.map(hr => hr._id);
            filterQuery.hiringRequestId = { $in: hiringRequestIds };
        }

        if (req.query.location) {
            const locRegex = new RegExp(req.query.location.trim(), 'i');
            filterQuery.$and = filterQuery.$and || [];
            filterQuery.$and.push({
                $or: [
                    { currentLocation: locRegex },
                    { preferredLocation: locRegex }
                ]
            });
        }

        if (req.query.maxNoticePeriod !== undefined && req.query.maxNoticePeriod !== '') {
            const noticeVal = Number(req.query.maxNoticePeriod);
            if (Number.isFinite(noticeVal)) {
                filterQuery.noticePeriod = { $lte: noticeVal };
            }
        }

        if (req.query.minCurrentCTC !== undefined || req.query.maxCurrentCTC !== undefined) {
            filterQuery.currentCTC = {};
            if (req.query.minCurrentCTC !== undefined && req.query.minCurrentCTC !== '') {
                const minCTC = Number(req.query.minCurrentCTC);
                if (Number.isFinite(minCTC)) {
                    filterQuery.currentCTC.$gte = minCTC;
                }
            }
            if (req.query.maxCurrentCTC !== undefined && req.query.maxCurrentCTC !== '') {
                const maxCTC = Number(req.query.maxCurrentCTC);
                if (Number.isFinite(maxCTC)) {
                    filterQuery.currentCTC.$lte = maxCTC;
                }
            }
            if (Object.keys(filterQuery.currentCTC).length === 0) {
                delete filterQuery.currentCTC;
            }
        }

        if (req.query.minExpectedCTC !== undefined || req.query.maxExpectedCTC !== undefined) {
            filterQuery.expectedCTC = {};
            if (req.query.minExpectedCTC !== undefined && req.query.minExpectedCTC !== '') {
                const minCTC = Number(req.query.minExpectedCTC);
                if (Number.isFinite(minCTC)) {
                    filterQuery.expectedCTC.$gte = minCTC;
                }
            }
            if (req.query.maxExpectedCTC !== undefined && req.query.maxExpectedCTC !== '') {
                const maxCTC = Number(req.query.maxExpectedCTC);
                if (Number.isFinite(maxCTC)) {
                    filterQuery.expectedCTC.$lte = maxCTC;
                }
            }
            if (Object.keys(filterQuery.expectedCTC).length === 0) {
                delete filterQuery.expectedCTC;
            }
        }

        if (req.query.inHandOffer !== undefined && req.query.inHandOffer !== '') {
            filterQuery.inHandOffer = req.query.inHandOffer === 'true';
        }

        if (req.query.decision) {
            const decVal = req.query.decision.trim();
            filterQuery.$and = filterQuery.$and || [];
            filterQuery.$and.push({
                $or: [
                    { decision: decVal },
                    { phase2Decision: decVal },
                    { phase3Decision: decVal }
                ]
            });
        }

        // Build Public Application Filter Query
        const publicAppFilterQuery = { companyId: req.companyId };

        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search.trim(), 'i');
            publicAppFilterQuery.$or = [
                { candidateName: searchRegex },
                { email: searchRegex },
                { mobile: searchRegex }
            ];
        }

        if (req.query.client) {
            const clientHiringRequests = await HiringRequest.find({
                companyId: req.companyId,
                client: new RegExp(req.query.client.trim(), 'i')
            }).select('_id').lean();
            publicAppFilterQuery.hiringRequestId = { $in: clientHiringRequests.map(hr => hr._id) };
        }

        if (req.query.maxNoticePeriod !== undefined && req.query.maxNoticePeriod !== '') {
            const noticeVal = Number(req.query.maxNoticePeriod);
            if (Number.isFinite(noticeVal)) {
                publicAppFilterQuery.noticePeriod = { $lte: noticeVal };
            }
        }

        if (req.query.minCurrentCTC !== undefined || req.query.maxCurrentCTC !== undefined) {
            publicAppFilterQuery.currentCTC = {};
            if (req.query.minCurrentCTC !== undefined && req.query.minCurrentCTC !== '') {
                const minCTC = Number(req.query.minCurrentCTC);
                if (Number.isFinite(minCTC)) publicAppFilterQuery.currentCTC.$gte = minCTC;
            }
            if (req.query.maxCurrentCTC !== undefined && req.query.maxCurrentCTC !== '') {
                const maxCTC = Number(req.query.maxCurrentCTC);
                if (Number.isFinite(maxCTC)) publicAppFilterQuery.currentCTC.$lte = maxCTC;
            }
            if (Object.keys(publicAppFilterQuery.currentCTC).length === 0) delete publicAppFilterQuery.currentCTC;
        }

        if (req.query.minExpectedCTC !== undefined || req.query.maxExpectedCTC !== undefined) {
            publicAppFilterQuery.expectedCTC = {};
            if (req.query.minExpectedCTC !== undefined && req.query.minExpectedCTC !== '') {
                const minCTC = Number(req.query.minExpectedCTC);
                if (Number.isFinite(minCTC)) publicAppFilterQuery.expectedCTC.$gte = minCTC;
            }
            if (req.query.maxExpectedCTC !== undefined && req.query.maxExpectedCTC !== '') {
                const maxCTC = Number(req.query.maxExpectedCTC);
                if (Number.isFinite(maxCTC)) publicAppFilterQuery.expectedCTC.$lte = maxCTC;
            }
            if (Object.keys(publicAppFilterQuery.expectedCTC).length === 0) delete publicAppFilterQuery.expectedCTC;
        }

        if (req.query.decision) {
            publicAppFilterQuery.reviewStatus = req.query.decision.trim();
        }

        // Fetch matched candidate records (only IDs and creation dates)
        let candidateItems = [];
        if (includeCandidates) {
            if (candidateSources.length > 0) {
                filterQuery.source = { $in: candidateSources.map(s => new RegExp(`^${s.trim()}$`, 'i')) };
            }
            const query = await buildAccessibleCandidateQuery(
                req.companyId,
                req.user,
                filterQuery,
                { capability: TA_CAPABILITIES.VIEW }
            );
            const candidates = await Candidate.find(query)
                .select('_id createdAt')
                .lean();
            candidateItems = candidates.map(c => ({
                _id: c._id,
                createdAt: c.createdAt,
                type: 'candidate'
            }));
        }

        // Fetch matched public application records
        let publicAppItems = [];
        if (includePublicApps) {
            const apps = await PublicApplication.find(publicAppFilterQuery)
                .select('_id createdAt profileSnapshot')
                .lean();

            // Filter experience in memory if requested
            let filteredApps = apps;
            if (req.query.minExperience !== undefined && req.query.minExperience !== '' ||
                req.query.maxExperience !== undefined && req.query.maxExperience !== '') {
                const minExp = req.query.minExperience !== '' ? Number(req.query.minExperience) : null;
                const maxExp = req.query.maxExperience !== '' ? Number(req.query.maxExperience) : null;
                filteredApps = filteredApps.filter(app => {
                    const expYears = app.profileSnapshot?.totalExperience ?? app.profileSnapshot?.experienceYears ?? null;
                    if (expYears === null || expYears === undefined) return true; // include if unknown
                    if (minExp !== null && Number.isFinite(minExp) && expYears < minExp) return false;
                    if (maxExp !== null && Number.isFinite(maxExp) && expYears > maxExp) return false;
                    return true;
                });
            }
            publicAppItems = filteredApps.map(app => ({
                _id: app._id,
                createdAt: app.createdAt,
                type: 'publicApp'
            }));
        }

        // Merge and sort
        const mergedItems = [...candidateItems, ...publicAppItems];
        mergedItems.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const total = mergedItems.length;
        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.max(Number(req.query.limit) || 15, 1);
        const skip = (page - 1) * limit;

        const pageItems = mergedItems.slice(skip, skip + limit);

        const pageCandidateIds = pageItems.filter(i => i.type === 'candidate').map(i => i._id);
        const pagePublicAppIds = pageItems.filter(i => i.type === 'publicApp').map(i => i._id);

        let candidatesFetched = [];
        if (pageCandidateIds.length > 0) {
            candidatesFetched = await Candidate.find({ _id: { $in: pageCandidateIds } })
                .populate({
                    path: 'hiringRequestId',
                    select: 'requestId roleDetails client clientConfidential'
                })
                .populate('uploadedBy', 'firstName lastName email')
                .lean();
        }

        let publicAppsFetched = [];
        if (pagePublicAppIds.length > 0) {
            publicAppsFetched = await PublicApplication.find({ _id: { $in: pagePublicAppIds } })
                .populate('hiringRequestId', 'requestId roleDetails client clientConfidential')
                .populate('reviewedBy', 'firstName lastName')
                .lean();
        }

        // Map and serialize
        const serializedCandidates = pageItems.map(item => {
            if (item.type === 'candidate') {
                const candidate = candidatesFetched.find(c => String(c._id) === String(item._id));
                if (!candidate) return null;
                const serialized = serializeCandidateForViewer({
                    candidate,
                    user: req.user,
                    hiringRequest: candidate.hiringRequestId
                });
                serialized.confidenceRating = calculateCandidateMatchScore(candidate, req.query);
                return serialized;
            } else {
                const app = publicAppsFetched.find(a => String(a._id) === String(item._id));
                if (!app) return null;
                const serialized = {
                    _id: app._id,
                    candidateName: app.candidateName,
                    email: app.email,
                    mobile: app.mobile,
                    totalExperience: app.profileSnapshot?.totalExperience ?? app.profileSnapshot?.experienceYears ?? 0,
                    source: 'Public Application',
                    mustHaveSkills: (app.profileSnapshot?.skills || []).map(s => ({ skill: s })),
                    niceToHaveSkills: [],
                    hiringRequestId: app.hiringRequestId ? {
                        _id: app.hiringRequestId._id,
                        requestId: app.hiringRequestId.requestId,
                        roleDetails: app.hiringRequestId.roleDetails,
                        client: app.hiringRequestId.client,
                        clientConfidential: app.hiringRequestId.clientConfidential
                    } : null,
                    uploadedBy: app.reviewedBy ? {
                        _id: app.reviewedBy._id,
                        firstName: app.reviewedBy.firstName,
                        lastName: app.reviewedBy.lastName,
                        email: app.reviewedBy.email
                    } : null,
                    createdAt: app.createdAt,
                    isPublicApplication: true,
                    resumeUrl: app.resumeUrl
                };
                serialized.confidenceRating = calculateCandidateMatchScore(serialized, req.query);
                return serialized;
            }
        }).filter(Boolean);

        const hasActiveFilters = !!(
            req.query.search ||
            req.query.skills ||
            req.query.minExperience ||
            req.query.maxExperience ||
            req.query.location ||
            req.query.maxNoticePeriod ||
            req.query.minCurrentCTC ||
            req.query.maxCurrentCTC ||
            req.query.minExpectedCTC ||
            req.query.maxExpectedCTC ||
            req.query.source ||
            req.query.inHandOffer ||
            req.query.client ||
            req.query.decision
        );

        if (hasActiveFilters) {
            serializedCandidates.sort((a, b) => b.confidenceRating - a.confidenceRating);
        }

        res.status(200).json({
            currentPage: page,
            totalPages: Math.max(Math.ceil(total / limit), 1),
            count: total,
            limit,
            candidates: serializedCandidates
        });
    } catch (error) {
        console.error('Error in global search candidates:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

exports.getDistinctCandidateSkills = async (req, res) => {
    try {
        const skills = await Candidate.aggregate([
            { $match: { companyId: req.companyId, isDeleted: { $ne: true } } },
            {
                $project: {
                    allSkills: {
                        $concatArrays: [
                            { $ifNull: ["$mustHaveSkills.skill", []] },
                            { $ifNull: ["$niceToHaveSkills.skill", []] },
                            { $ifNull: ["$skillRatings.skill", []] }
                        ]
                    }
                }
            },
            { $unwind: "$allSkills" },
            { $group: { _id: null, uniqueSkills: { $addToSet: "$allSkills" } } }
        ]);

        const uniqueSkillsList = skills.length > 0 ? skills[0].uniqueSkills : [];
        
        const formattedSkills = uniqueSkillsList
            .map(s => String(s || '').trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));

        const uniqueSet = new Set();
        const finalSkills = [];
        formattedSkills.forEach(s => {
            const lower = s.toLowerCase();
            if (!uniqueSet.has(lower)) {
                uniqueSet.add(lower);
                finalSkills.push(s);
            }
        });

        res.status(200).json(finalSkills);
    } catch (error) {
        console.error('Error fetching distinct candidate skills:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};
exports.getCandidateCardFilters = async (req, res) => {
    try {
        const { hiringRequestId } = req.params;
        const {
            dateField,
            startDate,
            endDate,
            search = '',
            filterPreference = 'All',
            filterExperience = '',
            filterRating = 'All',
            filterPulledBy,
            filterUploadedBy,
            filterUploadType = 'All',
            filterTransferred = 'All'
        } = req.query;

        if (!mongoose.Types.ObjectId.isValid(hiringRequestId)) {
            return res.status(400).json({ message: 'Invalid Hiring Request ID format' });
        }

        const hiringRequest = await HiringRequest.findOne({ _id: hiringRequestId, companyId: req.companyId }).lean();
        if (!hiringRequest) {
            return res.status(404).json({ message: 'Hiring request not found' });
        }

        const hasHiringRequestAccess = await canAccessHiringRequest(hiringRequest, req.companyId, req.user, { action: 'view' });

        if (!hasHiringRequestAccess) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to view this request' });
        }

        const candidateQuery = await buildAccessibleCandidateQuery(
            req.companyId,
            req.user,
            { hiringRequestId },
            { capability: TA_CAPABILITIES.VIEW }
        );

        applyDateRangeFilterToCandidateQuery(candidateQuery, dateField, startDate, endDate);

        // Fetch only minimal fields for counts
        const candidates = await Candidate.find(candidateQuery)
            .select('_id candidateName status decision profileShared uploadedAt interviewRounds profilePulledBy totalExperience preference isTransferred uploadedBy resumeUrl phase2Decision phase2InterviewStatus phase2InterviewerFeedback phase3Decision')
            .populate('uploadedBy', 'firstName lastName')
            .lean();

        // Implement in-memory metrics calculation
        const normalizedSearch = String(search || '').trim().toLowerCase();
        const normalizedPulledBy = parseStringArrayQuery(filterPulledBy);
        const normalizedUploadedBy = parseStringArrayQuery(filterUploadedBy);
        const minExperience = filterExperience === '' ? null : Number(filterExperience);
        const minRating = filterRating === 'All' ? null : Number(filterRating);

        const getCandidateUploadedByName = (candidate) => (
            `${candidate?.uploadedBy?.firstName || ''} ${candidate?.uploadedBy?.lastName || ''}`.trim()
        );

        const getCandidateUploadType = (candidate) => (
            (typeof candidate?.resumeUrl === 'string' && /^https?:\/\//i.test(candidate.resumeUrl.trim())) ? 'CV' : 'Excel'
        );

        const isProfileSharedCandidate = (candidate) => (
            candidate?.profileShared === true
            || (candidate?.profileShared == null && candidate?.decision === 'Shortlisted')
        );

        const getLegacyRoundsForPhase = (candidate, phase = 1) => (
            Array.isArray(candidate?.interviewRounds)
                ? candidate.interviewRounds.filter((round) => Number(round?.phase || 1) === Number(phase))
                : []
        );

        const getLegacyAverageRatingForPhase = (candidate, phase = 1) => {
            const rounds = getLegacyRoundsForPhase(candidate, phase);
            const ratedRounds = rounds.filter((round) => Number(round?.rating) > 0);
            if (!ratedRounds.length) return null;
            return ratedRounds.reduce((sum, round) => sum + Number(round.rating || 0), 0) / ratedRounds.length;
        };

        const hasLegacyPhase2InterviewActivity = (candidate) => {
            const rounds = getLegacyRoundsForPhase(candidate, 2);
            if (rounds.length > 0) return true;
            const phase2InterviewStatus = String(candidate?.phase2InterviewStatus || '').trim();
            const phase2Feedback = String(candidate?.phase2InterviewerFeedback || '').trim();
            return Boolean(phase2InterviewStatus && phase2InterviewStatus !== 'None') || Boolean(phase2Feedback);
        };

        const matchesSearch = (candidate) => (
            !normalizedSearch || String(candidate?.candidateName || '').toLowerCase().includes(normalizedSearch)
        );

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

        const structuralPhase2Candidates = candidates.filter((candidate) => (
            isProfileSharedCandidate(candidate) && matchesCommonStructuralFilters(candidate)
        ));
        const basePhase2Candidates = structuralPhase2Candidates.filter((candidate) => matchesBaseFiltersForPhase(candidate, 2));

        const structuralPhase3Candidates = candidates.filter((candidate) => (
            candidate?.phase2Decision === 'Selected' && matchesCommonStructuralFilters(candidate)
        ));
        const basePhase3Candidates = structuralPhase3Candidates.filter((candidate) => matchesBaseFiltersForPhase(candidate, 3));

        const summary = {
            phase1Metrics: {
                total: structuralPhase1Candidates.length,
                interested: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Interested').length,
                notPicking: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Not Picking').length,
                notRelevant: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Not Relevant').length,
                notInterested: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Not Interested').length,
                highExpectation: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'High expectation').length,
                longNoticePeriod: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Long Notice period').length,
                locationNotSuitable: structuralPhase1Candidates.filter((candidate) => candidate?.status === 'Location Not suitable').length,
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
        };

        res.status(200).json({ summary });

    } catch (error) {
        console.error('Error fetching candidate card filters:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

/**
 * Global search across all public applications for this company.
 * Supports filters: search, minExperience, maxExperience, maxNoticePeriod,
 * minCurrentCTC, maxCurrentCTC, minExpectedCTC, maxExpectedCTC, reviewStatus, location
 */
exports.globalSearchPublicApplications = async (req, res) => {
    try {
        const filterQuery = { companyId: req.companyId };

        // Full-text search on name, email, mobile
        if (req.query.search) {
            const searchRegex = new RegExp(req.query.search.trim(), 'i');
            filterQuery.$or = [
                { candidateName: searchRegex },
                { email: searchRegex },
                { mobile: searchRegex }
            ];
        }

        // Review status filter
        if (req.query.reviewStatus && req.query.reviewStatus !== '') {
            filterQuery.reviewStatus = req.query.reviewStatus.trim();
        }

        // Notice period
        if (req.query.maxNoticePeriod !== undefined && req.query.maxNoticePeriod !== '') {
            const noticeVal = Number(req.query.maxNoticePeriod);
            if (Number.isFinite(noticeVal)) {
                filterQuery.noticePeriod = { $lte: noticeVal };
            }
        }

        // Current CTC range
        if (req.query.minCurrentCTC !== undefined || req.query.maxCurrentCTC !== undefined) {
            filterQuery.currentCTC = {};
            if (req.query.minCurrentCTC !== undefined && req.query.minCurrentCTC !== '') {
                const minCTC = Number(req.query.minCurrentCTC);
                if (Number.isFinite(minCTC)) filterQuery.currentCTC.$gte = minCTC;
            }
            if (req.query.maxCurrentCTC !== undefined && req.query.maxCurrentCTC !== '') {
                const maxCTC = Number(req.query.maxCurrentCTC);
                if (Number.isFinite(maxCTC)) filterQuery.currentCTC.$lte = maxCTC;
            }
            if (Object.keys(filterQuery.currentCTC).length === 0) delete filterQuery.currentCTC;
        }

        // Expected CTC range
        if (req.query.minExpectedCTC !== undefined || req.query.maxExpectedCTC !== undefined) {
            filterQuery.expectedCTC = {};
            if (req.query.minExpectedCTC !== undefined && req.query.minExpectedCTC !== '') {
                const minCTC = Number(req.query.minExpectedCTC);
                if (Number.isFinite(minCTC)) filterQuery.expectedCTC.$gte = minCTC;
            }
            if (req.query.maxExpectedCTC !== undefined && req.query.maxExpectedCTC !== '') {
                const maxCTC = Number(req.query.maxExpectedCTC);
                if (Number.isFinite(maxCTC)) filterQuery.expectedCTC.$lte = maxCTC;
            }
            if (Object.keys(filterQuery.expectedCTC).length === 0) delete filterQuery.expectedCTC;
        }

        // Client filter — resolve hiring request IDs for this client
        if (req.query.client) {
            const clientHiringRequests = await HiringRequest.find({
                companyId: req.companyId,
                client: new RegExp(req.query.client.trim(), 'i')
            }).select('_id').lean();
            filterQuery.hiringRequestId = { $in: clientHiringRequests.map(hr => hr._id) };
        }

        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.max(Number(req.query.limit) || 15, 1);
        const skip = (page - 1) * limit;

        const [total, applications] = await Promise.all([
            PublicApplication.countDocuments(filterQuery),
            PublicApplication.find(filterQuery)
                .populate('applicantId', 'firstName lastName email mobile currentCity currentState')
                .populate('hiringRequestId', 'requestId roleDetails client clientConfidential')
                .populate('reviewedBy', 'firstName lastName')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        // Apply in-memory experience filter using profileSnapshot data if present
        // (Public applications don't directly store experience, but profileSnapshot might)
        let filteredApps = applications;

        if (req.query.minExperience !== undefined && req.query.minExperience !== '' ||
            req.query.maxExperience !== undefined && req.query.maxExperience !== '') {
            const minExp = req.query.minExperience !== '' ? Number(req.query.minExperience) : null;
            const maxExp = req.query.maxExperience !== '' ? Number(req.query.maxExperience) : null;
            filteredApps = filteredApps.filter(app => {
                const expYears = app.profileSnapshot?.totalExperience ?? app.profileSnapshot?.experienceYears ?? null;
                if (expYears === null || expYears === undefined) return true; // include if unknown
                if (minExp !== null && Number.isFinite(minExp) && expYears < minExp) return false;
                if (maxExp !== null && Number.isFinite(maxExp) && expYears > maxExp) return false;
                return true;
            });
        }

        res.status(200).json({
            currentPage: page,
            totalPages: Math.max(Math.ceil(total / limit), 1),
            count: total,
            limit,
            applications: filteredApps
        });
    } catch (error) {
        console.error('Error in global search public applications:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};
