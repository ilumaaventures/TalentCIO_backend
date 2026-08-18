const EssDocument = require('./essDocument.model');
const User = require('../user/user.model');
const NotificationService = require('../../services/notificationService');

const getCompanyId = (req) => req.companyId || req.user?.companyId || req.user?.company;

const buildPaginationOpts = (query) => {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    return { page, limit, skip: (page - 1) * limit };
};

/**
 * Checks if a given user should see this document based on visibility settings.
 * 'All' → always visible.
 * 'Department' → user's department is in targetDepartments.
 * 'Custom' → user's _id is in targetUserIds.
 */
const isDocumentVisibleToUser = (doc, user) => {
    const v = doc.visibility;
    if (!v || v.type === 'All') return true;
    if (v.type === 'Department') {
        const userDept = String(user.department || '').trim().toLowerCase();
        return (v.targetDepartments || []).some(d => d.toLowerCase() === userDept);
    }
    if (v.type === 'Custom') {
        const userId = String(user._id);
        return (v.targetUserIds || []).map(id => String(id)).includes(userId);
    }
    return false;
};

// ─── Admin: Upload / Create Document ─────────────────────────────────────────

exports.createDocument = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const io        = req.app.get('io');
        const {
            title, description, category, requiresAcknowledgement,
            visibilityType, targetDepartments, targetUserIds
        } = req.body || {};

        const rawFiles = req.filesList?.length ? req.filesList : (req.file ? [req.file] : []);
        if (rawFiles.length === 0) {
            return res.status(400).json({ message: 'Please upload at least one document file.' });
        }

        // Parse visibility
        const parsedDepts     = Array.isArray(targetDepartments) ? targetDepartments : (targetDepartments ? [targetDepartments] : []);
        const parsedUserIds   = Array.isArray(targetUserIds)     ? targetUserIds     : (targetUserIds ? [targetUserIds] : []);
        const visibility = {
            type:              visibilityType || 'All',
            targetDepartments: parsedDepts,
            targetUserIds:     parsedUserIds
        };

        const isAck = requiresAcknowledgement === true || requiresAcknowledgement === 'true';

        // Prepare documents array
        const docsToCreate = rawFiles.map((f, idx) => {
            const file = {
                url:          f.path || f.secure_url || '',
                name:         f.originalname || f.filename || '',
                publicId:     f.filename || '',
                resourceType: (f.mimetype || '').startsWith('image/') ? 'image' : 'raw',
                mimeType:     f.mimetype || '',
                size:         f.size || 0,
                uploadedAt:   new Date()
            };

            let docTitle = title?.trim();
            if (!docTitle) {
                docTitle = f.originalname ? f.originalname.replace(/\.[^/.]+$/, '') : `Document ${idx + 1}`;
            } else if (rawFiles.length > 1) {
                const cleanOriginal = f.originalname ? f.originalname.replace(/\.[^/.]+$/, '') : '';
                docTitle = cleanOriginal ? `${docTitle} - ${cleanOriginal}` : `${docTitle} (${idx + 1})`;
            }

            return {
                companyId,
                title:        docTitle,
                description:  description?.trim() || '',
                category:     category || 'Other',
                file,
                visibility,
                requiresAcknowledgement: isAck,
                uploadedBy:   req.user._id,
                isActive:     true
            };
        });

        const createdDocs = await EssDocument.insertMany(docsToCreate);

        // Notify targeted users about the new document(s)
        try {
            let recipientIds = [];
            if (visibility.type === 'All') {
                const users = await User.find({ companyId, isDeleted: { $ne: true }, isActive: true }).select('_id').lean();
                recipientIds = users.map(u => u._id);
            } else if (visibility.type === 'Custom') {
                recipientIds = parsedUserIds;
            } else if (visibility.type === 'Department') {
                const users = await User.find({
                    companyId,
                    department: { $in: parsedDepts },
                    isDeleted: { $ne: true },
                    isActive:  true
                }).select('_id').lean();
                recipientIds = users.map(u => u._id);
            }

            const notifTitle = createdDocs.length === 1
                ? `New ${category || 'Document'}: ${createdDocs[0].title}`
                : `${createdDocs.length} New ${category || 'Company'} Documents`;

            const notifMsg = createdDocs.length === 1
                ? `A new ${category?.toLowerCase() || 'document'} has been published for you.${isAck ? ' Your acknowledgement is required.' : ''}`
                : `${createdDocs.length} new ${category?.toLowerCase() || 'company'} documents have been published for you.${isAck ? ' Your acknowledgement is required.' : ''}`;

            const notifications = recipientIds
                .filter(id => String(id) !== String(req.user._id))
                .map(userId => ({
                    companyId,
                    user:    userId,
                    title:   notifTitle,
                    message: notifMsg,
                    type:    'info',
                    link:    '/ess/documents',
                    preferenceKey: 'ess_document.published',
                    origin:  req.headers?.origin || ''
                }));

            if (notifications.length > 0) {
                await NotificationService.createManyNotifications(io, notifications);
            }
        } catch (notifErr) {
            console.error('[EssDocument] Notification delivery failed:', notifErr.message);
        }

        return res.status(201).json({
            document:  createdDocs[0],
            documents: createdDocs,
            count:     createdDocs.length,
            message:   createdDocs.length === 1 ? 'Document published successfully.' : `${createdDocs.length} documents published successfully.`
        });
    } catch (err) {
        console.error('[EssDocument] createDocument error:', err);
        return res.status(500).json({ message: 'Failed to publish document.' });
    }
};

