const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('./user.model');
const SuperAdminUser = require('../auth/superAdminUser.model');
const ImpersonationSession = require('../system/impersonationSession.model');
const AuditLog = require('../system/auditLog.model');
const Company = require('../company/company.model');
const Permission = require('./permission.model');
const EmployeeProfile = require('../dossier/employeeProfile.model');
const { HiringRequest } = require('../talent-acquisition/model/hiringRequest.model');
const Candidate = require('../talent-acquisition/model/candidate.model');
const { setSessionCookie, clearSessionCookie } = require('../../common/utils/sessionCookies');
const { normalizeEnabledModules, filterPermissionsByEnabledModules } = require('../company/enabledModules');
const { augmentPermissionKeysForRoles } = require('../../utils/permissionResolver');
const { checkDossierCompleteness } = require('../dossier/dossierCompleteness');

const IMPERSONATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const isUserPrivileged = (user) => {
    if (!user) return false;

    // Check direct permissions
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    if (permissions.includes('*') || permissions.includes('all') || permissions.includes('user.impersonate')) {
        return true;
    }

    // Check roles
    const roles = Array.isArray(user.roles) ? user.roles : [];
    return roles.some((role) => {
        if (!role) return false;
        const roleName = typeof role === 'string' ? role : role.name;
        if (['Admin', 'Super Admin', 'System Admin'].includes(roleName)) return true;
        if (role.isSystem) return true;

        const rolePermissions = Array.isArray(role.permissions) ? role.permissions : [];
        return rolePermissions.some((p) => {
            const key = typeof p === 'string' ? p : p?.key;
            return key === '*' || key === 'user.impersonate';
        });
    });
};

const getAssignedClientNames = (user) => (
    [...new Set(
        (Array.isArray(user?.taAssignedClients) ? user.taAssignedClients : [])
            .map((client) => String(client || '').trim())
            .filter(Boolean)
    )]
);

const hasDirectTAPermission = (permissions = []) => (
    Array.isArray(permissions)
    && permissions.some((permission) => permission === '*' || String(permission || '').startsWith('ta.'))
);

