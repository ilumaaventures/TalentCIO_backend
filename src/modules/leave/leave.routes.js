const express = require('express');
const { requireModule } = require('../../common/middleware/moduleGuard');
const router = express.Router();
// Note: requireModule added after protect middleware
const { protect, admin } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { dossierGate } = require('../../common/middleware/dossierGate');
const { upload } = require('../../config/cloudinary');
const { getLeavePolicies, updateLeavePolicy, deleteLeavePolicy, seedDefaultPolicies, triggerMonthlyAccrual, triggerYearlyAccrual } = require('./leaveConfig.controller');
const { applyLeave, getMyLeaves, getMyBalances, getManagerApprovals, updateLeaveStatus, cancelLeave } = require('./leave.controller');
const { getLeavesBootstrap } = require('../system/pageBootstrap.controller');

router.use(protect);
router.use(requireModule('leaves'));
router.get('/bootstrap', getLeavesBootstrap);
// Configuration Routes
router.route('/config')
    .get(getLeavePolicies)
    .post(authorize('leave.config.manage'), updateLeavePolicy);

router.delete('/config/:id', protect, authorize('leave.config.manage'), deleteLeavePolicy);

router.post('/config/seed', protect, authorize('leave.config.manage'), seedDefaultPolicies);

// Accrual Triggers (Manual/Cron)
router.post('/accrual/monthly', protect, admin, triggerMonthlyAccrual);
router.post('/accrual/yearly', protect, admin, triggerYearlyAccrual);

// Employee Operation Routes
router.post('/apply', protect, dossierGate, upload.single('document'), applyLeave);
router.get('/requests', protect, getMyLeaves);
router.get('/balance', protect, getMyBalances);

// Manager Operation Routes
router.get('/approvals', protect, getManagerApprovals);
router.put('/approve/:id', protect, updateLeaveStatus);

// Employee Cancellation Route
router.put('/cancel/:id', protect, cancelLeave);

module.exports = router;
