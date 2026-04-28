const jwt = require('jsonwebtoken');
const User = require('../models/User');
//check
const AUTH_CACHE_TTL_MS = 5000;
const authUserCache = new Map();

const getCacheKey = (userId, tokenVersion) => `${userId}:${tokenVersion || 0}`;

const cloneCachedUser = (user) => ({
    ...user,
    roles: Array.isArray(user.roles) ? user.roles.map(role => ({
        ...role,
        permissions: Array.isArray(role.permissions) ? role.permissions.map(permission => ({ ...permission })) : []
    })) : [],
    reportingManagers: Array.isArray(user.reportingManagers)
        ? user.reportingManagers.map(manager => ({ ...manager }))
        : [],
    permissions: Array.isArray(user.permissions) ? [...user.permissions] : []
});

const protect = async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        try {
            // Get token from header
            token = req.headers.authorization.split(' ')[1];

            // Verify token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const tokenVersion = decoded.tokenVersion || 0;
            const cacheKey = getCacheKey(decoded.id, tokenVersion);
            const cachedEntry = authUserCache.get(cacheKey);

            if (cachedEntry && (Date.now() - cachedEntry.cachedAt) < AUTH_CACHE_TTL_MS) {
                req.user = cloneCachedUser(cachedEntry.user);
            } else {
                // Keep auth hydration minimal because every protected API pays this cost.
                req.user = await User.findById(decoded.id)
                    .select('firstName lastName email roles reportingManagers companyId tokenVersion joiningDate isActive department workLocation employmentType employeeCode profilePicture createdAt updatedAt attendanceMode attendanceShiftCode')
                    .populate({
                        path: 'roles',
                        select: 'name isSystem permissions',
                        populate: {
                            path: 'permissions',
                            select: 'key'
                        }
                    })
                    .lean();

                if (!req.user) {
                    return res.status(401).json({ message: 'Not authorized, user not found' });
                }

                if (req.user && req.user.roles) {
                    req.user.permissions = [...new Set(
                        req.user.roles.flatMap(role => 
                            (role.permissions || []).map(p => typeof p === 'object' ? p.key : p)
                        )
                    )];
                }

                // Ensure roles is always an array
                if (req.user && !req.user.roles) {
                    req.user.roles = [];
                }

                authUserCache.set(cacheKey, {
                    cachedAt: Date.now(),
                    user: cloneCachedUser(req.user)
                });
            }

            // Ensure roles is always an array
            if (req.user && !req.user.roles) {
                req.user.roles = [];
            }

            // --- Multi-tenant isolation check ---
            // 1. If a tenant workspace is identified by URL (req.companyId), the user MUST belong to it.
            if (req.companyId) {
                if (req.user.companyId && req.user.companyId.toString() !== req.companyId.toString()) {
                    console.warn(`[SECURITY ALERT] User ${req.user.email} attempted cross-tenant access from workspace ${req.company?.name || req.companyId} while belonging to ${req.user.companyId}`);
                    return res.status(403).json({ 
                        message: `Your account does not belong to the '${req.company?.name || 'requested'}' workspace.`,
                        code: 'TENANT_MISMATCH'
                    });
                }
            } 
            // 2. If NO tenant workspace is identified (localhost, main domain), fallback to user's company
            else if (req.user.companyId) {
                req.companyId = req.user.companyId;
            }

            // Check Token Version
            // Treat missing version as 0 for backward compatibility during migration
            const userVersion = req.user.tokenVersion || 0;

            if (tokenVersion !== userVersion) {
                authUserCache.delete(cacheKey);
                return res.status(401).json({ message: 'Not authorized, session expired (Role/Permission changed)' });
            }

            next();
        } catch (error) {
            console.error(`JWT Error: ${error.message}`);
            res.status(401).json({ message: 'Not authorized, token failed' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'Not authorized, no token' });
    }
};

const admin = (req, res, next) => {
    const isAdminRole = req.user && req.user.roles && req.user.roles.some(role => 
        role.name === 'Admin' || role === 'Admin' || (typeof role === 'object' && role.name === 'Admin')
    );
    
    const hasAdminPermission = req.user && req.user.permissions && (
        req.user.permissions.includes('*') || 
        req.user.permissions.includes('all') ||
        req.user.permissions.includes('admin')
    );

    if (isAdminRole || hasAdminPermission) {
        next();
    } else {
        res.status(403).json({ message: 'Not authorized as an admin (Role or Permission missing)' });
    }
};

module.exports = { protect, admin };
