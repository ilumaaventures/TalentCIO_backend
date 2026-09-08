const express = require('express');
const { protect } = require('../../../common/middleware/authMiddleware');
const { authorizeRoleOrPermission } = require('../../../common/middleware/authorize');
const { requireModule } = require('../../../common/middleware/moduleGuard');
const { getDocumentSummary } = require('../controllers/rgAttendanceController');
const { ensureRGWorkspace } = require('../utils/ensureRGWorkspace');

const router = express.Router();

router.use(protect);
router.use(requireModule('attendance'));
router.use(ensureRGWorkspace);

router.get(
    '/document-summary',
    getDocumentSummary
);

module.exports = router;
