const ADMIN_ROLE_NAMES = new Set(['Admin', 'HR', 'Super Admin', 'System Admin']);
const { buildTABacHiringRequestConstraint, matchesTABacHiringRequest } = require('./taABAC');

const normalizeClientName = (value) => String(value || '').trim().toLowerCase();

const getAssignedClientNames = (user) => (
    [...new Set(
        (Array.isArray(user?.taAssignedClients) ? user.taAssignedClients : [])
            .map((client) => String(client || '').trim())
            .filter(Boolean)
    )]
);

const hasAssignedClientAccess = (hiringRequest, user) => {
    const assignedClientNames = getAssignedClientNames(user).map(normalizeClientName);
    if (!assignedClientNames.length) {
        return false;
    }

    return assignedClientNames.includes(normalizeClientName(hiringRequest?.client));
};

const getRoleName = (role) => {
    if (!role) return '';
    if (typeof role === 'string') return role;
    return role.name || '';
};

const getUserPermissionKeys = (user) => {
    const directPermissions = Array.isArray(user?.permissions) ? user.permissions : [];
    const rolePermissions = Array.isArray(user?.roles)
        ? user.roles.flatMap((role) => (
            Array.isArray(role?.permissions)
                ? role.permissions.map((permission) => permission?.key).filter(Boolean)
                : []
        ))
        : [];

    return [...new Set([...directPermissions, ...rolePermissions])];
};

const isHiringRequestAdmin = (user) => {
    const roleNames = Array.isArray(user?.roles) ? user.roles.map(getRoleName).filter(Boolean) : [];
    const permissions = getUserPermissionKeys(user);

    return roleNames.some((roleName) => ADMIN_ROLE_NAMES.has(roleName)) || permissions.includes('*');
};

const REQUISITION_GLOBAL_PERMISSION_MAP = {
    view: ['ta.requisition.manage.all', 'ta.view', 'ta.analytics.global'],
    create: ['ta.requisition.manage.all', 'ta.requisition.create', 'ta.create'],
    edit: ['ta.requisition.manage.all', 'ta.requisition.update', 'ta.edit'],
    delete: ['ta.requisition.manage.all', 'ta.requisition.delete', 'ta.delete'],
    manage: ['ta.hiring_request.manage', 'ta.manage']
};

const REQUISITION_ASSIGNED_PERMISSION_MAP = {
    view: ['ta.requisition.manage.assigned', 'ta.requisition.read', 'ta.analytics.assigned'],
    edit: ['ta.requisition.manage.assigned'],
    delete: ['ta.requisition.manage.assigned']
};

const normalizeRequisitionAction = (action = 'view') => {
    if (action === 'config_manage') return 'manage';
    return action || 'view';
};

const hasGlobalRequisitionPermission = (user, action = 'view') => {
    const permissions = getUserPermissionKeys(user);
    if (permissions.includes('*')) {
        return true;
    }

    const allowedPermissions = REQUISITION_GLOBAL_PERMISSION_MAP[normalizeRequisitionAction(action)] || [];
    return allowedPermissions.some((permission) => permissions.includes(permission));
};

const hasAssignedRequisitionPermission = (user, action = 'view') => {
    const permissions = getUserPermissionKeys(user);
    const allowedPermissions = REQUISITION_ASSIGNED_PERMISSION_MAP[normalizeRequisitionAction(action)] || [];
    return allowedPermissions.some((permission) => permissions.includes(permission));
};

