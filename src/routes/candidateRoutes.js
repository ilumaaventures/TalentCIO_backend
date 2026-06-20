const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
// Note: requireModule added after protect middleware
const candidateController = require('../controllers/candidateController');
const { protect } = require('../middlewares/authMiddleware');
const { authorizeAny } = require('../middlewares/authorize');
const { upload } = require('../config/cloudinary');
const multer = require('multer');
const memoryUpload = multer({ storage: multer.memoryStorage() });
const analyticsCandidatePermissions = ['ta.analytics.assigned', 'ta.analytics.global'];
const candidateCreatePermissions = ['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.create', 'ta.interview.evaluate', ...analyticsCandidatePermissions];
const candidateEditPermissions = ['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.edit', 'ta.edit', ...analyticsCandidatePermissions];
const candidateDecisionPermissions = ['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.make_decision'];
const candidateTransferPermissions = ['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.transfer'];
const interviewSchedulingPermissions = ['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.candidate.edit', 'ta.edit', ...analyticsCandidatePermissions];
const interviewEvaluationPermissions = ['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.interview.evaluate', 'ta.super_approve'];

router.use(protect);
router.use(requireModule('talentAcquisition'));
// Base path: /api/ta/candidates

// Upload resume
router.post('/upload-resume/:hiringRequestId', protect, authorizeAny(candidateCreatePermissions), upload.single('resume'), candidateController.uploadResume);

// Parse resume without uploading to Cloudinary
router.post('/parse-resume', protect, authorizeAny(candidateCreatePermissions), memoryUpload.single('resume'), candidateController.parseResume);

// Get discrete sources
router.get('/user/:userName', protect, candidateController.getCandidatesByPulledBy);
router.get('/duplicate-check', protect, authorizeAny(candidateCreatePermissions), candidateController.checkDuplicateCandidate);
router.get('/sources', protect, candidateController.getCandidateSources);
router.get('/skills/distinct', protect, candidateController.getDistinctCandidateSkills);
router.post('/sources', protect, authorizeAny(candidateCreatePermissions), candidateController.addCandidateSource);
router.delete('/sources/:id', protect, authorizeAny(['ta.candidate.manage.assigned', 'ta.candidate.manage.all', 'ta.delete', 'ta.candidate.edit']), candidateController.deleteCandidateSource);

// CRUD operations
router.get('/global/search', protect, candidateController.globalSearchCandidates);
router.post('/', protect, candidateController.createCandidate);
router.get('/:hiringRequestId/card-filters', protect, candidateController.getCandidateCardFilters);
router.get('/:hiringRequestId', protect, candidateController.getCandidatesByHiringRequest);
router.get('/shortlisted/:hiringRequestId', protect, candidateController.getShortlistedCandidates);
router.get('/candidate/:id/details', protect, candidateController.getCandidateDetailsById);
router.get('/candidate/:id', protect, candidateController.getCandidateById);
router.put('/:id', protect, authorizeAny(candidateEditPermissions), candidateController.updateCandidate);
router.delete('/:id', protect, authorizeAny([...candidateEditPermissions, 'ta.delete']), candidateController.deleteCandidate);

// Status update
router.patch('/:id/status', protect, authorizeAny(candidateEditPermissions), candidateController.updateCandidateStatus);
router.patch('/:id/remark', protect, authorizeAny(candidateEditPermissions), candidateController.updateCandidateRemark);
router.patch('/:id/internal-remark', protect, authorizeAny(candidateEditPermissions), candidateController.updateCandidateInternalRemark);
router.patch('/:id/decision', protect, authorizeAny(candidateDecisionPermissions), candidateController.updateCandidateDecision);
router.patch('/:id/phase2-decision', protect, authorizeAny(candidateDecisionPermissions), candidateController.updatePhase2Decision);
router.patch('/:id/move-back-phase', protect, authorizeAny(candidateEditPermissions), candidateController.moveCandidateToPreviousPhase);
router.patch('/:id/phase3-decision', protect, authorizeAny(candidateDecisionPermissions), candidateController.updatePhase3Decision);
router.post('/:id/transfer-to-onboarding', protect, authorizeAny(candidateTransferPermissions), candidateController.transferToOnboarding);

// Current User's Scheduled Interviews
router.get('/my/interviews', protect, authorizeAny(['ta.interview.evaluate', 'ta.candidate.manage.assigned', 'ta.candidate.manage.all']), candidateController.getMyScheduledInterviews);

// Bulk Interview Scheduling (must be before /:id routes)
router.post('/bulk-schedule-interview', protect, authorizeAny(interviewSchedulingPermissions), candidateController.bulkScheduleInterview);

// Interview Rounds
router.post('/:id/rounds', protect, authorizeAny(interviewSchedulingPermissions), candidateController.addInterviewRound);
router.put('/:id/rounds/:roundId', protect, authorizeAny(interviewSchedulingPermissions), candidateController.updateInterviewRound);
router.delete('/:id/rounds/:roundId', protect, authorizeAny(interviewSchedulingPermissions), candidateController.deleteInterviewRound);
router.patch('/:id/rounds/:roundId/evaluate', protect, candidateController.evaluateInterviewRound);

// Skill Ratings
router.put('/:id/skill-ratings', protect, authorizeAny(candidateEditPermissions), candidateController.updateSkillRatings);
router.post('/:id/skill-ratings', protect, authorizeAny(candidateEditPermissions), candidateController.addSkillRating);
router.delete('/:id/skill-ratings/:skillId', protect, authorizeAny(candidateEditPermissions), candidateController.deleteSkillRating);

module.exports = router;
