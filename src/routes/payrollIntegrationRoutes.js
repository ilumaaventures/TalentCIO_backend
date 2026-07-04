const express = require('express');
const router = express.Router();
const { protectPayrollIntegration } = require('../middlewares/payrollIntegrationAuth');
const {
    getEmployees,
    getAttendanceSummary,
    getPayrollConfig
} = require('../controllers/payrollIntegrationController');

router.use(protectPayrollIntegration);

router.get('/employees', getEmployees);
router.get('/attendance', getAttendanceSummary);
router.get('/payroll-config', getPayrollConfig);

module.exports = router;
