const express = require('express');
const router = express.Router();
const { protect, blockDuringImpersonation } = require('../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../common/middleware/authorize');
const {
    impersonateUser,
    endImpersonation,
    getImpersonationStatus
} = require('./impersonation.controller');
const { getEmployeePerformance } = require('../performance/performance.controller');
const { requireModule } = require('../../common/middleware/moduleGuard');

// End impersonation and get status
router.post('/impersonate/end', protect, endImpersonation);
router.get('/impersonate/status', protect, getImpersonationStatus);

// Employee cross-project project performance
router.get('/:id/performance', protect, requireModule(['projects', 'timesheet', 'attendance']), getEmployeePerformance);

// Start impersonation (Tier A: Company Admin -> Employee)
router.post('/:id/impersonate', protect, authorizeAny(['user.impersonate']), blockDuringImpersonation, impersonateUser);

module.exports = router;