const buildUserProfilePayload = async (user, company) => {
    let permissions = [...new Set(
        (user.roles || []).flatMap((role) => (role.permissions || []).filter(Boolean).map((p) => p.key || p))
    )];
    permissions = augmentPermissionKeysForRoles({ roles: user.roles || [], permissionKeys: permissions });

    const enabledModules = company?.enabledModules || [];
    let hasAllPermissions = false;
    let totalPerms = 0, directReportsCount = 0, taCount = 0, analyticsViewerCount = 0;

    const assignedClientNames = getAssignedClientNames(user);

    if (permissions.includes('*')) {
        hasAllPermissions = true;
        const allPermissions = await Permission.find({}).lean();
        const filteredAll = filterPermissionsByEnabledModules(allPermissions, enabledModules);
        permissions = [...new Set([...permissions, ...filteredAll.map((p) => p.key)])];

        [directReportsCount, taCount, analyticsViewerCount] = await Promise.all([
            User.countDocuments({ reportingManagers: user._id }),
            HiringRequest.countDocuments({
                companyId: user.companyId,
                $or: [
                    { createdBy: user._id },
                    { 'ownership.hiringManager': user._id },
                    { assignedUsers: user._id },
                    { 'ownership.interviewPanel': user._id },
                    ...(assignedClientNames.length > 0 ? [{ client: { $in: assignedClientNames } }] : [])
                ]
            }),
            HiringRequest.countDocuments({
                companyId: user.companyId,
                analyticsViewers: user._id
            })
        ]);
    } else {
        [totalPerms, directReportsCount, taCount, analyticsViewerCount] = await Promise.all([
            Permission.countDocuments({ key: { $ne: '*' } }),
            User.countDocuments({ reportingManagers: user._id }),
            HiringRequest.countDocuments({
                companyId: user.companyId,
                $or: [
                    { createdBy: user._id },
                    { 'ownership.hiringManager': user._id },
                    { assignedUsers: user._id },
                    { 'ownership.interviewPanel': user._id },
                    ...(assignedClientNames.length > 0 ? [{ client: { $in: assignedClientNames } }] : [])
                ]
            }),
            HiringRequest.countDocuments({
                companyId: user.companyId,
                analyticsViewers: user._id
            })
        ]);

        if (totalPerms > 0 && permissions.length >= totalPerms) {
            hasAllPermissions = true;
        }
    }

    permissions = filterPermissionsByEnabledModules(
        permissions.map((p) => ({ key: p })),
        enabledModules
    ).map((p) => p.key);

    let isInterviewer = false;
    const hasTAAccessByPermission = hasDirectTAPermission(permissions);
    if (taCount === 0 && !hasTAAccessByPermission) {
        const interviewCount = await Candidate.countDocuments({
            'interviewRounds.assignedTo': user._id,
            companyId: user.companyId
        });
        isInterviewer = interviewCount > 0;
    }

    const normalizedCompany = company
        ? {
            ...(company.toObject ? company.toObject() : company),
            enabledModules: normalizeEnabledModules(company.enabledModules || [])
        }
        : null;

    const dossierProfile = await EmployeeProfile.findOne({ user: user._id })
        .select('personal contact employment hris documentSubmissionStatus documents +identity.aadhaarNumber +identity.panNumber')
        .lean();
    const dossierStatus = checkDossierCompleteness(dossierProfile || {});

    const roleNames = (user.roles || []).map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);

    return {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        joiningDate: user.joiningDate,
        reportingManagers: user.reportingManagers || [],
        roles: roleNames,
        roleNames,
        permissions,
        hasAllPermissions,
        directReportsCount,
        isTAParticipant: hasTAAccessByPermission || taCount > 0 || isInterviewer,
        isTAAnalyticsViewer: analyticsViewerCount > 0 || permissions.includes('ta.analytics.assigned') || permissions.includes('ta.analytics.global') || permissions.includes('ta.manage') || permissions.includes('*'),
        company: normalizedCompany,
        dossierStatus: {
            isComplete: dossierStatus.isComplete,
            missingSections: dossierStatus.missingSections,
            missingFields: dossierStatus.missingFields
        }
    };
};

// @desc    Impersonate a user (Tier A: Company Admin -> Employee)
// @route   POST /api/users/:id/impersonate
// @access  Private (protect, authorizeAny(['user.impersonate']))
const impersonateUser = async (req, res) => {
    try {
        if (req.impersonation?.active) {
            return res.status(403).json({ message: 'Impersonation chaining is not permitted.' });
        }

        const targetId = req.params.id;
        if (String(req.user._id) === String(targetId)) {
            return res.status(400).json({ message: 'You cannot impersonate yourself.' });
        }

        const target = await User.findById(targetId)
            .populate({
                path: 'roles',
                populate: { path: 'permissions' }
            })
            .populate('reportingManagers', 'firstName lastName email');

        if (!target || target.isDeleted) {
            return res.status(404).json({ message: 'Target user not found.' });
        }

        if (String(target.companyId) !== String(req.user.companyId)) {
            return res.status(403).json({ message: 'You cannot impersonate a user outside your workspace.' });
        }

        if (target.isActive === false) {
            return res.status(400).json({ message: 'Cannot impersonate an inactive or deactivated user.' });
        }

        if (isUserPrivileged(target)) {
            return res.status(403).json({
                message: 'Cannot impersonate an administrator or user with privileged permissions.'
            });
        }

        const tokenJti = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
        const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';

        await ImpersonationSession.create({
            tier: 'company_admin',
            actorType: 'User',
            actorId: req.user._id,
            targetUserId: target._id,
            companyId: target.companyId,
            reason: String(req.body.reason || '').trim(),
            expiresAt,
            tokenJti,
            ipAddress: clientIp
        });

        const token = jwt.sign(
            {
                id: target._id,
                tokenVersion: target.tokenVersion || 0,
                imp: {
                    jti: tokenJti,
                    by: req.user._id,
                    byType: 'User',
                    tier: 'company_admin',
                    exp: expiresAt.getTime()
                }
            },
            process.env.JWT_SECRET,
            { expiresIn: '30m' }
        );

        setSessionCookie(res, req, token, { maxAgeMs: IMPERSONATION_TTL_MS });

        await AuditLog.create({
            action: 'user.impersonate.start',
            module: 'USER',
            performedBy: req.user._id,
            details: {
                targetUserId: target._id,
                targetUserEmail: target.email,
                companyId: target.companyId,
                reason: req.body.reason || '',
                tier: 'company_admin',
                actorType: 'User',
                actorEmail: req.user.email
            },
            ipAddress: clientIp,
            companyId: target.companyId
        });

        const company = req.company || await Company.findById(target.companyId).lean();
        const profilePayload = await buildUserProfilePayload(target, company);

        const actorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;

        return res.json({
            ...profilePayload,
            token,
            impersonation: {
                active: true,
                tier: 'company_admin',
                expiresAt: expiresAt.toISOString(),
                actorName,
                actorEmail: req.user.email
            }
        });
    } catch (error) {
        console.error('[IMPERSONATE] Error:', error);
        return res.status(500).json({ message: 'Failed to start impersonation session.', error: error.message });
    }
};

