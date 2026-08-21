const mongoose = require('mongoose');
const Reimbursement = require('./reimbursement.model');
const ReimbursementCategory = require('./reimbursementCategory.model');
const ApprovalWorkflow = require('../workflow/approvalWorkflow.model');
const NotificationService = require('../../services/notificationService');
const User = require('../user/user.model');

const DEFAULT_CATEGORIES = [
    { name: 'Travel', description: 'Flights, trains, taxis and other travel expenses', sortOrder: 1 },
    { name: 'Food & Meals', description: 'Team meals, client entertainment, business meals', sortOrder: 2 },
    { name: 'Accommodation', description: 'Hotel, guesthouse, lodging during business trips', sortOrder: 3 },
    { name: 'Internet & Phone', description: 'Mobile bill, internet reimbursement', sortOrder: 4 },
    { name: 'Medical', description: 'Medical treatment, medicines, health-related expenses', sortOrder: 5 },
    { name: 'Fuel & Conveyance', description: 'Fuel for personal vehicle used for official work', sortOrder: 6 },
    { name: 'Office Supplies', description: 'Stationery, equipment purchased for company use', sortOrder: 7 },
    { name: 'Other', description: 'Any other business expense', sortOrder: 8 }
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getCompanyId = (req) => req.companyId || req.user?.companyId || req.user?.company;

const buildPaginationOpts = (query) => {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    return { page, limit, skip: (page - 1) * limit };
};

/**
 * Derive a human-readable interim status label from the current workflow level.
 * Level 1 approved → 'L1 Approved', level 2 approved → 'L2 Approved', etc.
 * If it's the final level → 'Approved'.
 */
const deriveStatusAfterApproval = (workflow, currentLevel) => {
    const levels = workflow?.levels || [];
    const level  = levels.find(l => Number(l.levelCheck) === Number(currentLevel));
    if (!level) return 'Approved';
    if (level.isFinal) return 'Approved';
    // Not final — label with level number
    if (currentLevel === 1) return 'L1 Approved';
    if (currentLevel === 2) return 'L2 Approved';
    return `L${currentLevel} Approved`;
};

/** Checks if the acting user is a valid approver for the given level in the workflow. */
const isValidApproverForLevel = (workflow, level, userId) => {
    const levels = workflow?.levels || [];
    const lvl    = levels.find(l => Number(l.levelCheck) === Number(level));
    if (!lvl) return false;
    const approverIds = (lvl.approvers || []).map(id => String(id));
    return approverIds.includes(String(userId));
};

/**
 * Sends a notification to a list of User IDs.
 * Silently swallows errors so approval logic is never blocked by a failed notification.
 */
const notifyUsers = async (io, userIds, payload) => {
    try {
        const notifications = userIds
            .filter(Boolean)
            .map(userId => ({ ...payload, user: userId }));
        if (notifications.length > 0) {
            await NotificationService.createManyNotifications(io, notifications);
        }
    } catch (err) {
        console.error('[Reimbursement] Notification delivery failed:', err.message);
    }
};

// ─── Categories ───────────────────────────────────────────────────────────────

exports.getCategories = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        let categories = await ReimbursementCategory
            .find({ companyId, isDeleted: { $ne: true } })
            .sort({ sortOrder: 1, name: 1 })
            .lean();

        // Auto-seed defaults if no categories configured yet
        if (categories.length === 0) {
            const docs = DEFAULT_CATEGORIES.map(c => ({ ...c, companyId }));
            categories = await ReimbursementCategory.insertMany(docs);
        }

        return res.json({ categories });
    } catch (err) {
        console.error('[Reimbursement] getCategories error:', err);
        return res.status(500).json({ message: 'Failed to retrieve expense categories.' });
    }
};

exports.createCategory = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { name, description, maxAmountPerClaim, sortOrder } = req.body || {};
        if (!name?.trim()) return res.status(400).json({ message: 'Category name is required.' });

        const existing = await ReimbursementCategory.findOne({ companyId, name: name.trim(), isDeleted: { $ne: true } });
        if (existing) return res.status(409).json({ message: `Category "${name.trim()}" already exists.` });

        const category = await ReimbursementCategory.create({
            companyId, name: name.trim(), description, maxAmountPerClaim, sortOrder
        });
        return res.status(201).json({ category, message: 'Category created successfully.' });
    } catch (err) {
        console.error('[Reimbursement] createCategory error:', err);
        return res.status(500).json({ message: 'Failed to create category.' });
    }
};

