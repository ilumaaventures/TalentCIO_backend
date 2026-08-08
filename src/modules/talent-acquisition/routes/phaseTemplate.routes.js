const express = require('express');
const { requireModule } = require('../../../common/middleware/moduleGuard');
const { protect } = require('../../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../../common/middleware/authorize');
const phaseTemplateController = require('../controllers/phaseTemplateController/phaseTemplate.controller');
const configViewPermissions = [
    'ta.manage',
    'ta.config.view',
    'ta.config.edit',
    'ta.requisition.create',
    'ta.requisition.update',
    'ta.requisition.manage.assigned',
    'ta.requisition.manage.all'
];
const configEditPermissions = ['ta.manage', 'ta.config.edit'];

const router = express.Router();

router.use(protect);
router.use(requireModule('talentAcquisition'));

router.get('/phase-templates', authorizeAny(configViewPermissions), phaseTemplateController.getTemplates);
router.get('/phase-templates/default', authorizeAny(configViewPermissions), phaseTemplateController.getDefaultTemplate);
router.get('/phase-templates/:id', authorizeAny(configViewPermissions), phaseTemplateController.getTemplateById);
router.post('/phase-templates', authorizeAny(configEditPermissions), phaseTemplateController.createTemplate);
router.put('/phase-templates/:id', authorizeAny(configEditPermissions), phaseTemplateController.updateTemplate);
router.delete('/phase-templates/:id', authorizeAny(configEditPermissions), phaseTemplateController.deleteTemplate);
router.patch('/phase-templates/:id/set-default', authorizeAny(configEditPermissions), phaseTemplateController.setDefault);
router.post('/phase-templates/:id/clone', authorizeAny(configEditPermissions), phaseTemplateController.cloneTemplate);

module.exports = router;