// @desc    Impersonate any tenant user (Tier B: Super Admin -> Tenant User)
// @route   POST /api/superadmin/users/:id/impersonate
// @access  Private (protectSuperAdmin, requirePermission('impersonateUsers'))
const superAdminImpersonateUser = async (req, res) => {
    try {
        const reason = String(req.body.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ message: 'A reason or ticket reference is required for Super Admin impersonation.' });
        }

        const targetId = req.params.id;
        const target = await User.findById(targetId)
            .populate({
                path: 'roles',
                populate: { path: 'permissions' }
            })
            .populate('reportingManagers', 'firstName lastName email');

        if (!target || target.isDeleted) {
            return res.status(404).json({ message: 'Target user not found.' });
        }

        if (target.isActive === false) {
            return res.status(400).json({ message: 'Cannot impersonate an inactive or deactivated user.' });
        }

        if (isUserPrivileged(target)) {
            return res.status(403).json({
                message: 'Cannot impersonate an administrator or user with privileged permissions.'
            });
        }

        const company = await Company.findById(target.companyId).lean();
        if (!company) {
            return res.status(404).json({ message: 'Company for target user not found.' });
        }

        const tokenJti = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
        const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';

        await ImpersonationSession.create({
            tier: 'super_admin',
            actorType: 'SuperAdminUser',
            actorId: req.superAdmin._id,
            targetUserId: target._id,
            companyId: target.companyId,
            reason,
            expiresAt,
            tokenJti,
            ipAddress: clientIp
        });

        const token = jwt.sign(
            {
                id: target._id,
                tokenVersion: target.tokenVersion || 0,
                imp: {
                    jti: tokenJti,
                    by: req.superAdmin._id,
                    byType: 'SuperAdminUser',
                    tier: 'super_admin',
                    exp: expiresAt.getTime()
                }
            },
            process.env.JWT_SECRET,
            { expiresIn: '30m' }
        );

        // Sets tenant cookie talentcio_session (leaves talentcio_superadmin_session cookie untouched)
        setSessionCookie(res, req, token, { maxAgeMs: IMPERSONATION_TTL_MS });

        await AuditLog.create({
            action: 'user.impersonate.start',
            module: 'USER',
            performedBy: req.superAdmin._id,
            details: {
                targetUserId: target._id,
                targetUserEmail: target.email,
                companyId: target.companyId,
                reason,
                tier: 'super_admin',
                actorType: 'SuperAdminUser',
                actorEmail: req.superAdmin.email
            },
            ipAddress: clientIp,
            companyId: target.companyId
        });

        const profilePayload = await buildUserProfilePayload(target, company);

        return res.json({
            ...profilePayload,
            token,
            impersonation: {
                active: true,
                tier: 'super_admin',
                expiresAt: expiresAt.toISOString(),
                actorName: req.superAdmin.name,
                actorEmail: req.superAdmin.email
            }
        });
    } catch (error) {
        console.error('[SUPERADMIN IMPERSONATE] Error:', error);
        return res.status(500).json({ message: 'Failed to start super admin impersonation session.', error: error.message });
    }
};