exports.updateCategory = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const category  = await ReimbursementCategory.findOneAndUpdate(
            { _id: req.params.id, companyId, isDeleted: { $ne: true } },
            { $set: req.body },
            { new: true }
        );
        if (!category) return res.status(404).json({ message: 'Category not found.' });
        return res.json({ category, message: 'Category updated.' });
    } catch (err) {
        console.error('[Reimbursement] updateCategory error:', err);
        return res.status(500).json({ message: 'Failed to update category.' });
    }
};

exports.deleteCategory = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const category  = await ReimbursementCategory.findOne({ _id: req.params.id, companyId, isDeleted: { $ne: true } });
        if (!category) return res.status(404).json({ message: 'Category not found.' });
        await category.softDelete(req.user._id);
        return res.json({ message: 'Category deleted.' });
    } catch (err) {
        console.error('[Reimbursement] deleteCategory error:', err);
        return res.status(500).json({ message: 'Failed to delete category.' });
    }
};

// ─── Employee: Submit Claim ───────────────────────────────────────────────────

exports.submitClaim = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const io        = req.app.get('io');

        const { category, amount, expenseDate, description, currency, employeeSignature, declarationAccepted, department, employeeCode } = req.body || {};

        let parsedItems = [];
        if (req.body.items) {
            try {
                parsedItems = typeof req.body.items === 'string' ? JSON.parse(req.body.items) : req.body.items;
            } catch (e) {
                parsedItems = [];
            }
        }

        // Calculate total amount if itemized or direct
        const calculatedAmount = parsedItems.length > 0
            ? parsedItems.reduce((acc, it) => acc + (Number(it.amount) || 0), 0)
            : Number(amount);

        const primaryCategory = category?.trim() || parsedItems[0]?.category?.trim() || 'Other';
        const primaryDate = expenseDate ? new Date(expenseDate) : (parsedItems[0]?.expenseDate ? new Date(parsedItems[0].expenseDate) : new Date());
        const primaryDesc = description?.trim() || (parsedItems.length > 0 ? parsedItems.map(i => i.description).filter(Boolean).join('; ') : '');

        // Validate required fields
        if (!primaryCategory) return res.status(400).json({ message: 'Expense category is required.' });
        if (!calculatedAmount || isNaN(calculatedAmount) || calculatedAmount <= 0)
            return res.status(400).json({ message: 'A valid positive amount is required.' });
        if (!primaryDate) return res.status(400).json({ message: 'Expense date is required.' });
        if (!primaryDesc) return res.status(400).json({ message: 'Description is required.' });

        // Validate category exists for this company
        const validCategory = await ReimbursementCategory.findOne({
            companyId, name: primaryCategory, isDeleted: { $ne: true }
        });

        // Validate max amount if set
        if (validCategory?.maxAmountPerClaim && calculatedAmount > validCategory.maxAmountPerClaim) {
            return res.status(400).json({ message: `Amount exceeds maximum allowed (₹${validCategory.maxAmountPerClaim}) for category "${primaryCategory}".` });
        }

        // Build receipts array from multer-processed files (mirror announcement attachment pattern)
        const receipts = (req.files || []).map(file => ({
            url:          file.path || file.secure_url || '',
            name:         file.originalname || file.filename || '',
            publicId:     file.filename || '',
            resourceType: (file.mimetype || '').startsWith('image/') ? 'image' : 'raw',
            mimeType:     file.mimetype || '',
            size:         file.size || 0,
            uploadedAt:   new Date()
        }));

        if (receipts.length === 0) {
            return res.status(400).json({ message: 'Receipt attachment is mandatory. Please upload at least one receipt or invoice.' });
        }

        // Look up active approval workflow for Reimbursement
        const workflow = await ApprovalWorkflow.findOne({
            companyId,
            module:   'Reimbursement',
            isActive: true,
            isDeleted: { $ne: true }
        }).lean();

        const otherCategoryName = (req.body?.otherCategoryName || parsedItems[0]?.otherCategoryName || '').trim();

        const claim = await Reimbursement.create({
            employee:            req.user._id,
            companyId,
            department:          department || req.user.department || '',
            employeeCode:        employeeCode || req.user.employeeCode || req.user.employeeId || '',
            category:            primaryCategory,
            otherCategoryName,
            amount:              calculatedAmount,
            currency:            currency || 'INR',
            expenseDate:         primaryDate,
            description:         primaryDesc,
            items:               parsedItems.map(it => ({
                expenseDate:       new Date(it.expenseDate || primaryDate),
                description:       it.description?.trim() || '',
                category:          it.category?.trim() || primaryCategory,
                otherCategoryName: it.otherCategoryName?.trim() || '',
                amount:            Number(it.amount) || 0,
                hasReceipt:        Boolean(it.hasReceipt || receipts.length > 0)
            })),
            receipts,
            approvalWorkflow:    workflow?._id || null,
            currentLevel:        1,
            status:              'Pending',
            auditLog: [{
                action:  'Submitted',
                by:      req.user._id,
                at:      new Date(),
                comment: 'Claim submitted for approval.'
            }]
        });

        // Notify level 1 approvers if a workflow is configured
        if (workflow?.levels?.length) {
            const lvl1 = workflow.levels.find(l => Number(l.levelCheck) === 1);
            const approverIds = (lvl1?.approvers || []).map(id => id);
            await notifyUsers(io, approverIds, {
                companyId,
                title:    'New Reimbursement Claim',
                message:  `${req.user.firstName} ${req.user.lastName} submitted a ₹${Number(amount).toLocaleString('en-IN')} reimbursement claim for ${category}.`,
                type:     'info',
                link:     '/ess/reimbursements/approvals',
                preferenceKey: 'reimbursement.new_claim',
                origin:   req.headers?.origin || ''
            });
        }

        return res.status(201).json({
            claim,
            message: 'Reimbursement claim submitted successfully.'
        });
    } catch (err) {
        console.error('[Reimbursement] submitClaim error:', err);
        return res.status(500).json({ message: 'Failed to submit reimbursement claim.' });
    }
};

