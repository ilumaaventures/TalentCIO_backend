const express = require('express');
const router = express.Router();
const { protectSuperAdmin, requirePermission } = require('../../common/middleware/superAdminAuth');
const { getAllUsers, deactivateUser, resetPassword, changeRole } = require('./globalUser.controller');
const { superAdminImpersonateUser } = require('./impersonation.controller');

router.use(protectSuperAdmin);

router.get('/', getAllUsers);
router.post('/:id/impersonate', requirePermission('impersonateUsers'), superAdminImpersonateUser);
router.patch('/:id/deactivate', requirePermission('manageUsers'), deactivateUser);
router.post('/:id/reset-password', requirePermission('manageUsers'), resetPassword);
router.patch('/:id/role', requirePermission('manageUsers'), changeRole);

module.exports = router;

