const express = require('express');
const router = express.Router();
const clientAuthController = require('./clientAuth.controller');
const { protectClient } = require('../../common/middleware/clientAuthMiddleware');

router.post('/login', clientAuthController.login);
router.post('/accept-invite', clientAuthController.acceptInvite);
router.post('/forgot-password', clientAuthController.forgotPassword);
router.post('/reset-password', clientAuthController.resetPassword);
router.get('/me', protectClient, clientAuthController.getMe);
router.post('/logout', protectClient, clientAuthController.logout);

module.exports = router;
