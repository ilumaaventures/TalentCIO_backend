const express = require('express');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../common/middleware/authorize');
const controller = require('./controller/emailTemplate.controller');

const router = express.Router();

const canViewTemplates = authorizeAny([
    'settings.email.view',
    'settings.email.manage',
    'onboarding.view',
    'onboarding.document.review',
    'onboarding.document.request',
    'onboarding.credential.manage',
    'onboarding.complete',
    'onboarding.manage',
    'offboarding.read',
    'offboarding.create',
    'offboarding.update'
]);

const canManageTemplates = authorizeAny([
    'settings.email.manage'
]);

router.use(protect);
router.use((req, res, next) => {
    req.templateScope = 'general';
    next();
});

router.get('/', canViewTemplates, controller.listEmailTemplates);
router.get('/:id', canViewTemplates, controller.getEmailTemplateById);
router.post('/', canManageTemplates, controller.createEmailTemplate);
router.put('/:id', canManageTemplates, controller.updateEmailTemplate);
router.delete('/:id', canManageTemplates, controller.deleteEmailTemplate);

module.exports = router;
