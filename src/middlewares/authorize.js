const hasMatchingRole = (user, roleNames = []) => {
    const normalizedRoleNames = Array.isArray(roleNames) ? roleNames : [roleNames];
    const userRoleNames = Array.isArray(user?.roles)
        ? user.roles.map((role) => (typeof role === 'string' ? role : role?.name)).filter(Boolean)
        : [];

    return normalizedRoleNames.some((roleName) => userRoleNames.includes(roleName));
};

const isSuperAdmin = (user) => (
    (user?.roles || []).some((role) =>
        role?.isSystem ||
        role?.name === 'System Admin' ||
        role?.name === 'Super Admin' ||
        (role?.permissions || []).some((permission) => permission && permission.key === '*')
    ) || (user?.permissions || []).includes('*')
);

const authorizeAny = (permissionKeys = []) => {
    const requiredPermissions = Array.isArray(permissionKeys) ? permissionKeys : [permissionKeys];

    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }

        if (isSuperAdmin(req.user)) {
            return next();
        }

        const userPermissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
        const hasPermission = requiredPermissions.some((permissionKey) => userPermissions.includes(permissionKey));

        if (hasPermission) {
            return next();
        }

        return res.status(403).json({
            message: `Forbidden: You do not have any of the required permissions: ${requiredPermissions.join(', ')}`
        });
    };
};

const authorizeAll = (permissionKeys = []) => {
    const requiredPermissions = Array.isArray(permissionKeys) ? permissionKeys : [permissionKeys];

    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }

        if (isSuperAdmin(req.user)) {
            return next();
        }

        const userPermissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
        const hasAllPermissions = requiredPermissions.every((permissionKey) => userPermissions.includes(permissionKey));

        if (hasAllPermissions) {
            return next();
        }

        return res.status(403).json({
            message: `Forbidden: You do not have all required permissions: ${requiredPermissions.join(', ')}`
        });
    };
};

const authorizeRoleOrPermission = ({ roles = [], permissions = [] } = {}) => (
    (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }

        if (isSuperAdmin(req.user)) {
            return next();
        }

        const hasRole = roles.length > 0 && hasMatchingRole(req.user, roles);
        const userPermissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
        const hasPermission = permissions.length > 0 && permissions.some((permissionKey) => userPermissions.includes(permissionKey));

        if (hasRole || hasPermission) {
            return next();
        }

        return res.status(403).json({
            message: 'Forbidden: You do not meet the required role or permission requirements'
        });
    }
);

const authorize = authorizeAny;

module.exports = {
    authorize,
    authorizeAll,
    authorizeAny,
    authorizeRoleOrPermission
};
