const express = require('express');
const router = express.Router();
const { protectSuperAdmin } = require('../middlewares/superAdminAuth');
const { getLogs } = require('../controllers/activityLogController');
const { listAllModules } = require('../controllers/moduleController');
const cleanupStaleIndexes = require('../services/indexCleanup');

router.use(protectSuperAdmin);
router.get('/logs', getLogs);
router.get('/modules', listAllModules);
router.post('/cleanup-indexes', async (req, res) => {
    try {
        const report = await cleanupStaleIndexes();
        res.json({ message: 'Index cleanup completed', report });
    } catch (error) {
        res.status(500).json({ message: 'Cleanup failed', error: error.message });
    }
});

module.exports = router;