// ─── Employee: My Claims ──────────────────────────────────────────────────────

exports.getMyClaims = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { page, limit, skip } = buildPaginationOpts(req.query);
        const { status, category, from, to } = req.query;

        const filter = {
            companyId,
            employee:  req.user._id,
            isDeleted: { $ne: true }
        };
        if (status)   filter.status   = status;
        if (category) filter.category = category;
        if (from || to) {
            filter.expenseDate = {};
            if (from) filter.expenseDate.$gte = new Date(from);
            if (to)   filter.expenseDate.$lte = new Date(to);
        }

        const [claims, total] = await Promise.all([
            Reimbursement.find(filter)
                .populate('approvalWorkflow', 'name levels')
                .populate('approvalTrail.approver', 'firstName lastName profilePicture')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Reimbursement.countDocuments(filter)
        ]);

        return res.json({
            claims,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        console.error('[Reimbursement] getMyClaims error:', err);
        return res.status(500).json({ message: 'Failed to retrieve your claims.' });
    }
};

// ─── Get Claim by ID ─────────────────────────────────────────────────────────

exports.getClaimById = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const claim = await Reimbursement.findOne({
            _id: req.params.id,
            companyId,
            isDeleted: { $ne: true }
        })
            .populate('employee', 'firstName lastName email department designation profilePicture employeeCode')
            .populate('approvalWorkflow', 'name levels')
            .populate('approvalTrail.approver', 'firstName lastName profilePicture')
            .populate('auditLog.by', 'firstName lastName')
            .lean();

        if (!claim) return res.status(404).json({ message: 'Claim not found.' });

        // Only the employee or an approver may view the detail
        const userId = String(req.user._id);
        const isOwner = String(claim.employee._id || claim.employee) === userId;
        const isAdmin = (req.user.roles || []).some(r => ['Admin', 'System Admin', 'HR Admin'].includes(typeof r === 'string' ? r : r?.name));
        if (!isOwner && !isAdmin) {
            // Allow approvers in workflow
            const approverIds = (claim.approvalWorkflow?.levels || [])
                .flatMap(l => l.approvers || [])
                .map(id => String(id));
            if (!approverIds.includes(userId))
                return res.status(403).json({ message: 'Access denied.' });
        }

        return res.json({ claim });
    } catch (err) {
        console.error('[Reimbursement] getClaimById error:', err);
        return res.status(500).json({ message: 'Failed to retrieve claim.' });
    }
};

