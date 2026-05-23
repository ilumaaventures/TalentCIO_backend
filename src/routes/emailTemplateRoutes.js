const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const { protect } = require('../middlewares/authMiddleware');
const { authorizeAny } = require('../middlewares/authorize');
const controller = require('../controllers/emailTemplateController');

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
