const express = require('express');
const router = express.Router();
const workflowController = require('./workflow.controller');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorizeRoleOrPermission } = require('../../common/middleware/authorize');

const canViewWorkflow = authorizeRoleOrPermission({
    roles: ['Admin', 'HR Admin', 'System Admin'],
    permissions: [
        'ta.manage',
        'ta.config.view',
        'ta.config.edit',
        'ta.requisition.create',
        'ta.requisition.update',
        'ta.requisition.manage.assigned',
        'ta.requisition.manage.all',
        'reimbursement.manage'
    ]
});

const canEditWorkflow = authorizeRoleOrPermission({
    roles: ['Admin', 'HR Admin', 'System Admin'],
    permissions: ['ta.manage', 'ta.config.edit', 'reimbursement.manage']
});

router.use(protect);

router.post('/', canEditWorkflow, workflowController.createWorkflow);
router.get('/', canViewWorkflow, workflowController.getWorkflows);
router.get('/:id', canViewWorkflow, workflowController.getWorkflowById);
router.put('/:id', canEditWorkflow, workflowController.updateWorkflow);
router.delete('/:id', canEditWorkflow, workflowController.deleteWorkflow);

module.exports = router;
