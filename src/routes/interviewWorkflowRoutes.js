const express = require('express');
const router = express.Router();
const interviewWorkflowController = require('../controllers/interviewWorkflowController');
const { protect } = require('../middlewares/authMiddleware');
const { authorizeAny } = require('../middlewares/authorize');
const { requireModule } = require('../middlewares/moduleGuard');

router.use(protect);
router.use(requireModule('talentAcquisition'));
router.use(authorizeAny(['ta.config.manage', 'ta.edit']));

router.post('/', interviewWorkflowController.createInterviewWorkflow);
router.get('/', interviewWorkflowController.getInterviewWorkflows);
router.get('/:id', interviewWorkflowController.getInterviewWorkflowById);
router.put('/:id', interviewWorkflowController.updateInterviewWorkflow);
router.delete('/:id', interviewWorkflowController.deleteInterviewWorkflow);

module.exports = router;
