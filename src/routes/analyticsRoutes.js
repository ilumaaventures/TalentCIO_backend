const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middlewares/superAdminAuth');
const { getGlobalAnalytics } = require('../controllers/analyticsController');

router.use(protectSuperAdmin);
router.get('/', getGlobalAnalytics);

module.exports = router;
