const EmployeeProfile = require('../employeeProfile.model');
const {
    DOCUMENT_PENDING_REVIEW_STATUS,
    normalizeDocumentWorkflowStatus,
    syncDocumentSubmissionStatus
} = require('../dossierUtils');
const {
    archiveCurrentDocumentVersion,
    reopenDocumentSubmission,
    checkIsAdmin,
    hasPermission
} = require('../utils/dossierHelpers');
const { getActiveDocuments } = require('../dossierUtils');
const { logDossierActivity } = require('./dossierHistoryController');

exports.addDocument = async (req, res) => {
    try {
        const { userId } = req.params;
        const { category, title, expiryDate, replaceDocId } = req.body;

        const fileUrl = req.file ? req.file.path : req.body.url;

        if (!fileUrl) {
            console.error('No file URL found');
            return res.status(400).json({ message: 'No file uploaded or URL provided' });
        }

        const isSelf = req.user._id.toString() === userId;
        const isAdmin = checkIsAdmin(req.user);
        const canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');

        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to upload documents for this user' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });
        if (!profile) {
            console.error('Profile not found for user:', userId);
            return res.status(404).json({ message: 'Profile not found' });
        }

        const uploadedAt = new Date();
        const nextFileName = req.file ? req.file.originalname : (fileUrl.split('/').pop() || 'document');
        let auditAction = 'UPLOAD_DOCUMENT';
        let auditDetails = {
            targetUser: userId,
            targetuser: userId,
            companyId: req.companyId,
            docTitle: title
        };

        if (replaceDocId) {
            const existingDoc = profile.documents.id(replaceDocId);
            if (!existingDoc || existingDoc.isDeleted) {
                return res.status(404).json({ message: 'Document not found for re-upload' });
            }

            if (normalizeDocumentWorkflowStatus(existingDoc.verificationStatus) !== 'Rejected') {
                return res.status(400).json({ message: 'Only rejected documents can be corrected with a new version' });
            }

            archiveCurrentDocumentVersion(existingDoc, 'Employee re-uploaded a corrected version');

            existingDoc.category = category || existingDoc.category;
            existingDoc.title = title || existingDoc.title;
            existingDoc.fileName = nextFileName;
            existingDoc.url = fileUrl;
            existingDoc.expiryDate = expiryDate || existingDoc.expiryDate;
            existingDoc.uploadDate = uploadedAt;
            existingDoc.uploadedBy = req.user._id;
            existingDoc.verificationStatus = DOCUMENT_PENDING_REVIEW_STATUS;
            existingDoc.versionNumber = (existingDoc.versionNumber || 1) + 1;
            existingDoc.verifiedBy = undefined;
            existingDoc.verifiedAt = undefined;
            existingDoc.rejectedBy = undefined;
            existingDoc.rejectedAt = undefined;
            existingDoc.rejectionReason = undefined;
            existingDoc.revokedBy = undefined;
            existingDoc.revokedAt = undefined;
            existingDoc.revocationReason = undefined;
            existingDoc.deletedBy = undefined;
            existingDoc.deletedAt = undefined;
            existingDoc.isDeleted = false;

            auditAction = 'UPLOAD_DOCUMENT_VERSION';
            auditDetails = {
                ...auditDetails,
                docId: existingDoc._id,
                versionNumber: existingDoc.versionNumber
            };
        } else {
            profile.documents.push({
                category,
                title,
                fileName: nextFileName,
                url: fileUrl,
                expiryDate,
                uploadDate: uploadedAt,
                uploadedBy: req.user._id,
                verificationStatus: DOCUMENT_PENDING_REVIEW_STATUS,
                versionNumber: 1,
                versionHistory: []
            });
        }

        syncDocumentSubmissionStatus(profile);
        reopenDocumentSubmission(profile);

        if (!isAdmin && profile.hris && (profile.hris.isDeclared || profile.hris.status !== 'Draft')) {
            profile.hris.isDeclared = false;
            profile.hris.status = 'Draft';
        }

        await profile.save();
        await logDossierActivity({
            action: auditAction,
            performedBy: req.user._id,
            companyId: req.companyId,
            details: auditDetails,
            ipAddress: req.ip
        });

        res.status(201).json({
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Upload Document Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.deleteDocument = async (req, res) => {
    try {
        const { userId, docId } = req.params;

        const isSelf = req.user._id.toString() === userId;
        const isAdmin = checkIsAdmin(req.user);
        const canEdit = isSelf || isAdmin || hasPermission(req.user, 'dossier.edit');

        if (!canEdit) {
            return res.status(403).json({ message: 'Not authorized to delete documents for this user' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });

        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const doc = profile.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });

        if (doc.isDeleted) {
            return res.status(400).json({ message: 'Document is already deleted' });
        }

        const currentStatus = normalizeDocumentWorkflowStatus(doc.verificationStatus);
        if (!['Rejected', DOCUMENT_PENDING_REVIEW_STATUS].includes(currentStatus)) {
            return res.status(403).json({ message: 'Delete is only allowed for pending review or rejected documents' });
        }

        const docTitle = doc.title;
        doc.isDeleted = true;
        doc.deletedBy = req.user._id;
        doc.deletedAt = new Date();

        syncDocumentSubmissionStatus(profile);
        reopenDocumentSubmission(profile);

        if (!isAdmin && profile.hris && (profile.hris.isDeclared || profile.hris.status !== 'Draft')) {
            profile.hris.isDeclared = false;
            profile.hris.status = 'Draft';
        }
        await profile.save();

        await logDossierActivity({
            action: 'DELETE_DOCUMENT',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId,
                docTitle: docTitle,
                versionNumber: doc.versionNumber
            },
            ipAddress: req.ip
        });

        res.status(200).json({
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Delete Document Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.verifyDocument = async (req, res) => {
    try {
        const { userId, docId } = req.params;
        const { status, reason } = req.body;

        if (!['Verified', 'Rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Must be Verified or Rejected.' });
        }

        const isAdmin = checkIsAdmin(req.user);
        const canApprove = isAdmin || hasPermission(req.user, 'dossier.verify_documents') || hasPermission(req.user, 'dossier.approve');

        if (!canApprove) {
            return res.status(403).json({ message: 'Not authorized to verify documents' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const doc = profile.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });
        if (doc.isDeleted) return res.status(400).json({ message: 'Deleted documents cannot be reviewed' });

        const currentStatus = normalizeDocumentWorkflowStatus(doc.verificationStatus);
        if (currentStatus !== DOCUMENT_PENDING_REVIEW_STATUS) {
            return res.status(400).json({ message: 'Only documents in pending review can be approved or rejected' });
        }

        if (status === 'Rejected' && !String(reason || '').trim()) {
            return res.status(400).json({ message: 'Rejection reason is required' });
        }

        doc.verificationStatus = status;
        if (status === 'Verified') {
            doc.verifiedBy = req.user._id;
            doc.verifiedAt = new Date();
            doc.rejectedBy = undefined;
            doc.rejectedAt = undefined;
            doc.rejectionReason = undefined;
        } else {
            doc.rejectedBy = req.user._id;
            doc.rejectedAt = new Date();
            doc.rejectionReason = String(reason || '').trim();
        }

        syncDocumentSubmissionStatus(profile);

        await profile.save();

        await logDossierActivity({
            action: status === 'Verified' ? 'VERIFY_DOCUMENT' : 'REJECT_DOCUMENT',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId,
                docTitle: doc.title,
                status,
                reason: status === 'Rejected' ? String(reason || '').trim() : undefined,
                versionNumber: doc.versionNumber,
                newSubmissionStatus: profile.documentSubmissionStatus
            },
            ipAddress: req.ip
        });

        res.status(200).json({
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Verify Document Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.revokeDocumentVerification = async (req, res) => {
    try {
        const { userId, docId } = req.params;
        const { reason } = req.body;

        if (!String(reason || '').trim()) {
            return res.status(400).json({ message: 'Revocation reason is required' });
        }

        const isAdmin = checkIsAdmin(req.user);
        const canApprove = isAdmin || hasPermission(req.user, 'dossier.verify_documents') || hasPermission(req.user, 'dossier.approve');

        if (!canApprove) {
            return res.status(403).json({ message: 'Not authorized to revoke document verification' });
        }

        const profile = await EmployeeProfile.findOne({ user: userId, companyId: req.companyId });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const doc = profile.documents.id(docId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });
        if (doc.isDeleted) return res.status(400).json({ message: 'Deleted documents cannot be revoked' });

        if (normalizeDocumentWorkflowStatus(doc.verificationStatus) !== 'Verified') {
            return res.status(400).json({ message: 'Only verified documents can be revoked' });
        }

        doc.verificationStatus = DOCUMENT_PENDING_REVIEW_STATUS;
        doc.revokedBy = req.user._id;
        doc.revokedAt = new Date();
        doc.revocationReason = String(reason || '').trim();

        syncDocumentSubmissionStatus(profile);

        await profile.save();

        await logDossierActivity({
            action: 'REVOKE_DOCUMENT_VERIFICATION',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId,
                docTitle: doc.title,
                reason: doc.revocationReason,
                versionNumber: doc.versionNumber,
                newSubmissionStatus: profile.documentSubmissionStatus
            },
            ipAddress: req.ip
        });

        res.status(200).json({
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });
    } catch (error) {
        console.error('Revoke Document Verification Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.verifyAllDocuments = async (req, res) => {
    try {
        const { userId } = req.params;
        const { status } = req.body;

        if (status !== 'Verified') {
            return res.status(400).json({ message: 'Bulk review only supports verification.' });
        }

        const isAdmin = checkIsAdmin(req.user);
        const canApprove = isAdmin || hasPermission(req.user, 'dossier.verify_documents') || hasPermission(req.user, 'dossier.approve');

        if (!canApprove) {
            return res.status(403).json({ message: 'Not authorized to verify documents' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        let updatedCount = 0;
        profile.documents.forEach(doc => {
            if (!isActiveDocument(doc)) return;
            if (normalizeDocumentWorkflowStatus(doc.verificationStatus) === DOCUMENT_PENDING_REVIEW_STATUS) {
                doc.verificationStatus = status;
                doc.verifiedBy = req.user._id;
                doc.verifiedAt = new Date();
                doc.rejectedBy = undefined;
                doc.rejectedAt = undefined;
                doc.rejectionReason = undefined;
                updatedCount++;
            }
        });

        if (updatedCount > 0) {
            syncDocumentSubmissionStatus(profile);

            await profile.save();

            await logDossierActivity({
                action: 'VERIFY_ALL_DOCUMENTS',
                performedBy: req.user._id,
                companyId: req.companyId,
                details: {
                    targetUser: userId,
                    targetuser: userId,
                    companyId: req.companyId,
                    status,
                    count: updatedCount,
                    newSubmissionStatus: profile.documentSubmissionStatus
                },
                ipAddress: req.ip
            });
        }

        res.status(200).json({
            message: `Updated ${updatedCount} documents`,
            documents: getActiveDocuments(profile),
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Verify All Documents Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.submitDocuments = async (req, res) => {
    try {
        const { userId } = req.params;
        const viewerId = req.user._id.toString();
        const isSelf = userId === viewerId;

        if (!isSelf) {
            return res.status(403).json({ message: 'Can only submit your own documents.' });
        }

        const profile = await EmployeeProfile.findOne({
            user: userId,
            companyId: req.companyId
        });
        if (!profile) return res.status(404).json({ message: 'Profile not found' });

        const activeDocuments = getActiveDocuments(profile);
        if (!activeDocuments.length) {
            return res.status(400).json({ message: 'No documents to submit.' });
        }

        profile.documentSubmissionStatus = 'Submitted';
        activeDocuments.forEach((doc) => {
            doc.verificationStatus = normalizeDocumentWorkflowStatus(doc.verificationStatus);
        });

        await profile.save();

        await logDossierActivity({
            action: 'SUBMIT_DOCUMENTS',
            performedBy: req.user._id,
            companyId: req.companyId,
            details: {
                targetUser: userId,
                targetuser: userId,
                companyId: req.companyId
            },
            ipAddress: req.ip
        });

        res.status(200).json({
            message: 'Documents submitted successfully',
            submissionStatus: profile.documentSubmissionStatus
        });

    } catch (error) {
        console.error('Submit Documents Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};
