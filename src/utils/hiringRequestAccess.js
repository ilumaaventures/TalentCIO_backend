const ADMIN_ROLE_NAMES = new Set(['Admin', 'HR', 'Super Admin', 'System Admin']);

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

const buildAccessibleHiringRequestQuery = async (companyId, user) => {
    const query = { companyId };

    if (isHiringRequestAdmin(user)) {
        return query;
    }

    query.$or = [
        { createdBy: user?._id },
        { 'ownership.hiringManager': user?._id },
        { 'ownership.recruiter': user?._id },
        { assignedUsers: user?._id },
        { analyticsViewers: user?._id },
        { 'ownership.interviewPanel': user?._id }
    ];
    const assignedClientNames = getAssignedClientNames(user);
    if (assignedClientNames.length > 0) {
        query.$or.push({ client: { $in: assignedClientNames } });
    }

    return query;
};

const canAccessHiringRequest = async (hiringRequest, companyId, user) => {
    if (!hiringRequest || !user?._id) {
        return false;
    }

    if (isHiringRequestAdmin(user)) {
        return true;
    }

    const userId = String(user._id);
    if (String(hiringRequest.createdBy?._id || hiringRequest.createdBy || '') === userId) {
        return true;
    }

    if (String(hiringRequest.ownership?.hiringManager?._id || hiringRequest.ownership?.hiringManager || '') === userId) {
        return true;
    }

    if (String(hiringRequest.ownership?.recruiter?._id || hiringRequest.ownership?.recruiter || '') === userId) {
        return true;
    }

    const assignedUserIds = Array.isArray(hiringRequest.assignedUsers)
        ? hiringRequest.assignedUsers.map((assignedUser) => String(assignedUser?._id || assignedUser))
        : [];
    if (assignedUserIds.includes(userId)) {
        return true;
    }

    const analyticsViewerIds = Array.isArray(hiringRequest.analyticsViewers)
        ? hiringRequest.analyticsViewers.map((viewer) => String(viewer?._id || viewer))
        : [];
    if (analyticsViewerIds.includes(userId)) {
        return true;
    }

    const interviewPanelIds = Array.isArray(hiringRequest.ownership?.interviewPanel)
        ? hiringRequest.ownership.interviewPanel.map((panelUser) => String(panelUser?._id || panelUser))
        : [];
    if (interviewPanelIds.includes(userId)) {
        return true;
    }

    return hasAssignedClientAccess(hiringRequest, user);
};

module.exports = {
    buildAccessibleHiringRequestQuery,
    canAccessHiringRequest,
    getAssignedClientNames,
    getUserPermissionKeys,
    hasAssignedClientAccess,
    isHiringRequestAdmin
};