// ─── Admin: Get All Documents (with acknowledgement stats) ────────────────────

exports.getDocuments = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { page, limit, skip } = buildPaginationOpts(req.query);
        const { category, search }  = req.query;

        const filter = { companyId, isDeleted: { $ne: true } };
        if (category) filter.category = category;
        if (search)   filter.title    = { $regex: search.trim(), $options: 'i' };

        const [documents, total] = await Promise.all([
            EssDocument.find(filter)
                .populate('uploadedBy', 'firstName lastName profilePicture')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            EssDocument.countDocuments(filter)
        ]);

        // Append acknowledgement counts as a lightweight summary
        const enriched = documents.map(doc => ({
            ...doc,
            acknowledgedCount: (doc.acknowledgements || []).length
        }));

        return res.json({
            documents: enriched,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        console.error('[EssDocument] getDocuments error:', err);
        return res.status(500).json({ message: 'Failed to retrieve documents.' });
    }
};

// ─── Employee: My Visible Documents ──────────────────────────────────────────

exports.getEmployeeDocuments = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const { page, limit, skip } = buildPaginationOpts(req.query);
        const { category } = req.query;
        const userId = String(req.user._id);

        // Fetch all active docs and filter in JS by visibility
        // (small enough for most tenants; can be moved to an aggregation pipeline for large orgs)
        const baseFilter = { companyId, isActive: true, isDeleted: { $ne: true } };
        if (category) baseFilter.category = category;

        const allDocs = await EssDocument.find(baseFilter).sort({ createdAt: -1 }).lean();

        const visibleDocs = allDocs.filter(doc => isDocumentVisibleToUser(doc, req.user));

        // Paginate in memory (visibility filter makes server-side pagination complex)
        const total  = visibleDocs.length;
        const paged  = visibleDocs.slice(skip, skip + limit);

        const enriched = paged.map(doc => ({
            ...doc,
            viewerAcknowledged: (doc.acknowledgements || []).some(a => String(a.userId) === userId)
        }));

        return res.json({
            documents:  enriched,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (err) {
        console.error('[EssDocument] getEmployeeDocuments error:', err);
        return res.status(500).json({ message: 'Failed to retrieve documents.' });
    }
};

// ─── Employee: Acknowledge Document ──────────────────────────────────────────

exports.acknowledgeDocument = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const userId    = req.user._id;

        const document = await EssDocument.findOne({
            _id:       req.params.id,
            companyId,
            isActive:  true,
            isDeleted: { $ne: true }
        });

        if (!document) return res.status(404).json({ message: 'Document not found.' });

        // Verify document is visible to this user
        if (!isDocumentVisibleToUser(document, req.user)) {
            return res.status(403).json({ message: 'This document is not available to you.' });
        }

        const alreadyAcknowledged = (document.acknowledgements || [])
            .some(a => String(a.userId) === String(userId));

        if (!alreadyAcknowledged) {
            document.acknowledgements.push({ userId, acknowledgedAt: new Date() });
            await document.save();
        }

        return res.json({ message: 'Document acknowledged successfully.' });
    } catch (err) {
        console.error('[EssDocument] acknowledgeDocument error:', err);
        return res.status(500).json({ message: 'Failed to acknowledge document.' });
    }
};