// ─── Employee: Cancel Pending Claim ──────────────────────────────────────────

exports.cancelClaim = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const claim = await Reimbursement.findOne({
            _id: req.params.id,
            companyId,
            employee:  req.user._id,
            isDeleted: { $ne: true }
        });
        if (!claim) return res.status(404).json({ message: 'Claim not found.' });
        if (claim.status !== 'Pending') {
            return res.status(400).json({ message: `Cannot cancel a claim with status "${claim.status}".` });
        }

        claim.status = 'Cancelled';
        claim.auditLog.push({ action: 'Cancelled', by: req.user._id, at: new Date() });
        await claim.save();

        return res.json({ claim, message: 'Claim cancelled successfully.' });
    } catch (err) {
        console.error('[Reimbursement] cancelClaim error:', err);
        return res.status(500).json({ message: 'Failed to cancel claim.' });
    }
};

// ─── Admin / Approver: All Claims (Company Scope) ────────────────────────────

exports.getAllClaims = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { page, limit, skip } = buildPaginationOpts(req.query);
        const { status, category, employeeId, from, to } = req.query;

        const filter = {
            companyId,
            isDeleted: { $ne: true }
        };

        if (status)   filter.status   = status;
        if (category) filter.category = category;
        if (employeeId) filter.employee = employeeId;
        if (from || to) {
            filter.expenseDate = {};
            if (from) filter.expenseDate.$gte = new Date(from);
            if (to)   filter.expenseDate.$lte = new Date(to);
        }

        const [claims, total] = await Promise.all([
            Reimbursement.find(filter)
                .populate('employee', 'firstName lastName email department designation profilePicture employeeCode')
                .populate('approvalWorkflow', 'name levels')
                .populate('approvalTrail.approver', 'firstName lastName profilePicture')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Reimbursement.countDocuments(filter)
        ]);

        return res.json({
            claims,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        console.error('[Reimbursement] getAllClaims error:', err);
        return res.status(500).json({ message: 'Failed to retrieve all claims.' });
    }
};

// ─── Approver: Pending Queue ──────────────────────────────────────────────────

exports.getPendingApprovals = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { page, limit, skip } = buildPaginationOpts(req.query);
        const userId = req.user._id;

        const isAdmin = (req.user.roles || []).some(r =>
            ['Admin', 'System Admin', 'HR Admin'].includes(typeof r === 'string' ? r : r?.name)
        ) || (req.user.permissions || []).includes('reimbursement.manage') || (req.user.permissions || []).includes('*');

        let filter = {
            companyId,
            isDeleted: { $ne: true },
            status: { $in: ['Pending', 'L1 Approved', 'L2 Approved'] }
        };

        if (!isAdmin) {
            // Find active workflows where this user is an approver at any level
            const workflows = await ApprovalWorkflow.find({
                companyId,
                module:   'Reimbursement',
                isActive: true,
                isDeleted: { $ne: true },
                'levels.approvers': userId
            }).lean();

            // Collect all level numbers at which this user appears, per workflow
            const approverLevelMap = {};
            workflows.forEach(wf => {
                wf.levels.forEach(lvl => {
                    if ((lvl.approvers || []).some(id => String(id) === String(userId))) {
                        if (!approverLevelMap[String(wf._id)]) approverLevelMap[String(wf._id)] = new Set();
                        approverLevelMap[String(wf._id)].add(Number(lvl.levelCheck));
                    }
                });
            });

            const workflowIds = Object.keys(approverLevelMap);
            const levelConditions = workflowIds.flatMap(wfId =>
                [...approverLevelMap[wfId]].map(level => ({
                    approvalWorkflow: wfId,
                    currentLevel:     level
                }))
            );

            if (levelConditions.length === 0) {
                return res.json({ claims: [], isApprover: false, pagination: { page, limit, total: 0, pages: 0 } });
            }

            filter.$or = levelConditions;
        }

        const [claims, total] = await Promise.all([
            Reimbursement.find(filter)
                .populate('employee', 'firstName lastName email department designation profilePicture employeeCode')
                .populate('approvalWorkflow', 'name levels')
                .populate('approvalTrail.approver', 'firstName lastName profilePicture')
                .sort({ createdAt: 1 }) // oldest first for approvers
                .skip(skip)
                .limit(limit)
                .lean(),
            Reimbursement.countDocuments(filter)
        ]);

        return res.json({
            claims,
            isApprover: true,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        console.error('[Reimbursement] getPendingApprovals error:', err);
        return res.status(500).json({ message: 'Failed to retrieve pending approvals.' });
    }
};

