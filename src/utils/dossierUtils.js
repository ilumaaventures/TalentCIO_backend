const DOCUMENT_PENDING_REVIEW_STATUS = 'Pending Review';

const normalizeDocumentWorkflowStatus = (status = '') => (
    status === 'Pending' || !status ? DOCUMENT_PENDING_REVIEW_STATUS : status
);

const isActiveDocument = (doc = {}) => !doc?.isDeleted;

const getActiveDocuments = (profile = {}) => (
    Array.isArray(profile?.documents) ? profile.documents.filter(isActiveDocument) : []
);

const syncDocumentSubmissionStatus = (profile) => {
    const activeDocuments = getActiveDocuments(profile);

    if (activeDocuments.length === 0) {
        profile.documentSubmissionStatus = 'Draft';
        return;
    }

    const statuses = activeDocuments.map((doc) => normalizeDocumentWorkflowStatus(doc.verificationStatus));
    const allVerified = statuses.every((status) => status === 'Verified');
    const anyRejected = statuses.some((status) => status === 'Rejected');

    if (allVerified) {
        profile.documentSubmissionStatus = 'Approved';
        return;
    }

    if (anyRejected) {
        profile.documentSubmissionStatus = 'Changes Requested';
        return;
    }

    profile.documentSubmissionStatus = 'Submitted';
};

module.exports = {
    DOCUMENT_PENDING_REVIEW_STATUS,
    normalizeDocumentWorkflowStatus,
    isActiveDocument,
    getActiveDocuments,
    syncDocumentSubmissionStatus
};
