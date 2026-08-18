const express = require('express');
const router = express.Router();
const { protect, blockDuringImpersonation } = require('../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../common/middleware/authorize');
const {
    impersonateUser,
    endImpersonation,
    getImpersonationStatus
} = require('./impersonation.controller');

// End impersonation and get status
router.post('/impersonate/end', protect, endImpersonation);
router.get('/impersonate/status', protect, getImpersonationStatus);

// Start impersonation (Tier A: Company Admin -> Employee)
router.post('/:id/impersonate', protect, authorizeAny(['user.impersonate']), blockDuringImpersonation, impersonateUser);

module.exports = router;
