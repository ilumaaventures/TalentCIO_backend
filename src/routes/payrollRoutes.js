const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const payrollController = require('../controllers/payrollController');

router.get('/config', protect, payrollController.getConfig);
router.put('/config', protect, payrollController.updateConfig);
router.post('/calculate-salary', protect, payrollController.calculateSalary);

module.exports = router;
