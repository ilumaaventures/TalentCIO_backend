const express = require('express');
const router = express.Router();
const interviewWorkflowController = require('../controllers/interviewWorkflowController');
const { protect } = require('../middlewares/authMiddleware');
const { authorizeAny } = require('../middlewares/authorize');
const { requireModule } = require('../middlewares/moduleGuard');
const workflowViewPermissions = [
    'ta.manage',
    'ta.config.view',
    'ta.config.edit',
    'ta.requisition.create',
    'ta.requisition.update',
    'ta.requisition.manage.assigned',
    'ta.requisition.manage.all'
];
const workflowEditPermissions = ['ta.manage', 'ta.config.edit'];

router.use(protect);
router.use(requireModule('talentAcquisition'));

router.post('/', authorizeAny(workflowEditPermissions), interviewWorkflowController.createInterviewWorkflow);
router.get('/', authorizeAny(workflowViewPermissions), interviewWorkflowController.getInterviewWorkflows);
router.get('/:id', authorizeAny(workflowViewPermissions), interviewWorkflowController.getInterviewWorkflowById);
router.put('/:id', authorizeAny(workflowEditPermissions), interviewWorkflowController.updateInterviewWorkflow);
router.delete('/:id', authorizeAny(workflowEditPermissions), interviewWorkflowController.deleteInterviewWorkflow);

module.exports = router;
