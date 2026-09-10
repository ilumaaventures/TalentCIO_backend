const express = require('express');
const router = express.Router();
const clientPortalController = require('./clientPortal.controller');
const { protectClient, requireClientRole } = require('../../common/middleware/clientAuthMiddleware');

// All client portal routes require protectClient
router.use(protectClient);

router.get('/dashboard', clientPortalController.getDashboard);
router.get('/requisitions', clientPortalController.getRequisitions);
router.get('/requisitions/:id', clientPortalController.getRequisitionById);
router.get('/requisitions/:id/candidates', clientPortalController.getRequisitionCandidates);
router.get('/candidates/:id', clientPortalController.getCandidateById);

// Interview endpoints
router.get('/interviews/my', clientPortalController.getMyInterviews);
router.get('/my/interviews', clientPortalController.getMyInterviews);
router.patch('/candidates/:id/rounds/:roundId/evaluate', clientPortalController.evaluateRound);
router.patch('/candidates/:id/rounds/:roundId/schedule', clientPortalController.scheduleRound);
router.patch('/candidates/:id/client-decision', clientPortalController.submitClientDecision);

// Team management (ClientAdmin only)
router.get('/team', requireClientRole('ClientAdmin'), clientPortalController.getTeam);
router.post('/team/invite', requireClientRole('ClientAdmin'), clientPortalController.inviteTeamMember);
router.patch('/team/:userId', requireClientRole('ClientAdmin'), clientPortalController.updateTeamMember);
router.delete('/team/:userId', requireClientRole('ClientAdmin'), clientPortalController.removeTeamMember);

// Requisition Panel management (ClientAdmin only)
router.post('/requisitions/:id/panel', requireClientRole('ClientAdmin'), clientPortalController.addPanelMember);
router.delete('/requisitions/:id/panel/:clientUserId', requireClientRole('ClientAdmin'), clientPortalController.removePanelMember);

module.exports = router;
