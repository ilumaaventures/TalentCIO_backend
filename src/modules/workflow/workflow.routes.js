const express = require('express');
const router = express.Router();
const workflowController = require('./workflow.controller');
const { protect } = require('../../common/middleware/authMiddleware');
const { requireModule } = require('../../common/middleware/moduleGuard');
const { authorizeAny } = require('../../common/middleware/authorize');
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

router.post('/', authorizeAny(workflowEditPermissions), workflowController.createWorkflow);
router.get('/', authorizeAny(workflowViewPermissions), workflowController.getWorkflows);
router.get('/:id', authorizeAny(workflowViewPermissions), workflowController.getWorkflowById);
router.put('/:id', authorizeAny(workflowEditPermissions), workflowController.updateWorkflow);
router.delete('/:id', authorizeAny(workflowEditPermissions), workflowController.deleteWorkflow);

module.exports = router;
