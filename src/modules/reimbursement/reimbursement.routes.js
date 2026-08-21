const express = require('express');
const { protect } = require('../../common/middleware/authMiddleware');
const { authorizeRoleOrPermission } = require('../../common/middleware/authorize');
const { requireModule } = require('../../common/middleware/moduleGuard');
const { uploadAnnouncementAttachment } = require('../../config/cloudinary');
const controller = require('./reimbursement.controller');

const router = express.Router();

// ─── Role-based middleware shortcuts ─────────────────────────────────────────

/** Admin / HR / Finance roles that can manage all claims */
const manageReimbursements = authorizeRoleOrPermission({
    roles:       ['Admin', 'HR Admin', 'System Admin'],
    permissions: ['reimbursement.manage']
});

/** Finance team marks payment done */
const markAsPaid = authorizeRoleOrPermission({
    roles:       ['Admin', 'HR Admin', 'System Admin'],
    permissions: ['reimbursement.mark_paid', 'reimbursement.manage']
});

/** Receipt upload middleware (mirrors handleAnnouncementAttachmentUpload pattern) */
const handleReceiptUpload = (req, res, next) => {
    uploadAnnouncementAttachment.array('receipts', 5)(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE')
            return res.status(413).json({ message: 'Each receipt must be 5 MB or smaller.' });
        return res.status(400).json({ message: err.message || 'Invalid receipt upload.' });
    });
};

// ─── All routes require auth + module enabled ─────────────────────────────────

router.use(protect);
router.use(requireModule('reimbursements'));

// ─── Specific routes (must be placed before parameterized /:id) ───────────────

// Categories (accessible by employees to select, managed by admin)
router.get('/categories',         controller.getCategories);
router.post('/categories',        manageReimbursements, controller.createCategory);
router.put('/categories/:id',     manageReimbursements, controller.updateCategory);
router.delete('/categories/:id',  manageReimbursements, controller.deleteCategory);

// Employee claims & stats
router.get('/mine',               controller.getMyClaims);
router.get('/stats',              controller.getReimbursementStats);
router.post('/', handleReceiptUpload, controller.submitClaim);

// Approver & Company queues
router.get('/pending-approvals',  controller.getPendingApprovals);
router.get('/all',                controller.getAllClaims);

// ─── Parameterized routes (/:id) ──────────────────────────────────────────────

router.get('/:id',                controller.getClaimById);
router.patch('/:id/cancel',       controller.cancelClaim);
router.post('/:id/action',        controller.actionClaim);
router.patch('/:id/mark-reimbursed', markAsPaid, controller.markReimbursed);

module.exports = router;