// @desc    End impersonation session and restore admin identity
// @route   POST /api/users/impersonate/end
// @access  Private (protect)
const endImpersonation = async (req, res) => {
    try {
        if (!req.impersonation?.active) {
            return res.status(400).json({ message: 'No active impersonation session found.' });
        }

        const { jti, by, byType, tier } = req.impersonation;

        await ImpersonationSession.updateOne(
            { tokenJti: jti },
            {
                endedAt: new Date(),
                endedReason: 'manual'
            }
        );

        const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';

        await AuditLog.create({
            action: 'user.impersonate.end',
            module: 'USER',
            performedBy: by,
            details: {
                tokenJti: jti,
                tier,
                actorType: byType,
                targetUserId: req.user._id,
                targetUserEmail: req.user.email
            },
            ipAddress: clientIp,
            companyId: req.user.companyId
        });

        if (tier === 'super_admin' || byType === 'SuperAdminUser') {
            clearSessionCookie(res, req);
            return res.json({
                message: 'Impersonation ended successfully.',
                impersonation: { active: false },
                isSuperAdmin: true
            });
        }

        // Tier A: Restore company admin session
        const realAdmin = await User.findById(by)
            .populate({
                path: 'roles',
                populate: { path: 'permissions' }
            })
            .populate('reportingManagers', 'firstName lastName email');

        if (!realAdmin || !realAdmin.isActive || realAdmin.isDeleted) {
            clearSessionCookie(res, req);
            return res.status(401).json({ message: 'Admin account is no longer active. Please log in again.' });
        }

        const adminToken = jwt.sign(
            { id: realAdmin._id, tokenVersion: realAdmin.tokenVersion || 0 },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        setSessionCookie(res, req, adminToken);

        const company = req.company || await Company.findById(realAdmin.companyId).lean();
        const profilePayload = await buildUserProfilePayload(realAdmin, company);

        return res.json({
            ...profilePayload,
            token: adminToken,
            impersonation: { active: false }
        });
    } catch (error) {
        console.error('[END IMPERSONATION] Error:', error);
        return res.status(500).json({ message: 'Failed to end impersonation session.', error: error.message });
    }
};

// @desc    Get current impersonation session status
// @route   GET /api/users/impersonate/status
// @access  Private (protect)
const getImpersonationStatus = async (req, res) => {
    try {
        if (!req.impersonation?.active) {
            return res.json({ active: false });
        }

        const { by, byType, tier, expiresAt } = req.impersonation;
        let actorName = 'Admin';
        let actorEmail = '';

        if (byType === 'SuperAdminUser') {
            const admin = await SuperAdminUser.findById(by).select('name email').lean();
            if (admin) {
                actorName = admin.name;
                actorEmail = admin.email;
            }
        } else {
            const user = await User.findById(by).select('firstName lastName email').lean();
            if (user) {
                actorName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
                actorEmail = user.email;
            }
        }

        return res.json({
            active: true,
            tier,
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            actorName,
            actorEmail
        });
    } catch (error) {
        console.error('[IMPERSONATION STATUS] Error:', error);
        return res.status(500).json({ message: 'Failed to get impersonation status.', error: error.message });
    }
};

module.exports = {
    impersonateUser,
    superAdminImpersonateUser,
    endImpersonation,
    getImpersonationStatus
};
