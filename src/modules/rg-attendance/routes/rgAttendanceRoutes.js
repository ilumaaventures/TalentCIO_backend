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
    authorizeRoleOrPermission({
        roles: ['Admin', 'Manager'],
        permissions: ['attendance.view', 'attendance.view_others', 'user.read']
    }),
    getDocumentSummary
);

module.exports = router;
