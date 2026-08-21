const express = require('express');
const router = express.Router();
const { protectSuperAdmin, requirePermission } = require('../../common/middleware/superAdminAuth');
const { getAllUsers, deactivateUser, resetPassword, changeRole } = require('./globalUser.controller');
const { superAdminImpersonateUser } = require('./impersonation.controller');

router.use(protectSuperAdmin);

router.get('/', getAllUsers);
router.post('/:id/impersonate', requirePermission('impersonateUsers'), superAdminImpersonateUser);
router.patch('/:id/deactivate', deactivateUser);
router.post('/:id/reset-password', resetPassword);
router.patch('/:id/role', changeRole);

module.exports = router;

