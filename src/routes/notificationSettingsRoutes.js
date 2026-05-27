const express = require('express');
const controller = require('../controllers/notificationSettingsController');
const { protect } = require('../middlewares/authMiddleware');
const { authorize } = require('../middlewares/authorize');

const router = express.Router();

router.use(protect);

router.get('/', authorize('settings.notification.view'), controller.getNotificationSettings);
router.put('/', authorize('settings.notification.manage'), controller.updateNotificationSettings);

module.exports = router;
