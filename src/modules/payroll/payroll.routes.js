const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const payrollController = require('./payroll.controller');

router.get('/config', protect, authorize(['payroll.calculator.view', 'payroll.config.manage']), payrollController.getConfig);
router.put('/config', protect, authorize('payroll.config.manage'), payrollController.updateConfig);
router.post('/calculate-salary', protect, authorize(['payroll.calculator.view', 'payroll.salary.view', 'payroll.salary.manage']), payrollController.calculateSalary);

module.exports = router;
