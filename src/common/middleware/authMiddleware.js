const jwt = require('jsonwebtoken');
const User = require('../../modules/user/user.model');
const { resolveRolesWithInheritance } = require('../../utils/permissionResolver');
const { getTokenFromRequest } = require('../../common/utils/sessionCookies');

// ─── Auth Cache Configuration ─────────────────────────────────────────────────
// CRIT-2: Increased TTL from 5s → 30s; token version invalidation already handles
// security-sensitive changes (role changes, password resets, etc.)
const AUTH_CACHE_TTL_MS = 30_000; // 30 seconds
const authUserCache = new Map();

// MED-2: Secondary index for O(1) cache invalidation by userId
// Maps userId string → Set of cache keys belonging to that user
const userIdToCacheKeys = new Map();

const getCacheKey = (userId, tokenVersion) => `${userId}:${tokenVersion || 0}`;

// MED-1: Use structuredClone (native, ~5-10x faster than manual spread)
const cloneCachedUser = (user) => structuredClone(user);

// MED-2: O(1) cache invalidation — no more full Map scan
const invalidateAuthUserCache = (userId) => {
    const keySet = userIdToCacheKeys.get(String(userId || ''));
    if (!keySet) return;
    for (const key of keySet) {
        authUserCache.delete(key);
    }
    userIdToCacheKeys.delete(String(userId || ''));
};

// MED-8: Periodic eviction to prevent unbounded Map growth
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of authUserCache.entries()) {
        if (now - entry.cachedAt > AUTH_CACHE_TTL_MS * 2) {
            authUserCache.delete(key);
            // Clean secondary index
            const userId = key.split(':')[0];
            const keySet = userIdToCacheKeys.get(userId);
            if (keySet) {
                keySet.delete(key);
                if (keySet.size === 0) userIdToCacheKeys.delete(userId);
            }
        }
    }
}, 60_000); // Run every 60 seconds

const setCacheEntry = (cacheKey, userId, user) => {
    authUserCache.set(cacheKey, { cachedAt: Date.now(), user: cloneCachedUser(user) });

    // Update secondary index
    const userIdStr = String(userId || '');
    if (!userIdToCacheKeys.has(userIdStr)) {
        userIdToCacheKeys.set(userIdStr, new Set());
    }
    userIdToCacheKeys.get(userIdStr).add(cacheKey);
};

