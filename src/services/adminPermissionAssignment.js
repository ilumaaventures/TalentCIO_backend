const Role = require('../modules/user/role.model');

const ADMIN_ROLE_FILTER = {
    $or: [
        { isSystem: true },
        { companyId: null },
        { name: { $in: ['Admin', 'System Admin', 'Super Admin'] }, isSystem: true }
    ],
    isDeleted: { $ne: true }
};

const normalizePermissionIds = (permissionIds = []) => (
    [...new Set(
        permissionIds
            .map((permissionId) => String(permissionId || '').trim())
            .filter(Boolean)
    )]
);

const normalizeRoleNames = (roleNames = []) => (
    [...new Set(
        roleNames
            .map((roleName) => String(roleName || '').trim())
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

const assignPermissionsToRolesByName = async (roleNames = [], permissionIds = []) => {
    const normalizedRoleNames = normalizeRoleNames(roleNames);
    const normalizedPermissionIds = normalizePermissionIds(permissionIds);

    if (normalizedRoleNames.length === 0 || normalizedPermissionIds.length === 0) {
        return { matchedCount: 0, modifiedCount: 0 };
    }

    // Only update system template roles, NOT tenant-customized non-system roles
    return Role.updateMany(
        {
            name: { $in: normalizedRoleNames },
            $or: [{ isSystem: true }, { companyId: null }],
            isDeleted: { $ne: true }
        },
        { $addToSet: { permissions: { $each: normalizedPermissionIds } } }
    );
};

module.exports = {
    ADMIN_ROLE_FILTER,
    assignPermissionsToAdminRoles,
    assignPermissionsToRolesByName
};
