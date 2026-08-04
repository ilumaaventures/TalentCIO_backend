/**
 * Candidate Controller Aggregator
 * 
 * Re-exports candidate controller methods organized into feature modules under ./candidate/
 */

const candidateResumeController = require('./candidate/candidateResumeController');
const candidateSourceController = require('./candidate/candidateSourceController');
const candidateSearchController = require('./candidate/candidateSearchController');
const candidateCrudController = require('./candidate/candidateCrudController');
const candidateStatusController = require('./candidate/candidateStatusController');
const candidateDecisionController = require('./candidate/candidateDecisionController');
const candidateInterviewController = require('./candidate/candidateInterviewController');
const candidateSkillController = require('./candidate/candidateSkillController');

module.exports = {
    // Resume Operations
    uploadResume: candidateResumeController.uploadResume,
    parseResume: candidateResumeController.parseResume,

    // Source Operations
    getCandidateSources: candidateSourceController.getCandidateSources,
    addCandidateSource: candidateSourceController.addCandidateSource,
    deleteCandidateSource: candidateSourceController.deleteCandidateSource,

    // Search and Filter Operations
    checkDuplicateCandidate: candidateSearchController.checkDuplicateCandidate,
    getCandidatesByPulledBy: candidateSearchController.getCandidatesByPulledBy,
    globalSearchCandidates: candidateSearchController.globalSearchCandidates,
    getDistinctCandidateSkills: candidateSearchController.getDistinctCandidateSkills,
    getCandidateCardFilters: candidateSearchController.getCandidateCardFilters,
    globalSearchPublicApplications: candidateSearchController.globalSearchPublicApplications,
    getCandidateInterviewDetails: candidateSearchController.getCandidateInterviewDetails,
    getCandidateRoundSummary: candidateSearchController.getCandidateRoundSummary,

    // CRUD Operations
    createCandidate: candidateCrudController.createCandidate,
    getCandidatesByHiringRequest: candidateCrudController.getCandidatesByHiringRequest,
    getShortlistedCandidates: candidateCrudController.getShortlistedCandidates,
    getCandidateByIdPayload: candidateCrudController.getCandidateByIdPayload,
    getCandidateById: candidateCrudController.getCandidateById,
    getCandidateDetailsById: candidateCrudController.getCandidateDetailsById,
    updateCandidate: candidateCrudController.updateCandidate,
    deleteCandidate: candidateCrudController.deleteCandidate,

    // Status and Remark Operations
    updateCandidateStatus: candidateStatusController.updateCandidateStatus,
    updateCandidateRemark: candidateStatusController.updateCandidateRemark,
    updateCandidateInternalRemark: candidateStatusController.updateCandidateInternalRemark,

    // Decision and Transition Operations
    updateCandidateDecision: candidateDecisionController.updateCandidateDecision,
    bulkUpdateDecision: candidateDecisionController.bulkUpdateDecision,
    updatePhase2Decision: candidateDecisionController.updatePhase2Decision,
    moveCandidateToPreviousPhase: candidateDecisionController.moveCandidateToPreviousPhase,
    updatePhase3Decision: candidateDecisionController.updatePhase3Decision,
    transferToOnboarding: candidateDecisionController.transferToOnboarding,

    // Interview Management Operations
    addInterviewRound: candidateInterviewController.addInterviewRound,
    updateInterviewRound: candidateInterviewController.updateInterviewRound,
    deleteInterviewRound: candidateInterviewController.deleteInterviewRound,
    sendInterviewRoundEmail: candidateInterviewController.sendInterviewRoundEmail,
    previewInterviewRoundEmail: candidateInterviewController.previewInterviewRoundEmail,
    getMyScheduledInterviews: candidateInterviewController.getMyScheduledInterviews,
    evaluateInterviewRound: candidateInterviewController.evaluateInterviewRound,
    bulkScheduleInterview: candidateInterviewController.bulkScheduleInterview,

    // Skill Ratings Operations
    updateSkillRatings: candidateSkillController.updateSkillRatings,
    addSkillRating: candidateSkillController.addSkillRating,
    deleteSkillRating: candidateSkillController.deleteSkillRating
};
