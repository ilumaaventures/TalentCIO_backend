const express = require('express');
const { requireModule } = require('../../../common/middleware/moduleGuard');
const { protect } = require('../../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../../common/middleware/authorize');
const controller = require('../controller/emailTemplate.controller');

const router = express.Router();
const emailTemplatePermissions = ['ta.email_template.manage'];

router.use(protect);
router.use(requireModule('talentAcquisition'));
router.use((req, res, next) => {
    req.templateScope = 'ta';
    next();
});

router.post('/', authorizeAny(emailTemplatePermissions), controller.createEmailTemplate);
router.get('/', authorizeAny(emailTemplatePermissions), controller.listEmailTemplates);
router.get('/:id', authorizeAny(emailTemplatePermissions), controller.getEmailTemplateById);
router.put('/:id', authorizeAny(emailTemplatePermissions), controller.updateEmailTemplate);
router.delete('/:id', authorizeAny(emailTemplatePermissions), controller.deleteEmailTemplate);

module.exports = router;
