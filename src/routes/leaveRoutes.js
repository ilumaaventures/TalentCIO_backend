const express = require('express');
const { requireModule } = require('../middlewares/moduleGuard');
const router = express.Router();
// Note: requireModule added after protect middleware
const { protect, admin } = require('../middlewares/authMiddleware');
const { upload } = require('../config/cloudinary');
const { getLeavePolicies, updateLeavePolicy, deleteLeavePolicy, seedDefaultPolicies, triggerMonthlyAccrual, triggerYearlyAccrual } = require('../controllers/leaveConfigController');
const { applyLeave, getMyLeaves, getMyBalances, getManagerApprovals, updateLeaveStatus, cancelLeave } = require('../controllers/leaveController');
const { getLeavesBootstrap } = require('../controllers/pageBootstrapController');

router.use(protect);
router.use(requireModule('leaves'));
router.get('/bootstrap', getLeavesBootstrap);
// Configuration Routes
router.route('/config')
    .get(getLeavePolicies)
    .post(admin, updateLeavePolicy);

router.delete('/config/:id', protect, admin, deleteLeavePolicy);

router.post('/config/seed', protect, admin, seedDefaultPolicies);

// Accrual Triggers (Manual/Cron)
router.post('/accrual/monthly', protect, admin, triggerMonthlyAccrual);
router.post('/accrual/yearly', protect, admin, triggerYearlyAccrual);

// Employee Operation Routes
router.post('/apply', protect, upload.single('document'), applyLeave);
router.get('/requests', protect, getMyLeaves);
router.get('/balance', protect, getMyBalances);

// Manager Operation Routes
router.get('/approvals', protect, getManagerApprovals);
router.put('/approve/:id', protect, updateLeaveStatus);

// Employee Cancellation Route
router.put('/cancel/:id', protect, cancelLeave);

module.exports = router;
