const express = require('express');
const router = express.Router();
const notificationController = require('./notification.controller');
const { getNotificationBootstrap } = require('../system/pageBootstrap.controller');
const { protect } = require('../../common/middleware/authMiddleware');

router.use(protect);

router.get('/bootstrap', getNotificationBootstrap);
router.get('/', notificationController.getMyNotifications);
router.patch('/:id/read', notificationController.markAsRead);
router.post('/read-all', notificationController.markAllAsRead);

module.exports = router;
