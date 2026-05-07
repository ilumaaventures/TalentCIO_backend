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

router.use(protect);
router.use(requireModule('talentAcquisition'));
// Base path: /api/ta/candidates

// Upload resume
router.post('/upload-resume/:hiringRequestId', protect, authorizeAny(['ta.create']), upload.single('resume'), candidateController.uploadResume);

// Parse resume without uploading to Cloudinary
router.post('/parse-resume', protect, authorizeAny(['ta.create']), memoryUpload.single('resume'), candidateController.parseResume);

// Get discrete sources
router.get('/user/:userName', protect, candidateController.getCandidatesByPulledBy);
router.get('/sources', protect, candidateController.getCandidateSources);
router.post('/sources', protect, authorizeAny(['ta.create']), candidateController.addCandidateSource);
router.delete('/sources/:id', protect, authorizeAny(['ta.delete', 'ta.candidate.edit']), candidateController.deleteCandidateSource);

// CRUD operations
router.post('/', protect, authorizeAny(['ta.create']), candidateController.createCandidate);
router.get('/:hiringRequestId', protect, candidateController.getCandidatesByHiringRequest);
router.get('/shortlisted/:hiringRequestId', protect, candidateController.getShortlistedCandidates);
router.get('/candidate/:id', protect, candidateController.getCandidateById);
router.put('/:id', protect, candidateController.updateCandidate);
router.delete('/:id', protect, candidateController.deleteCandidate);

// Status update
router.patch('/:id/status', protect, candidateController.updateCandidateStatus);
router.patch('/:id/remark', protect, candidateController.updateCandidateRemark);
router.patch('/:id/internal-remark', protect, candidateController.updateCandidateInternalRemark);
router.patch('/:id/decision', protect, candidateController.updateCandidateDecision);
router.patch('/:id/phase2-decision', protect, candidateController.updatePhase2Decision);
router.patch('/:id/phase3-decision', protect, candidateController.updatePhase3Decision);
router.post('/:id/transfer-to-onboarding', protect, candidateController.transferToOnboarding);

// Current User's Scheduled Interviews
router.get('/my/interviews', protect, candidateController.getMyScheduledInterviews);

// Interview Rounds
router.post('/:id/rounds', protect, candidateController.addInterviewRound);
router.put('/:id/rounds/:roundId', protect, candidateController.updateInterviewRound);
router.delete('/:id/rounds/:roundId', protect, candidateController.deleteInterviewRound);
router.patch('/:id/rounds/:roundId/evaluate', protect, candidateController.evaluateInterviewRound);

// Skill Ratings
router.put('/:id/skill-ratings', protect, candidateController.updateSkillRatings);
router.post('/:id/skill-ratings', protect, candidateController.addSkillRating);
router.delete('/:id/skill-ratings/:skillId', protect, candidateController.deleteSkillRating);

module.exports = router;
