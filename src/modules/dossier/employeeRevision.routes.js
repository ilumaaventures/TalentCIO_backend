const express = require('express');
const router = express.Router({ mergeParams: true });
const { protect, blockDuringImpersonation } = require('../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../common/middleware/authorize');
const {
    createRevision,
    getRevisions,
    getRevisionById,
    getEmployeeLeaveBalances,
    updateScheduledRevision,
    cancelScheduledRevision,
    backfillEmployeeRevisions
} = require('./employeeRevision.controller');

router.use(protect);

// Get current leave balances and company policies for an employee
router.get(
    '/:id/leave-balances',
    authorizeAny([
        'employee.revision.view.self',
        'employee.revision.view.others',
        'employee.revision.manage',
        'employee.revision.create',
        'employee.revision.update'
    ]),
    getEmployeeLeaveBalances
);

// Backfill baseline revisions for all employees (Admin / Revision Manage)
router.post(
    '/revisions/backfill',
    blockDuringImpersonation,
    authorizeAny(['employee.revision.create', 'employee.revision.manage']),
    backfillEmployeeRevisions
);

// List revisions for an employee
router.get(
    '/:id/revisions',
    authorizeAny([
        'employee.revision.view.self',
        'employee.revision.view.others',
        'employee.revision.manage'
    ]),
    getRevisions
);

// Create new revision
router.post(
    '/:id/revisions',
    blockDuringImpersonation,
    authorizeAny(['employee.revision.create', 'employee.revision.manage']),
    createRevision
);

// Get single revision details
router.get(
    '/:id/revisions/:revisionId',
    authorizeAny([
        'employee.revision.view.self',
        'employee.revision.view.others',
        'employee.revision.manage'
    ]),
    getRevisionById
);

// Edit scheduled revision
router.patch(
    '/:id/revisions/:revisionId',
    blockDuringImpersonation,
    authorizeAny(['employee.revision.update', 'employee.revision.manage']),
    updateScheduledRevision
);

// Cancel scheduled revision
router.delete(
    '/:id/revisions/:revisionId',
    blockDuringImpersonation,
    authorizeAny(['employee.revision.cancel', 'employee.revision.manage']),
    cancelScheduledRevision
);

module.exports = router;
