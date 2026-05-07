const express = require('express');
const router = express.Router();
const workflowController = require('../controllers/workflowController');
const { protect } = require('../middlewares/authMiddleware');
const { requireModule } = require('../middlewares/moduleGuard');
const { authorizeAny } = require('../middlewares/authorize');

router.use(protect);
router.use(requireModule('talentAcquisition'));
router.use(authorizeAny(['ta.config.manage', 'ta.edit']));

router.post('/', workflowController.createWorkflow);
router.get('/', workflowController.getWorkflows);
router.get('/:id', workflowController.getWorkflowById);
router.put('/:id', workflowController.updateWorkflow);
router.delete('/:id', workflowController.deleteWorkflow);

module.exports = router;
