const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
// Note: requireModule added after protect middleware
const candidateController = require('../controllers/candidateController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { upload } = require('../config/cloudinary');
const multer = require('multer');
const memoryUpload = multer({ storage: multer.memoryStorage() });

router.use(protect);
router.use(requireModule('talentAcquisition'));
// Base path: /api/ta/candidates

// Upload resume
router.post('/upload-resume/:hiringRequestId', protect, authorize('ta.create'), upload.single('resume'), candidateController.uploadResume);

// Parse resume without uploading to Cloudinary
router.post('/parse-resume', protect, authorize('ta.create'), memoryUpload.single('resume'), candidateController.parseResume);

// Get discrete sources
router.get('/user/:userName', protect, authorize('ta.view'), candidateController.getCandidatesByPulledBy);
router.get('/sources', protect, authorize('ta.view'), candidateController.getCandidateSources);
router.post('/sources', protect, authorize('ta.create'), candidateController.addCandidateSource);
router.delete('/sources/:id', protect, authorize('ta.delete'), candidateController.deleteCandidateSource);

// CRUD operations
router.post('/', protect, authorize('ta.create'), candidateController.createCandidate);
router.get('/:hiringRequestId', protect, candidateController.getCandidatesByHiringRequest);
router.get('/shortlisted/:hiringRequestId', protect, candidateController.getShortlistedCandidates);
router.get('/candidate/:id', protect, candidateController.getCandidateById);
router.put('/:id', protect, authorize('ta.edit'), candidateController.updateCandidate);
router.delete('/:id', protect, authorize('ta.delete'), candidateController.deleteCandidate);

// Status update
router.patch('/:id/status', protect, authorize('ta.edit'), candidateController.updateCandidateStatus);
router.patch('/:id/remark', protect, authorize('ta.edit'), candidateController.updateCandidateRemark);
router.patch('/:id/internal-remark', protect, candidateController.updateCandidateInternalRemark);
router.patch('/:id/decision', protect, authorize('ta.edit', 'ta.decision'), candidateController.updateCandidateDecision);
router.patch('/:id/phase2-decision', protect, authorize('ta.edit', 'ta.decision'), candidateController.updatePhase2Decision);
router.patch('/:id/phase3-decision', protect, authorize('ta.edit', 'ta.decision'), candidateController.updatePhase3Decision);
router.post('/:id/transfer-to-onboarding', protect, authorize('ta.edit'), candidateController.transferToOnboarding);

// Current User's Scheduled Interviews
router.get('/my/interviews', protect, candidateController.getMyScheduledInterviews);

// Interview Rounds
router.post('/:id/rounds', protect, authorize('ta.edit'), candidateController.addInterviewRound);
router.put('/:id/rounds/:roundId', protect, authorize('ta.edit'), candidateController.updateInterviewRound);
router.delete('/:id/rounds/:roundId', protect, authorize('ta.delete'), candidateController.deleteInterviewRound);
router.patch('/:id/rounds/:roundId/evaluate', protect, candidateController.evaluateInterviewRound);

// Skill Ratings
router.put('/:id/skill-ratings', protect, authorize('ta.edit'), candidateController.updateSkillRatings);
router.post('/:id/skill-ratings', protect, authorize('ta.edit'), candidateController.addSkillRating);
router.delete('/:id/skill-ratings/:skillId', protect, authorize('ta.edit'), candidateController.deleteSkillRating);

module.exports = router;
