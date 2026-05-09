const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const { protect } = require('../middlewares/authMiddleware');
const { authorizeAny } = require('../middlewares/authorize');
const phaseTemplateController = require('../controllers/phaseTemplateController');

const router = express.Router();

router.use(protect);
router.use(requireModule('talentAcquisition'));

router.get('/phase-templates', phaseTemplateController.getTemplates);
router.get('/phase-templates/default', phaseTemplateController.getDefaultTemplate);
router.get('/phase-templates/:id', phaseTemplateController.getTemplateById);
router.post('/phase-templates', authorizeAny(['ta.config.manage', 'ta.edit']), phaseTemplateController.createTemplate);
router.put('/phase-templates/:id', authorizeAny(['ta.config.manage', 'ta.edit']), phaseTemplateController.updateTemplate);
router.delete('/phase-templates/:id', authorizeAny(['ta.config.manage', 'ta.edit']), phaseTemplateController.deleteTemplate);
router.patch('/phase-templates/:id/set-default', authorizeAny(['ta.config.manage', 'ta.edit']), phaseTemplateController.setDefault);
router.post('/phase-templates/:id/clone', authorizeAny(['ta.config.manage', 'ta.edit']), phaseTemplateController.cloneTemplate);

module.exports = router;
