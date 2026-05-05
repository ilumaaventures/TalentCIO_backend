const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const candidateDynamicPhaseController = require('../controllers/candidateDynamicPhaseController');

const router = express.Router();

router.use(protect);
router.use(requireModule('talentAcquisition'));

router.post('/candidates/dynamic-phase/bulk-status', authorize(['ta.edit']), candidateDynamicPhaseController.bulkUpdateStatus);
router.patch('/candidates/:candidateId/dynamic-phase/status', authorize(['ta.edit']), candidateDynamicPhaseController.updatePhaseStatus);
router.post('/candidates/:candidateId/dynamic-phase/decision', authorize(['ta.edit', 'ta.decision']), candidateDynamicPhaseController.recordDecision);
router.post('/candidates/:candidateId/dynamic-phase/advance', authorize(['ta.edit']), candidateDynamicPhaseController.manualAdvance);
router.get('/candidates/:candidateId/dynamic-phase/history', candidateDynamicPhaseController.getPhaseHistory);

module.exports = router;
