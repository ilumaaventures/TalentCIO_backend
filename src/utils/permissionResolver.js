const Role = require('../models/Role');
const Permission = require('../models/Permission');

const ANNOUNCEMENT_MANAGER_ROLE_NAMES = new Set(['Admin', 'Manager', 'HR Admin', 'System Admin']);

const normalizeId = (value) => String(value?._id || value || '');

const augmentPermissionKeysForRoles = ({ roles = [], permissionKeys = [] } = {}) => {
    const roleNames = (Array.isArray(roles) ? roles : [])
        .map((role) => (typeof role === 'string' ? role : role?.name))
        .filter(Boolean);

    const finalPermissions = new Set(Array.isArray(permissionKeys) ? permissionKeys.filter(Boolean) : []);

    if (roleNames.some((roleName) => ANNOUNCEMENT_MANAGER_ROLE_NAMES.has(roleName))) {
        finalPermissions.add('announcement.manage');
    }

    return [...finalPermissions];
};

const getRoleCompanyMatch = (companyId) => (
    companyId
        ? { $or: [{ companyId }, { companyId: null }] }
        : {}
);

const fetchRoleGraph = async ({ roleIds = [], companyId }) => {
    const queue = [...new Set(roleIds.map(normalizeId).filter(Boolean))];
    const roleMap = new Map();

    while (queue.length > 0) {
        const batchIds = queue.splice(0, queue.length);
        const roles = await Role.find({
            _id: { $in: batchIds },
            ...getRoleCompanyMatch(companyId)
        })
            .select('name isSystem permissions inheritsFrom companyId')
            .lean();

        roles.forEach((role) => {
            const roleId = normalizeId(role._id);
            if (roleMap.has(roleId)) {
                return;
            }

            roleMap.set(roleId, role);

            (role.inheritsFrom || []).map(normalizeId).forEach((parentRoleId) => {
                if (parentRoleId && !roleMap.has(parentRoleId) && !queue.includes(parentRoleId)) {
                    queue.push(parentRoleId);
                }
            });
        });
    }

    const permissionIds = [...new Set(
        [...roleMap.values()].flatMap((role) => (
            Array.isArray(role.permissions) ? role.permissions.map(normalizeId).filter(Boolean) : []
        ))
    )];

    const permissions = permissionIds.length > 0
        ? await Permission.find({ _id: { $in: permissionIds } })
            .select('key description module isDeprecated')
            .lean()
        : [];

    const permissionMap = new Map(
        permissions.map((permission) => [normalizeId(permission._id), permission])
    );

    return { roleMap, permissionMap };
};

const dedupePermissions = (permissions = []) => {
    const seen = new Set();
    return permissions.filter((permission) => {
        const key = String(permission?.key || '').trim();
        if (!key || seen.has(key) || permission?.isDeprecated === true) {
            return false;
        }

        seen.add(key);
        return true;
    });
};

const resolveRoleNode = (roleId, roleMap, permissionMap, cache = new Map(), stack = new Set()) => {
    const normalizedRoleId = normalizeId(roleId);
    if (!normalizedRoleId) return null;

    if (cache.has(normalizedRoleId)) {
        return cache.get(normalizedRoleId);
    }

    if (stack.has(normalizedRoleId)) {
        throw new Error(`Role inheritance cycle detected involving role ${normalizedRoleId}`);
    }

    const role = roleMap.get(normalizedRoleId);
    if (!role) {
        return null;
    }

    stack.add(normalizedRoleId);

    const directPermissions = (role.permissions || [])
        .map((permissionId) => permissionMap.get(normalizeId(permissionId)))
        .filter(Boolean)
        .filter((permission) => permission.isDeprecated !== true);

    const inheritedRoles = (role.inheritsFrom || [])
        .map((parentRoleId) => resolveRoleNode(parentRoleId, roleMap, permissionMap, cache, stack))
        .filter(Boolean);

    const effectivePermissions = dedupePermissions([
        ...directPermissions,
        ...inheritedRoles.flatMap((parentRole) => parentRole.permissions || [])
    ]);

    const resolvedRole = {
        _id: role._id,
        name: role.name,
        isSystem: Boolean(role.isSystem),
        companyId: role.companyId || null,
        inheritsFrom: inheritedRoles.map((parentRole) => ({
            _id: parentRole._id,
            name: parentRole.name,
            isSystem: Boolean(parentRole.isSystem)
        })),
        directPermissions,
        permissions: effectivePermissions
    };

    cache.set(normalizedRoleId, resolvedRole);
    stack.delete(normalizedRoleId);

    return resolvedRole;
};

const resolveRolesWithInheritance = async ({ roleIds = [], companyId }) => {
    const normalizedRoleIds = [...new Set(roleIds.map(normalizeId).filter(Boolean))];
    if (!normalizedRoleIds.length) {
        return { roles: [], permissionKeys: [] };
    }

    const { roleMap, permissionMap } = await fetchRoleGraph({ roleIds: normalizedRoleIds, companyId });
    const cache = new Map();
    const roles = normalizedRoleIds
        .map((roleId) => resolveRoleNode(roleId, roleMap, permissionMap, cache))
        .filter(Boolean);

    const permissionKeys = [...new Set(
        roles.flatMap((role) => (role.permissions || []).map((permission) => permission.key).filter(Boolean))
    )];

    return {
        roles,
        permissionKeys: augmentPermissionKeysForRoles({ roles, permissionKeys })
    };
};

const validateRoleInheritanceGraph = async ({ roleId = null, inheritsFrom = [], companyId }) => {
    const normalizedParentIds = [...new Set((inheritsFrom || []).map(normalizeId).filter(Boolean))];
    const normalizedRoleId = normalizeId(roleId);

    if (normalizedRoleId && normalizedParentIds.includes(normalizedRoleId)) {
        throw new Error('A role cannot inherit from itself');
    }

    if (!normalizedParentIds.length) {
        return [];
    }

    const { roleMap } = await fetchRoleGraph({ roleIds: normalizedParentIds, companyId });
    const missingRoleIds = normalizedParentIds.filter((parentRoleId) => !roleMap.has(parentRoleId));
    if (missingRoleIds.length > 0) {
        throw new Error('One or more inherited roles could not be found in this workspace');
    }

    const hasCycleToTarget = (startRoleId, targetRoleId, visited = new Set()) => {
        if (!targetRoleId) {
            return false;
        }

        if (startRoleId === targetRoleId) {
            return true;
        }

        if (visited.has(startRoleId)) {
            return false;
        }
        visited.add(startRoleId);

        const role = roleMap.get(startRoleId);
        const parentIds = Array.isArray(role?.inheritsFrom) ? role.inheritsFrom.map(normalizeId).filter(Boolean) : [];
        return parentIds.some((parentRoleId) => hasCycleToTarget(parentRoleId, targetRoleId, visited));
    };

    if (normalizedRoleId) {
        const cycleDetected = normalizedParentIds.some((parentRoleId) => hasCycleToTarget(parentRoleId, normalizedRoleId));
        if (cycleDetected) {
            throw new Error('This inheritance chain would create a cycle');
        }
    }

    return normalizedParentIds;
};

module.exports = {
    augmentPermissionKeysForRoles,
    resolveRolesWithInheritance,
    validateRoleInheritanceGraph
};
