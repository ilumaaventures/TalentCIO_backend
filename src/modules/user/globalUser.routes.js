const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../../common/middleware/superAdminAuth');
const { getAllUsers, deactivateUser, resetPassword, changeRole } = require('./globalUser.controller');

router.use(protectSuperAdmin);

router.get('/', getAllUsers);
router.patch('/:id/deactivate', deactivateUser);
router.post('/:id/reset-password', resetPassword);
router.patch('/:id/role', changeRole);

module.exports = router;
