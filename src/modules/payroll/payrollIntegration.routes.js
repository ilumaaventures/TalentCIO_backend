const express = require('express');
const router = express.Router();
const { protectPayrollIntegration } = require('../../common/middleware/payrollIntegrationAuth');
const {
    getEmployees,
    getAttendanceSummary,
    getPayrollConfig,
    receivePayrollResult,
} = require('./payrollIntegration.controller');

router.use(protectPayrollIntegration);

router.get('/employees',       getEmployees);
router.get('/attendance',      getAttendanceSummary);
router.get('/payroll-config',  getPayrollConfig);
router.post('/payroll-result', receivePayrollResult);

module.exports = router;
