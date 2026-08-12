const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../../common/middleware/superAdminAuth');
const { getGlobalAnalytics } = require('./analytics.controller');

router.use(protectSuperAdmin);
router.get('/', getGlobalAnalytics);

module.exports = router;
