const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');
const { getDashboardStats } = require('./dashboard.controller');

router.get('/', protect, authorize('dashboard.view'), getDashboardStats);

module.exports = router;
