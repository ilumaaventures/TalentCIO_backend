const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const controller = require('../controllers/emailTemplateController');

const router = express.Router();

router.use(protect);
router.use(requireModule('talentAcquisition'));

router.post('/', authorize(['ta.email_template.manage', 'ta.edit']), controller.createEmailTemplate);
router.get('/', controller.listEmailTemplates);
router.get('/:id', controller.getEmailTemplateById);
router.put('/:id', authorize(['ta.email_template.manage', 'ta.edit']), controller.updateEmailTemplate);
router.delete('/:id', authorize(['ta.email_template.manage', 'ta.hiring_request.manage']), controller.deleteEmailTemplate);

module.exports = router;
