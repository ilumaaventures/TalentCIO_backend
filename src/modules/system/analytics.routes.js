const express = require('express');
const router = express.Router();
const { protectSuperAdmin, requirePermission } = require('../../common/middleware/superAdminAuth');
const { getGlobalAnalytics } = require('./analytics.controller');

router.use(protectSuperAdmin);
router.get('/', requirePermission('viewAnalytics'), getGlobalAnalytics);

module.exports = router;
