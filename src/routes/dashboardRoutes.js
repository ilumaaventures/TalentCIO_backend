const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { getDashboardStats } = require('../controllers/dashboardController');

router.get('/', protect, getDashboardStats);

module.exports = router;
