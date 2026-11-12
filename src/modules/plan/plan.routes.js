const express = require('express');
const router = express.Router();
const { protectSuperAdmin, requirePermission } = require('../../common/middleware/superAdminAuth');
const { getPlans, createPlan, updatePlan, deletePlan } = require('./plan.controller');

router.use(protectSuperAdmin);
router.get('/', getPlans);
router.post('/', requirePermission('managePlans'), createPlan);
router.put('/:id', requirePermission('managePlans'), updatePlan);
router.delete('/:id', requirePermission('managePlans'), deletePlan);

module.exports = router;
