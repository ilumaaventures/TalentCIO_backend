const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const { authorizeAny } = require('../middlewares/authorize');
const controller = require('../controllers/emailTemplateController');

const router = express.Router();

const canViewTemplates = authorizeAny([
    'settings.email.view',
    'settings.email.manage',
    'ta.config.manage',
    'ta.email_template.manage',
    'ta.edit'
]);

const canManageTemplates = authorizeAny([
    'settings.email.manage',
    'ta.config.manage',
    'ta.email_template.manage',
    'ta.edit'
]);

router.use(protect);

router.get('/', canViewTemplates, controller.listEmailTemplates);
router.get('/:id', canViewTemplates, controller.getEmailTemplateById);
router.post('/', canManageTemplates, controller.createEmailTemplate);
router.put('/:id', canManageTemplates, controller.updateEmailTemplate);
router.delete('/:id', canManageTemplates, controller.deleteEmailTemplate);

module.exports = router;