// ─── Approver: Approve / Reject Claim ────────────────────────────────────────

exports.actionClaim = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const io        = req.app.get('io');
        const { action, comment } = req.body || {};

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ message: "Action must be 'approve' or 'reject'." });
        }

        let claim = await Reimbursement.findOne({
            _id: req.params.id,
            companyId,
            isDeleted: { $ne: true }
        }).populate('approvalWorkflow');

        if (!claim) return res.status(404).json({ message: 'Claim not found.' });
        if (!['Pending', 'L1 Approved', 'L2 Approved'].includes(claim.status)) {
            return res.status(400).json({ message: `Claim cannot be actioned in status "${claim.status}".` });
        }

        const isOwner = String(claim.employee) === String(req.user._id);
        if (isOwner && !isAdmin) {
            return res.status(403).json({ message: 'You cannot approve or reject your own reimbursement claim.' });
        }

        const isAdmin = (req.user.roles || []).some(r =>
            ['Admin', 'System Admin', 'HR Admin'].includes(typeof r === 'string' ? r : r?.name)
        ) || (req.user.permissions || []).includes('reimbursement.manage') || (req.user.permissions || []).includes('*');

        // Check if user is an approver in the workflow level
        const isApprover = isValidApproverForLevel(claim.approvalWorkflow, claim.currentLevel, req.user._id);

        if (!isAdmin && !isApprover) {
            return res.status(403).json({ message: 'You are not authorised to approve this claim at its current level.' });
        }

        const workflow    = claim.approvalWorkflow;
        const allLevels   = (workflow?.levels || []).sort((a, b) => a.levelCheck - b.levelCheck);
        const currentLvl  = allLevels.find(l => Number(l.levelCheck) === Number(claim.currentLevel));

        // Record trail entry
        claim.approvalTrail.push({
            level:    claim.currentLevel || 1,
            approver: req.user._id,
            action:   action === 'approve' ? 'Approved' : 'Rejected',
            comment:  comment?.trim() || '',
            actedAt:  new Date()
        });

        if (action === 'reject') {
            claim.status = 'Rejected';
            claim.auditLog.push({ action: 'Rejected', by: req.user._id, at: new Date(), comment: comment?.trim() || '' });
        } else {
            // Find next level if workflow exists
            const nextLevel = allLevels.find(l => Number(l.levelCheck) > Number(claim.currentLevel));

            if (!workflow || !nextLevel || currentLvl?.isFinal || (isAdmin && !nextLevel)) {
                // Final level reached or no further level — claim is fully approved
                claim.status = 'Approved';
                claim.auditLog.push({ action: 'Approved', by: req.user._id, at: new Date(), comment: comment?.trim() || '' });
            } else {
                // Advance to next level
                claim.status       = deriveStatusAfterApproval(workflow, claim.currentLevel);
                claim.currentLevel = nextLevel.levelCheck;
                claim.auditLog.push({ action: `L${claim.currentLevel - 1} Approved`, by: req.user._id, at: new Date(), comment: comment?.trim() || '' });

                // Notify next level approvers
                await notifyUsers(io, nextLevel.approvers || [], {
                    companyId,
                    title:   'Reimbursement Claim Awaiting Your Approval',
                    message: `A reimbursement claim (₹${claim.amount.toLocaleString('en-IN')} — ${claim.category}) has been approved at Level ${claim.currentLevel - 1} and now requires your approval.`,
                    type:    'info',
                    link:    '/ess/reimbursements/approvals',
                    preferenceKey: 'reimbursement.new_claim',
                    origin:  req.headers?.origin || ''
                });
            }
        }

        await claim.save();

        // Notify the employee of the final outcome
        if (['Approved', 'Rejected'].includes(claim.status)) {
            await notifyUsers(io, [claim.employee], {
                companyId,
                title:   claim.status === 'Approved' ? 'Reimbursement Claim Approved 🎉' : 'Reimbursement Claim Rejected',
                message: claim.status === 'Approved'
                    ? `Your ₹${claim.amount.toLocaleString('en-IN')} reimbursement claim for ${claim.category} has been fully approved.`
                    : `Your ₹${claim.amount.toLocaleString('en-IN')} reimbursement claim for ${claim.category} was rejected. ${comment?.trim() ? `Reason: ${comment.trim()}` : ''}`,
                type:   claim.status === 'Approved' ? 'success' : 'error',
                link:   '/ess/reimbursements',
                preferenceKey: 'reimbursement.status_update',
                origin: req.headers?.origin || ''
            });
        }

        const populated = await Reimbursement.findById(claim._id)
            .populate('employee', 'firstName lastName email department profilePicture')
            .populate('approvalWorkflow', 'name levels')
            .populate('approvalTrail.approver', 'firstName lastName profilePicture')
            .lean();

        return res.json({ claim: populated, message: `Claim ${action === 'approve' ? 'approved' : 'rejected'} successfully.` });
    } catch (err) {
        console.error('[Reimbursement] actionClaim error:', err);
        return res.status(500).json({ message: 'Failed to process approval action.' });
    }
};

