const express = require('express');
const { requireModule } = require('../../../common/middleware/moduleGuard');
const { protect } = require('../../../common/middleware/authMiddleware');
const candidateDynamicPhaseController = require('../controllers/dynamicPhaseController/candidateDynamicPhase.controller');

const router = express.Router();

router.use(protect);
router.use(requireModule('talentAcquisition'));

router.post('/candidates/dynamic-phase/bulk-status', candidateDynamicPhaseController.bulkUpdateStatus);
router.post('/candidates/dynamic-phase/bulk-advance', candidateDynamicPhaseController.bulkMoveToNextPhase);
router.patch('/candidates/:candidateId/dynamic-phase/status', candidateDynamicPhaseController.updatePhaseStatus);
router.post('/candidates/:candidateId/dynamic-phase/decision', candidateDynamicPhaseController.recordDecision);
router.post('/candidates/:candidateId/dynamic-phase/advance', candidateDynamicPhaseController.manualAdvance);
router.get('/candidates/:candidateId/dynamic-phase/history', candidateDynamicPhaseController.getPhaseHistory);

module.exports = router;
