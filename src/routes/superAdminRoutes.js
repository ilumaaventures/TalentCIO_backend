const express = require('express');
const router = express.Router();
const { login, getMe, seedSuperAdmin, updateProfile, updatePassword } = require('../controllers/superAdminAuthController');
const { protectSuperAdmin } = require('../middlewares/superAdminAuth');

router.post('/login', login);
router.post('/seed', seedSuperAdmin); // One-time seed utility
router.get('/me', protectSuperAdmin, getMe);
router.put('/profile', protectSuperAdmin, updateProfile);
router.put('/password', protectSuperAdmin, updatePassword);

module.exports = router;
