const express = require('express');
const router = express.Router();
const { protect } = require('../../common/middleware/authMiddleware');
const {
    getIndependenceDayStatus,
    acknowledgeCelebration
} = require('./celebration.controller');

// All celebration routes require authentication
router.use(protect);

router.get('/independence-day-status', getIndependenceDayStatus);
router.post('/acknowledge', acknowledgeCelebration);

module.exports = router;
