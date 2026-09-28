const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { requireModule } = require('../../common/middleware/moduleGuard');
const {
    getProjectPerformance,
    getProjectMemberPerformance,
    getEmployeePerformance
} = require('./performance.controller');

router.use(protect);
router.use(requireModule(['projects', 'timesheet', 'attendance']));

// Project Performance endpoints
router.get('/projects/:id', getProjectPerformance);
router.get('/projects/:id/:userId', getProjectMemberPerformance);

// Employee Cross-Project Performance endpoint
router.get('/users/:id', getEmployeePerformance);

module.exports = router;
