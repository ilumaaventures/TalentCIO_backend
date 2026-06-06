const express = require('express');
const router = express.Router();
const { protectPayrollIntegration } = require('../middlewares/payrollIntegrationAuth');
const {
    getEmployees,
    getAttendanceSummary
} = require('../controllers/payrollIntegrationController');

router.use(protectPayrollIntegration);

router.get('/employees', getEmployees);
router.get('/attendance', getAttendanceSummary);

module.exports = router;
