const express = require('express');
const controller = require('./notificationSettings.controller');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorize } = require('../../common/middleware/authorize');

const router = express.Router();

router.use(protect);

router.get('/', authorize('settings.notification.view'), controller.getNotificationSettings);
router.put('/', authorize('settings.notification.manage'), controller.updateNotificationSettings);

module.exports = router;
