const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../../common/middleware/superAdminAuth');
const { getPlans, createPlan, updatePlan, deletePlan } = require('./plan.controller');

router.use(protectSuperAdmin);
router.get('/', getPlans);
router.post('/', createPlan);
router.put('/:id', updatePlan);
router.delete('/:id', deletePlan);

module.exports = router;
