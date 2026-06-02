const Role = require('../models/Role');

const ADMIN_ROLE_FILTER = {
    $or: [
        { name: 'Admin' },
        { name: 'System Admin' },
        { isSystem: true }
    ]
};

const normalizePermissionIds = (permissionIds = []) => (
    [...new Set(
        permissionIds
            .map((permissionId) => String(permissionId || '').trim())
            .filter(Boolean)
    )]
);

const assignPermissionsToAdminRoles = async (permissionIds = []) => {
    const normalizedPermissionIds = normalizePermissionIds(permissionIds);

    if (normalizedPermissionIds.length === 0) {
        return { matchedCount: 0, modifiedCount: 0 };
    }

    return Role.updateMany(
        ADMIN_ROLE_FILTER,
        { $addToSet: { permissions: { $each: normalizedPermissionIds } } }
    );
};

module.exports = {
    ADMIN_ROLE_FILTER,
    assignPermissionsToAdminRoles
};
