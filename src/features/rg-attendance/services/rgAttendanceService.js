const AttendanceDocument = require('../../../models/AttendanceDocument');
const User = require('../../../models/User');

const isAdminLikeUser = (user = {}) => {
    const roleNames = Array.isArray(user.roles)
        ? user.roles.map((role) => (typeof role === 'string' ? role : role?.name)).filter(Boolean)
        : [];
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];

    return (
        roleNames.includes('Admin')
        || roleNames.includes('System Admin')
        || permissions.includes('*')
        || permissions.includes('admin')
        || permissions.includes('all')
    );
};

const canViewCompanyWideRGDocuments = (user = {}) => {
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];

    return (
        isAdminLikeUser(user)
        || permissions.includes('attendance.view')
        || permissions.includes('attendance.view_others')
        || permissions.includes('user.read')
    );
};

const buildVisibleUsers = async ({ companyId, requester }) => {
    const query = {
        companyId,
        isActive: true
    };

    if (!canViewCompanyWideRGDocuments(requester)) {
        query.reportingManagers = requester._id;
    }

    return User.find(query)
        .select('firstName lastName email employeeCode department')
        .lean();
};

const buildLatestUploadedAt = (files = []) => {
    const uploadedTimes = files
        .map((file) => (file?.uploadedAt ? new Date(file.uploadedAt).getTime() : null))
        .filter((value) => Number.isFinite(value));

    if (uploadedTimes.length === 0) {
        return null;
    }

    return new Date(Math.max(...uploadedTimes));
};

const buildStatusCounts = (files = []) => files.reduce((accumulator, file) => {
    const normalizedStatus = String(file?.status || 'Pending').trim();

    if (normalizedStatus === 'Approved') accumulator.approved += 1;
    else if (normalizedStatus === 'Rejected') accumulator.rejected += 1;
    else if (normalizedStatus === 'Submitted') accumulator.submitted += 1;
    else accumulator.pending += 1;

    return accumulator;
}, {
    pending: 0,
    submitted: 0,
    approved: 0,
    rejected: 0
});

const getRGDocumentSummary = async ({ companyId, month, requester }) => {
    const visibleUsers = await buildVisibleUsers({ companyId, requester });
    const visibleUserIds = visibleUsers.map((user) => user._id);

    if (visibleUserIds.length === 0) {
        return {
            records: [],
            missingRecords: []
        };
    }

    const query = {
        companyId,
        month,
        user: { $in: visibleUserIds }
    };

    const documents = await AttendanceDocument.find(query)
        .populate('user', 'firstName lastName email employeeCode department')
        .lean();

    const records = documents
        .filter((document) => document?.user && Array.isArray(document.files) && document.files.length > 0)
        .map((document) => {
            const files = Array.isArray(document.files) ? document.files : [];
            const statusCounts = buildStatusCounts(files);
            const latestUploadedAt = buildLatestUploadedAt(files);

            return {
                userId: document.user._id,
                firstName: document.user.firstName || '',
                lastName: document.user.lastName || '',
                email: document.user.email || '',
                employeeCode: document.user.employeeCode || '',
                department: document.user.department || '',
                month: document.month,
                fileCount: files.length,
                latestUploadedAt,
                statusCounts
            };
        })
        .sort((left, right) => {
            const leftTime = left.latestUploadedAt ? new Date(left.latestUploadedAt).getTime() : 0;
            const rightTime = right.latestUploadedAt ? new Date(right.latestUploadedAt).getTime() : 0;

            return rightTime - leftTime;
        });

    const uploadedUserIds = new Set(records.map((record) => String(record.userId)));
    const missingRecords = visibleUsers
        .filter((user) => !uploadedUserIds.has(String(user._id)))
        .map((user) => ({
            userId: user._id,
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            email: user.email || '',
            employeeCode: user.employeeCode || '',
            department: user.department || '',
            month,
            fileCount: 0,
            latestUploadedAt: null,
            statusCounts: {
                pending: 0,
                submitted: 0,
                approved: 0,
                rejected: 0
            }
        }))
        .sort((left, right) => {
            const leftName = `${left.firstName} ${left.lastName}`.trim().toLowerCase();
            const rightName = `${right.firstName} ${right.lastName}`.trim().toLowerCase();

            return leftName.localeCompare(rightName);
        });

    return {
        records,
        missingRecords
    };
};

module.exports = {
    getRGDocumentSummary
};
