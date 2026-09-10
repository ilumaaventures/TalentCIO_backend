const express = require('express');
const router = express.Router();
const clientAuthController = require('./clientAuth.controller');
const { protectClient } = require('../../common/middleware/clientAuthMiddleware');
const { authLimiter } = require('../../common/middleware/rateLimitMiddleware');

router.post('/login', authLimiter, clientAuthController.login);
router.post('/accept-invite', authLimiter, clientAuthController.acceptInvite);
router.post('/forgot-password', authLimiter, clientAuthController.forgotPassword);
router.post('/reset-password', authLimiter, clientAuthController.resetPassword);
router.get('/me', protectClient, clientAuthController.getMe);
router.post('/logout', protectClient, clientAuthController.logout);

module.exports = router;