// ─── Admin: Acknowledgement Status Report ────────────────────────────────────
// Directly mirrors getAnnouncementAcknowledgements from announcementInteractionController.js

exports.getDocumentAcknowledgements = async (req, res) => {
    try {
        const companyId = getCompanyId(req);

        const document = await EssDocument.findOne({
            _id:       req.params.id,
            companyId,
            isDeleted: { $ne: true }
        }).populate('acknowledgements.userId', 'firstName lastName email department employmentType profilePicture');

        if (!document) return res.status(404).json({ message: 'Document not found.' });

        const acknowledgedUserIds = new Set(
            (document.acknowledgements || []).map(a => String(a.userId?._id || a.userId))
        );

        // Determine who should have received this document
        let targetUsers = [];
        if (document.visibility?.type === 'All') {
            targetUsers = await User.find({ companyId, isDeleted: { $ne: true }, isActive: true })
                .select('firstName lastName email department employmentType profilePicture')
                .lean();
        } else if (document.visibility?.type === 'Custom') {
            targetUsers = await User.find({
                _id: { $in: document.visibility.targetUserIds },
                companyId,
                isDeleted: { $ne: true }
            }).select('firstName lastName email department employmentType profilePicture').lean();
        } else if (document.visibility?.type === 'Department') {
            targetUsers = await User.find({
                companyId,
                department: { $in: document.visibility.targetDepartments },
                isDeleted: { $ne: true }
            }).select('firstName lastName email department employmentType profilePicture').lean();
        }

        const ackMap = Object.fromEntries(
            (document.acknowledgements || []).map(a => [String(a.userId?._id || a.userId), a.acknowledgedAt])
        );

        const read = targetUsers
            .filter(u => acknowledgedUserIds.has(String(u._id)))
            .map(u => ({ user: u, acknowledgedAt: ackMap[String(u._id)] }));

        const unread = targetUsers
            .filter(u => !acknowledgedUserIds.has(String(u._id)))
            .map(u => ({ user: u }));

        return res.json({ read, unread, total: targetUsers.length });
    } catch (err) {
        console.error('[EssDocument] getDocumentAcknowledgements error:', err);
        return res.status(500).json({ message: 'Failed to retrieve acknowledgement report.' });
    }
};

// ─── Admin: Delete Document ───────────────────────────────────────────────────

exports.deleteDocument = async (req, res) => {
    try {
        const companyId = getCompanyId(req);
        const document  = await EssDocument.findOne({
            _id:       req.params.id,
            companyId,
            isDeleted: { $ne: true }
        });
        if (!document) return res.status(404).json({ message: 'Document not found.' });
        await document.softDelete(req.user._id);
        return res.json({ message: 'Document deleted successfully.' });
    } catch (err) {
        console.error('[EssDocument] deleteDocument error:', err);
        return res.status(500).json({ message: 'Failed to delete document.' });
    }
};
