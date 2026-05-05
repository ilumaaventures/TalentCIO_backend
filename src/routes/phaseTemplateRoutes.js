const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const phaseTemplateController = require('../controllers/phaseTemplateController');

const router = express.Router();

router.use(protect);
router.use(requireModule('talentAcquisition'));

router.get('/phase-templates', phaseTemplateController.getTemplates);
router.get('/phase-templates/default', phaseTemplateController.getDefaultTemplate);
router.get('/phase-templates/:id', phaseTemplateController.getTemplateById);
router.post('/phase-templates', authorize(['ta.edit']), phaseTemplateController.createTemplate);
router.put('/phase-templates/:id', authorize(['ta.edit']), phaseTemplateController.updateTemplate);
router.delete('/phase-templates/:id', authorize(['ta.edit']), phaseTemplateController.deleteTemplate);
router.patch('/phase-templates/:id/set-default', authorize(['ta.edit']), phaseTemplateController.setDefault);
router.post('/phase-templates/:id/clone', authorize(['ta.edit']), phaseTemplateController.cloneTemplate);

module.exports = router;