const buildAccessibleHiringRequestQuery = async (companyId, user, options = {}) => {
    const query = { companyId };
    const action = normalizeRequisitionAction(options.action || 'view');

    if (isHiringRequestAdmin(user) || hasGlobalRequisitionPermission(user, action)) {
        const adminAbacConstraint = await buildTABacHiringRequestConstraint({
            companyId,
            user,
            action
        });

        if (!adminAbacConstraint) {
            return query;
        }

        return {
            $and: [
                query,
                adminAbacConstraint
            ]
        };
    }

    if (!hasAssignedRequisitionPermission(user, action)) {
        if (action === 'view' && user?._id) {
            const mongoose = require('mongoose');
            const Candidate = mongoose.model('Candidate');
            const interviewerRequestIds = await Candidate.find({
                companyId,
                $or: [
                    { 'interviewRounds.assignedTo': user._id },
                    { 'interviewRounds.evaluatedBy': user._id }
                ],
                isDeleted: { $ne: true }
            }).distinct('hiringRequestId');

            if (interviewerRequestIds.length > 0) {
                return {
                    $and: [
                        query,
                        { _id: { $in: interviewerRequestIds } }
                    ]
                };
            }
        }
        return {
            $and: [
                query,
                { _id: { $in: [] } }
            ]
        };
    }

    const baseAccessQuery = { companyId, $or: [] };
    if (action === 'view') {
        const mongoose = require('mongoose');
        const Candidate = mongoose.model('Candidate');
        const interviewerRequestIds = await Candidate.find({
            companyId,
            $or: [
                { 'interviewRounds.assignedTo': user._id },
                { 'interviewRounds.evaluatedBy': user._id }
            ],
            isDeleted: { $ne: true }
        }).distinct('hiringRequestId');

        baseAccessQuery.$or.push(
            { createdBy: user?._id },
            { 'ownership.hiringManager': user?._id },
            { assignedUsers: user?._id },
            { analyticsViewers: user?._id },
            { 'ownership.interviewPanel': user?._id },
            { _id: { $in: interviewerRequestIds } }
        );
    } else {
        baseAccessQuery.$or.push(
            { createdBy: user?._id },
            { 'ownership.hiringManager': user?._id },
            { assignedUsers: user?._id }
        );
    }
    const assignedClientNames = getAssignedClientNames(user);
    if (assignedClientNames.length > 0) {
        baseAccessQuery.$or.push({ client: { $in: assignedClientNames } });
    }

    const abacConstraint = await buildTABacHiringRequestConstraint({
        companyId,
        user,
        action
    });

    if (!abacConstraint) {
        return baseAccessQuery;
    }

    return {
        $and: [
            baseAccessQuery,
            abacConstraint
        ]
    };
};

const canAccessHiringRequest = async (hiringRequest, companyId, user, options = {}) => {
    if (!hiringRequest || !user?._id) {
        return false;
    }

    const action = normalizeRequisitionAction(options.action || 'view');

    if (isHiringRequestAdmin(user) || hasGlobalRequisitionPermission(user, action)) {
        return matchesTABacHiringRequest({
            companyId,
            user,
            hiringRequest,
            action
        });
    }

    let isInterviewer = false;
    if (action === 'view') {
        const mongoose = require('mongoose');
        const Candidate = mongoose.model('Candidate');
        const count = await Candidate.countDocuments({
            companyId,
            hiringRequestId: hiringRequest._id,
            $or: [
                { 'interviewRounds.assignedTo': user._id },
                { 'interviewRounds.evaluatedBy': user._id }
            ],
            isDeleted: { $ne: true }
        });
        if (count > 0) {
            isInterviewer = true;
        }
    }

    if (!hasAssignedRequisitionPermission(user, action) && !isInterviewer) {
        return false;
    }

    const userId = String(user._id);
    let hasBaseAccess = false;
    if (isInterviewer) {
        hasBaseAccess = true;
    }

    if (!hasBaseAccess && String(hiringRequest.createdBy?._id || hiringRequest.createdBy || '') === userId) {
        hasBaseAccess = true;
    }

    if (!hasBaseAccess && String(hiringRequest.ownership?.hiringManager?._id || hiringRequest.ownership?.hiringManager || '') === userId) {
        hasBaseAccess = true;
    }

    const assignedUserIds = Array.isArray(hiringRequest.assignedUsers)
        ? hiringRequest.assignedUsers.map((assignedUser) => String(assignedUser?._id || assignedUser))
        : [];
    if (!hasBaseAccess && assignedUserIds.includes(userId)) {
        hasBaseAccess = true;
    }

    if (action === 'view') {
        const analyticsViewerIds = Array.isArray(hiringRequest.analyticsViewers)
            ? hiringRequest.analyticsViewers.map((viewer) => String(viewer?._id || viewer))
            : [];
        if (!hasBaseAccess && analyticsViewerIds.includes(userId)) {
            hasBaseAccess = true;
        }

        const interviewPanelIds = Array.isArray(hiringRequest.ownership?.interviewPanel)
            ? hiringRequest.ownership.interviewPanel.map((panelUser) => String(panelUser?._id || panelUser))
            : [];
        if (!hasBaseAccess && interviewPanelIds.includes(userId)) {
            hasBaseAccess = true;
        }
    }

    if (!hasBaseAccess) {
        hasBaseAccess = hasAssignedClientAccess(hiringRequest, user);
    }

    if (!hasBaseAccess) {
        return false;
    }

    return matchesTABacHiringRequest({
        companyId,
        user,
        hiringRequest,
        action
    });
};

module.exports = {
    buildAccessibleHiringRequestQuery,
    canAccessHiringRequest,
    getAssignedClientNames,
    getUserPermissionKeys,
    hasAssignedClientAccess,
    isHiringRequestAdmin
};