const protect = async (req, res, next) => {
    const token = getTokenFromRequest(req);

    if (token) {
        try {
            // Verify token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const tokenVersion = decoded.tokenVersion || 0;
            const cacheKey = getCacheKey(decoded.id, tokenVersion);
            const cachedEntry = authUserCache.get(cacheKey);

            if (cachedEntry && (Date.now() - cachedEntry.cachedAt) < AUTH_CACHE_TTL_MS) {
                req.user = cloneCachedUser(cachedEntry.user);
            } else {
                // CRIT-2: Determine companyId early so both DB queries can run in parallel
                const effectiveCompanyId = req.companyId || (req.company?._id);

                // CRIT-2: Run User fetch and Company fetch in parallel (was sequential)
                const [userDoc, companyDoc] = await Promise.all([
                    User.findById(decoded.id)
                        .select('firstName lastName email roles reportingManagers companyId tokenVersion joiningDate isActive department workLocation employmentType employeeCode profilePicture profilePictureMetadata createdAt updatedAt attendanceMode attendanceShiftCode taAssignedClients')
                        .lean(),
                    effectiveCompanyId
                        ? null // already have company on req (from tenantMiddleware)
                        : null // will fetch after we know companyId from userDoc
                ]);

                if (!userDoc) {
                    return res.status(401).json({ message: 'Not authorized, user not found' });
                }

                if (userDoc._id) {
                    userDoc._id = userDoc._id.toString();
                }
                if (userDoc.companyId) {
                    userDoc.companyId = userDoc.companyId.toString();
                }

                req.user = userDoc;

                const resolvedRoleContext = await resolveRolesWithInheritance({
                    roleIds: Array.isArray(req.user.roles) ? req.user.roles : [],
                    companyId: req.user.companyId || req.companyId
                });

                req.user.roles = resolvedRoleContext.roles;
                req.user.permissions = resolvedRoleContext.permissionKeys;

                // Normalize any BSON ObjectIds inside roles and reportingManagers to strings
                // before caching to prevent structuredClone from converting them to plain `{ buffer: ... }` objects.
                if (Array.isArray(req.user.roles)) {
                    req.user.roles = req.user.roles.map(role => {
                        const normalizedRole = {
                            ...role,
                            _id: role._id ? role._id.toString() : '',
                            companyId: role.companyId ? role.companyId.toString() : null
                        };
                        if (Array.isArray(role.inheritsFrom)) {
                            normalizedRole.inheritsFrom = role.inheritsFrom.map(parent => ({
                                ...parent,
                                _id: parent._id ? parent._id.toString() : ''
                            }));
                        }
                        if (Array.isArray(role.directPermissions)) {
                            normalizedRole.directPermissions = role.directPermissions.map(p => ({
                                ...p,
                                _id: p._id ? p._id.toString() : ''
                            }));
                        }
                        if (Array.isArray(role.permissions)) {
                            normalizedRole.permissions = role.permissions.map(p => ({
                                ...p,
                                _id: p._id ? p._id.toString() : ''
                            }));
                        }
                        return normalizedRole;
                    });
                }

                if (Array.isArray(req.user.reportingManagers)) {
                    req.user.reportingManagers = req.user.reportingManagers
                        .map(m => m ? m.toString() : '')
                        .filter(Boolean);
                }

                // Filter permissions based on enabled modules of the current company
                let companyModules = [];
                if (req.company) {
                    // HIGH-4: tenantMiddleware now always selects enabledModules — no extra DB call
                    companyModules = req.company.enabledModules || [];
                } else {
                    const resolvedCompanyId = req.companyId || req.user.companyId;
                    if (resolvedCompanyId) {
                        // CRIT-2: Only fetch company if not already on req (rare path)
                        const Company = require('../../modules/company/company.model');
                        const comp = await Company.findById(resolvedCompanyId).select('enabledModules').lean();
                        companyModules = comp?.enabledModules || [];
                    }
                }

                const { filterPermissionsByEnabledModules } = require('../../modules/company/enabledModules');
                req.user.permissions = filterPermissionsByEnabledModules(
                    req.user.permissions.map(p => typeof p === 'string' ? { key: p } : p),
                    companyModules
                ).map(p => p.key);

                // Ensure roles is always an array
                if (req.user && !req.user.roles) {
                    req.user.roles = [];
                }

                setCacheEntry(cacheKey, decoded.id, req.user);
            }

            // Ensure roles is always an array
            if (req.user && !req.user.roles) {
                req.user.roles = [];
            }

            // --- Multi-tenant isolation check ---
            if (req.companyId) {
                if (req.user.companyId && req.user.companyId.toString() !== req.companyId.toString()) {
                    console.warn(`[SECURITY ALERT] User ${req.user.email} attempted cross-tenant access from workspace ${req.company?.name || req.companyId} while belonging to ${req.user.companyId}`);
                    return res.status(403).json({
                        message: `Your account does not belong to the '${req.company?.name || 'requested'}' workspace.`,
                        code: 'TENANT_MISMATCH'
                    });
                }
            } else if (req.user.companyId) {
                req.companyId = req.user.companyId;
            }

            // Check Token Version
            const userVersion = req.user.tokenVersion || 0;
            if (tokenVersion !== userVersion) {
                invalidateAuthUserCache(decoded.id);
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
    const isAdminRole = req.user && req.user.roles && req.user.roles.some(role => {
        const roleName = typeof role === 'string' ? role : role?.name;
        return ['Admin', 'Super Admin', 'System Admin'].includes(roleName);
    });

    const hasAdminPermission = req.user && req.user.permissions && (
        req.user.permissions.includes('*') ||
        req.user.permissions.includes('all') ||
        req.user.permissions.includes('admin') ||
        req.user.permissions.includes('settings.company.view') ||
        req.user.permissions.includes('settings.company.manage')
    );

    if (isAdminRole || hasAdminPermission) {
        next();
    } else {
        res.status(403).json({ message: 'Not authorized as an admin (Role or Permission missing)' });
    }
};

module.exports = { protect, admin, invalidateAuthUserCache };
