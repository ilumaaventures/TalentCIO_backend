const express = require('express');
const router = express.Router();
const interviewWorkflowController = require('../controllers/interviewWorkflowController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');

// Make all routes protected and accessible by Admin or ta.workflows_manage (using ta.edit for now)
router.use(protect);
router.use(authorize(['ta.edit'])); // Assuming ta.edit is the standard authorization for managing configuration

router.post('/', interviewWorkflowController.createInterviewWorkflow);
router.get('/', interviewWorkflowController.getInterviewWorkflows);
router.get('/:id', interviewWorkflowController.getInterviewWorkflowById);
router.put('/:id', interviewWorkflowController.updateInterviewWorkflow);
router.delete('/:id', interviewWorkflowController.deleteInterviewWorkflow);

module.exports = router;
