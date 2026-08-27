const express = require('express');
const router = express.Router();
const interviewerController = require('../controllers/interviewerController/interviewer.controller');
const { protect } = require('../../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../../common/middleware/authorize');
const { requireModule } = require('../../../common/middleware/moduleGuard');

const workflowViewPermissions = [
    'ta.manage',
    'ta.config.view',
    'ta.config.edit',
    'ta.requisition.create',
    'ta.requisition.update',
    'ta.requisition.manage.assigned',
    'ta.requisition.manage.all',
    'ta.candidate.view',
    'ta.candidate.manage.assigned',
    'ta.candidate.manage.all'
];
const workflowEditPermissions = ['ta.manage', 'ta.config.edit'];

router.use(protect);
router.use(requireModule('talentAcquisition'));

router.get('/', authorizeAny(workflowViewPermissions), interviewerController.getInterviewers);
router.post('/', authorizeAny(workflowEditPermissions), interviewerController.addInterviewers);
router.put('/', authorizeAny(workflowEditPermissions), interviewerController.syncInterviewers);
router.delete('/:userId', authorizeAny(workflowEditPermissions), interviewerController.removeInterviewer);

module.exports = router;
