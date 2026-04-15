const express = require('express');
const router = express.Router();
const workflowController = require('../controllers/workflowController');
const { protect } = require('../middlewares/authMiddleware');

router.post('/', protect, workflowController.createWorkflow);
router.get('/', protect, workflowController.getWorkflows);
router.get('/:id', protect, workflowController.getWorkflowById);
router.put('/:id', protect, workflowController.updateWorkflow);
router.delete('/:id', protect, workflowController.deleteWorkflow);

module.exports = router;
