const authorize = (permissionKey) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }

        // Super Admin Bypass (optional, but good for boostrapping)
        // Check if user has a role with isSystem: true or name "System Admin"
        const isSuperAdmin = (req.user.roles || []).some(role =>
            role.isSystem ||
            role.name === 'System Admin' ||
            (role.permissions || []).some(p => p && p.key === '*')
        );
        if (isSuperAdmin) {
            return next();
        }

        const requiredPermissions = Array.isArray(permissionKey) ? permissionKey : [permissionKey];
        const userPermissions = req.user.permissions || [];

        const hasPermission = requiredPermissions.some(p => userPermissions.includes(p));

        if (hasPermission) {
            return next();
        } else {
            return res.status(403).json({
                message: `Forbidden: You do not have required permissions: ${requiredPermissions.join(' or ')}`
            });
        }
    };
};

module.exports = { authorize };
