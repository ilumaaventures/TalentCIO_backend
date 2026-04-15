const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middlewares/superAdminAuth');
const { getPlans, createPlan, updatePlan, deletePlan } = require('../controllers/planController');

router.use(protectSuperAdmin);
router.get('/', getPlans);
router.post('/', createPlan);
router.put('/:id', updatePlan);
router.delete('/:id', deletePlan);

module.exports = router;
