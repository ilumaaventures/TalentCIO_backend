const Role = require('../models/Role');
const Permission = require('../models/Permission');

const ANNOUNCEMENT_MANAGER_ROLE_NAMES = new Set(['Admin', 'Manager', 'HR Admin', 'System Admin', 'Super Admin']);

const normalizeId = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        if ('_id' in value && value._id && value._id !== value) {
            return normalizeId(value._id);
        }
        if (value.buffer && (value.buffer instanceof Uint8Array || Array.isArray(value.buffer) || ArrayBuffer.isView(value.buffer))) {
            const buf = Uint8Array.from(value.buffer);
            if (buf.length === 12) {
                return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
            }
        }
        if (typeof value.toString === 'function') {
            const str = value.toString();
            if (str !== '[object Object]') return str;
        }
    }
    const strVal = String(value);
    return strVal === '[object Object]' ? '' : strVal;
};

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

// ─── Permission Cache (HIGH-1 moved here for permission resolution) ───────────
// Permissions are system-wide and almost never change at runtime.
const PERMISSION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let permissionCache = null;
let permissionCachedAt = 0;

const getAllPermissions = async () => {
    if (permissionCache && (Date.now() - permissionCachedAt) < PERMISSION_CACHE_TTL_MS) {
        return permissionCache;
    }
    permissionCache = await Permission.find({}).select('key description module isDeprecated').lean();
    permissionCachedAt = Date.now();
    return permissionCache;
};

/**
 * HIGH-2 Fix: Load the ENTIRE company role graph in a SINGLE query,
 * then resolve inheritance entirely in memory.
 *
 * Old approach: BFS while-loop that issued one DB query per inheritance level
 * (e.g., 3-level deep = 3 sequential round-trips).
 *
 * New approach: One query loads all roles for the company + global roles,
 * then the BFS traversal is pure in-memory Map lookups — O(N) total.
 */
const fetchRoleGraph = async ({ roleIds = [], companyId }) => {
    // Fetch ALL roles relevant to this company in a SINGLE query
    const allRoles = await Role.find({
        ...getRoleCompanyMatch(companyId)
    })
        .select('name isSystem permissions inheritsFrom companyId')
        .lean();

    // Build a Map of all available roles for O(1) lookup during BFS
    const roleMap = new Map(allRoles.map(role => [normalizeId(role._id), role]));

    // Collect all permission IDs referenced by any role
    const permissionIds = [...new Set(
        allRoles.flatMap(role =>
            Array.isArray(role.permissions) ? role.permissions.map(normalizeId).filter(Boolean) : []
        )
    )];

    // Fetch permissions — uses cache to avoid repeated DB hits
    const allPermissions = await getAllPermissions();
    const permissionMap = new Map(allPermissions.map(p => [normalizeId(p._id), p]));

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
    validateRoleInheritanceGraph,
    getAllPermissions // exported for use in pageBootstrapController
};
