const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const emailSettingsController = require('../controllers/emailSettingsController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize, authorizeAny } = require('../middlewares/authorize');

const router = express.Router();

const testEmailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (
        req.companyId
            ? `company:${String(req.companyId)}`
            : ipKeyGenerator(req.ip || '')
    ),
    message: {
        message: 'Test email limit reached for this company. Please try again in 1 hour.'
    }
});

router.use(protect);

router.get(
    '/senders',
    authorizeAny([
        'settings.email.view',
        'settings.email.manage',
        'settings.notification.view',
        'settings.notification.manage',
        'onboarding.view',
        'onboarding.document.review',
        'onboarding.document.request',
        'onboarding.credential.manage',
        'onboarding.complete',
        'onboarding.manage',
        'ta.mass_mail',
        'ta.edit',
        'ta.candidate.manage.assigned',
        'ta.candidate.manage.all'
    ]),
    emailSettingsController.getAvailableEmailSenders
);

router.get(
    '/',
    authorize('settings.email.view'),
    emailSettingsController.getEmailSettings
);

router.put(
    '/',
    authorize('settings.email.manage'),
    emailSettingsController.updateEmailSettings
);

router.post(
    '/test',
    authorize('settings.email.manage'),
    testEmailLimiter,
    emailSettingsController.sendTestEmail
);

router.post(
    '/verify-sender',
    authorize('settings.email.manage'),
    emailSettingsController.verifySenderAddress
);

module.exports = router;
