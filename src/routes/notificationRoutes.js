const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { getNotificationBootstrap } = require('../controllers/pageBootstrapController');
const { protect } = require('../middlewares/authMiddleware');

router.use(protect);

router.get('/bootstrap', getNotificationBootstrap);
router.get('/', notificationController.getMyNotifications);
router.patch('/:id/read', notificationController.markAsRead);
router.post('/read-all', notificationController.markAllAsRead);

module.exports = router;
