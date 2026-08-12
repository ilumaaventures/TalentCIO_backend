const express = require('express');
const router = express.Router();
const { login, logout, getMe, seedSuperAdmin, updateProfile, updatePassword } = require('./superAdminAuth.controller');
const { protectSuperAdmin } = require('../../common/middleware/superAdminAuth');

router.post('/login', login);
router.post('/seed', seedSuperAdmin); // One-time seed utility
router.post('/logout', logout);
router.get('/me', protectSuperAdmin, getMe);
router.put('/profile', protectSuperAdmin, updateProfile);
router.put('/password', protectSuperAdmin, updatePassword);

module.exports = router;
