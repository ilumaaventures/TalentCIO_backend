const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');
const { getDashboardStats } = require('../controllers/dashboardController');

router.get('/', protect, authorize('dashboard.view'), getDashboardStats);

module.exports = router;