// ─── Finance/Admin: Mark as Reimbursed ───────────────────────────────────────

exports.markReimbursed = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const io        = req.app.get('io');
        const { paymentReference, paymentDate, paymentNote } = req.body || {};

        const claim = await Reimbursement.findOne({
            _id: req.params.id,
            companyId,
            isDeleted: { $ne: true }
        });
        if (!claim) return res.status(404).json({ message: 'Claim not found.' });
        if (claim.status !== 'Approved') {
            return res.status(400).json({ message: `Only approved claims can be marked as reimbursed. Current status: "${claim.status}".` });
        }

        claim.status           = 'Reimbursed';
        claim.paymentReference = paymentReference?.trim() || '';
        claim.paymentDate      = paymentDate ? new Date(paymentDate) : new Date();
        claim.paymentNote      = paymentNote?.trim() || '';
        claim.auditLog.push({ action: 'Reimbursed', by: req.user._id, at: new Date(), comment: paymentNote?.trim() || '' });
        await claim.save();

        await notifyUsers(io, [claim.employee], {
            companyId,
            title:   'Reimbursement Payment Processed 💸',
            message: `Your ₹${claim.amount.toLocaleString('en-IN')} reimbursement for ${claim.category} has been paid.${paymentReference ? ` Reference: ${paymentReference}` : ''}`,
            type:    'success',
            link:    '/ess/reimbursements',
            preferenceKey: 'reimbursement.status_update',
            origin:  req.headers?.origin || ''
        });

        return res.json({ claim, message: 'Claim marked as reimbursed.' });
    } catch (err) {
        console.error('[Reimbursement] markReimbursed error:', err);
        return res.status(500).json({ message: 'Failed to mark claim as reimbursed.' });
    }
};

// ─── Stats ────────────────────────────────────────────────────────────────────

exports.getReimbursementStats = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const compObjectId = new mongoose.Types.ObjectId(companyId);
        const isOwnStats = req.query.scope !== 'company';
        
        const employeeFilter = isOwnStats 
            ? { employee: new mongoose.Types.ObjectId(req.user._id) } 
            : {};

        const filter = {
            companyId: compObjectId,
            ...employeeFilter,
            isDeleted: { $ne: true }
        };

        const [
            pending,
            approved,
            reimbursed,
            rejected,
            totalAgg
        ] = await Promise.all([
            Reimbursement.countDocuments({ ...filter, status: { $in: ['Pending', 'L1 Approved', 'L2 Approved'] } }),
            Reimbursement.countDocuments({ ...filter, status: { $in: ['Approved', 'Reimbursed'] } }),
            Reimbursement.countDocuments({ ...filter, status: 'Reimbursed' }),
            Reimbursement.countDocuments({ ...filter, status: 'Rejected' }),
            Reimbursement.aggregate([
                { $match: { ...filter, status: { $nin: ['Cancelled', 'Rejected'] } } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ])
        ]);

        return res.json({
            stats: {
                pending,
                approved,
                reimbursed,
                rejected,
                totalClaimed: totalAgg[0]?.total || 0
            }
        });
    } catch (err) {
        console.error('[Reimbursement] getReimbursementStats error:', err);
        return res.status(500).json({ message: 'Failed to retrieve stats.' });
    }
};
