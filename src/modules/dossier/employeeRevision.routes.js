const express = require('express');
const router = express.Router({ mergeParams: true });
const { protect, blockDuringImpersonation } = require('../../common/middleware/authMiddleware');
const { authorizeAny } = require('../../common/middleware/authorize');
const { upload } = require('../../config/cloudinary');
const {
    createRevision,
    getRevisions,
    getRevisionById,
    getEmployeeLeaveBalances,
    updateScheduledRevision,
    cancelScheduledRevision,
    backfillEmployeeRevisions,
    getBulkEmployeeSalaryData,
    bulkCreateRevisions,
    getCompanyRevisions,
    getRevisionTemplates,
    getRevisionTemplateContent,
    uploadRevisionTemplate,
    deleteRevisionTemplate,
    downloadSampleTemplate,
    downloadRevisionTemplateFile,
    sendRevisionLetter,
    downloadRevisionLetter,
    bulkSendRevisionLetters
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

// Bulk fetch active employees with their current compensation profiles for bulk editing
router.get(
    '/revisions/bulk-profiles',
    authorizeAny(['employee.revision.manage', 'employee.revision.view.others', 'payroll.salary.manage', 'payroll.salary.view', 'employee.revision.create']),
    getBulkEmployeeSalaryData
);

// Bulk create revisions for multiple employees
router.post(
    '/revisions/bulk',
    blockDuringImpersonation,
    authorizeAny(['employee.revision.create', 'employee.revision.manage', 'payroll.salary.manage']),
    bulkCreateRevisions
);

// Get available revision letter templates
router.get(
    '/revisions/templates',
    authorizeAny(['employee.revision.manage', 'payroll.salary.manage', 'employee.revision.create', 'payroll.config.manage', 'employee.revision.view.others']),
    getRevisionTemplates
);

// Get template text content for per-employee customization
router.get(
    '/revisions/templates/:templateId/content',
    authorizeAny(['employee.revision.manage', 'payroll.salary.manage', 'employee.revision.create', 'payroll.config.manage', 'employee.revision.view.others']),
    getRevisionTemplateContent
);

// Support POST for download with customContent body
router.post(
    '/:id/revisions/:revisionId/letter/download',
    authorizeAny(['employee.revision.view.self', 'employee.revision.view.others', 'employee.revision.manage', 'payroll.salary.manage', 'payroll.salary.view']),
    downloadRevisionLetter
);

// Download default sample revision letter template (.docx)
router.get(
    '/revisions/templates/sample',
    authorizeAny(['employee.revision.manage', 'payroll.salary.manage', 'employee.revision.create', 'payroll.config.manage']),
    downloadSampleTemplate
);

// Download specific custom template (.docx)
router.get(
    '/revisions/templates/:templateId/download',
    authorizeAny(['employee.revision.manage', 'payroll.salary.manage', 'employee.revision.create', 'payroll.config.manage']),
    downloadRevisionTemplateFile
);

// Upload a new custom revision letter template (.docx)
router.post(
    '/revisions/templates/upload',
    blockDuringImpersonation,
    authorizeAny(['employee.revision.manage', 'payroll.salary.manage', 'payroll.config.manage', 'employee.revision.create']),
    upload.single('document'),
    uploadRevisionTemplate
);

// Delete custom revision letter template
router.delete(
    '/revisions/templates/:templateId',
    blockDuringImpersonation,
    authorizeAny(['employee.revision.manage', 'payroll.salary.manage', 'payroll.config.manage']),
    deleteRevisionTemplate
);

// Bulk send revision letters to multiple employees
router.post(
    '/revisions/bulk/letters',
    blockDuringImpersonation,
    authorizeAny(['employee.revision.manage', 'payroll.salary.manage', 'employee.revision.create']),
    bulkSendRevisionLetters
);

// Get company-wide revisions list
router.get(
    '/revisions/company',
    authorizeAny(['employee.revision.manage', 'employee.revision.view.others', 'payroll.salary.manage', 'payroll.salary.view']),
    getCompanyRevisions
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

// Download DOCX revision letter
router.get(
    '/:id/revisions/:revisionId/letter/download',
    authorizeAny(['employee.revision.view.self', 'employee.revision.view.others', 'employee.revision.manage', 'payroll.salary.manage', 'payroll.salary.view']),
    downloadRevisionLetter
);

// Generate & send revision letter via email and save to dossier
router.post(
    '/:id/revisions/:revisionId/letter',
    blockDuringImpersonation,
    authorizeAny(['employee.revision.manage', 'payroll.salary.manage', 'employee.revision.create']),
    sendRevisionLetter
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
