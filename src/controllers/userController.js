const User = require('../models/User');
const Role = require('../models/Role');
const { HiringRequest } = require('../models/HiringRequest');
const Candidate = require('../models/Candidate');
const Company = require('../models/Company');
const Permission = require('../models/Permission');
const { normalizeEnabledModules } = require('../utils/enabledModules');

const getRoleName = (role) => (typeof role === 'string' ? role : role?.name);

const isPrimaryCompanyAdmin = ({ user, companyEmail, oldestSystemUserId }) => {
    const normalizedCompanyEmail = String(companyEmail || '').trim().toLowerCase();
    const normalizedUserEmail = String(user?.email || '').trim().toLowerCase();
    const roleNames = Array.isArray(user?.roles) ? user.roles.map(getRoleName).filter(Boolean) : [];
    const isAdminUser = roleNames.includes('Admin') || roleNames.includes('System Admin');
    const userId = user?._id ? String(user._id) : '';
    const normalizedOldestSystemUserId = oldestSystemUserId ? String(oldestSystemUserId) : '';
    const isMatchByEmail = Boolean(normalizedCompanyEmail && normalizedUserEmail === normalizedCompanyEmail && isAdminUser);
    const isMatchByOldestSystemUser = Boolean(normalizedOldestSystemUserId && userId === normalizedOldestSystemUserId && isAdminUser);

    return isMatchByEmail || isMatchByOldestSystemUser;
};

const getPrimaryAdminProtectionContext = async (companyId) => {
    const [company, systemUsers] = await Promise.all([
        Company.findById(companyId).select('email').lean(),
        User.find({ companyId }, null, { includeDeleted: true })
            .select('_id email createdAt roles')
            .populate('roles', 'name isSystem')
            .lean()
    ]);

    const oldestSystemUser = systemUsers
        .filter((user) => Array.isArray(user.roles) && user.roles.some((role) => role?.isSystem === true))
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];

    return {
        companyEmail: company?.email || '',
        oldestSystemUserId: oldestSystemUser?._id || null
    };
};

const attachPrimaryAdminFlags = async (users, companyId) => {
    if (!Array.isArray(users) || users.length === 0) {
        return users || [];
    }

    const protectionContext = await getPrimaryAdminProtectionContext(companyId);

    return users.map((user) => ({
        ...user,
        isProtectedPrimaryAdmin: isPrimaryCompanyAdmin({
            user,
            ...protectionContext
        })
    }));
};

const isProtectedPrimaryAdminUser = async (user, companyId) => {
    if (!user) return false;
    const protectionContext = await getPrimaryAdminProtectionContext(companyId);
    return isPrimaryCompanyAdmin({
        user,
        ...protectionContext
    });
};

const hasDirectTAPermission = (permissions = []) => (
    Array.isArray(permissions)
    && permissions.some((permission) => permission === '*' || String(permission || '').startsWith('ta.'))
);

const USER_LIST_SELECT = 'firstName lastName email roles reportingManagers employeeProfile department workLocation employmentType employeeCode joiningDate isActive isDeleted profilePicture createdAt updatedAt attendanceMode attendanceShiftCode';

const buildUsersListQuery = (companyId, includeDeleted = false) => (
    User.find(
        { companyId },
        null,
        includeDeleted ? { includeDeleted: true } : undefined
    )
        .select(USER_LIST_SELECT)
        .populate({
            path: 'roles',
            select: 'name isSystem permissions',
            populate: { path: 'permissions', select: 'key' }
        })
        .populate('reportingManagers', 'firstName lastName email')
        .populate('employeeProfile', 'hris')
);

// @desc    Get All Users
// @route   GET /api/users
// @access  Private (Admin) 
const getUsers = async (req, res) => {
    try {
        const includeDeleted = req.query.includeDeleted === 'true';
        const parsedPage = Number.parseInt(req.query.page, 10);
        const parsedLimit = Number.parseInt(req.query.limit, 10);
        const hasPagination = Number.isFinite(parsedPage) || Number.isFinite(parsedLimit);

        if (!hasPagination) {
            const users = await buildUsersListQuery(req.companyId, includeDeleted).lean();
            const usersWithFlags = await attachPrimaryAdminFlags(users, req.companyId);
            return res.json(usersWithFlags);
        }

        const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, 100)
            : 15;
        const skip = (page - 1) * limit;

        const totalQuery = User.countDocuments({ companyId: req.companyId });
        if (includeDeleted) {
            totalQuery.setOptions({ includeDeleted: true });
        }

        const [users, total] = await Promise.all([
            buildUsersListQuery(req.companyId, includeDeleted)
                .sort({ joiningDate: -1, createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            totalQuery
        ]);

        const usersWithFlags = await attachPrimaryAdminFlags(users, req.companyId);

        return res.json({
            users: usersWithFlags,
            total,
            page,
            limit,
            totalPages: Math.max(Math.ceil(total / limit), 1),
            hasNextPage: skip + usersWithFlags.length < total,
            hasPreviousPage: page > 1
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Create User (Admin)
// @route   POST /api/users
// @access  Private (Admin)
const createUser = async (req, res) => {
    const { firstName, lastName, email, password, roleId, department, workLocation, employmentType, employeeCode, joiningDate, directReports, reportingManagers, attendanceMode, attendanceShiftCode } = req.body;
    console.log('Create User Body:', req.body); // DEBUG LOG

    try {
        // Check if user exists
        const userExists = await User.findOne({ email, companyId: req.companyId });
        if (userExists) {
            return res.status(400).json({ message: 'User already exists' });
        }

        // Fetch company to check allowedDomains
        const company = await Company.findById(req.companyId).populate('planId');
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        // Check Allowed Domains
        if (company.allowedDomains && company.allowedDomains.length > 0) {
            const userEmailDomain = email.split('@')[1];
            if (!company.allowedDomains.includes(userEmailDomain)) {
                return res.status(400).json({ message: `Access Denied: Email domain '@${userEmailDomain}' is not allowed for this company. Allowed domains: ${company.allowedDomains.join(', ')}` });
            }
        }

        // Plan Enforcement: Check maxUsers
        if (company.planId) {
            const activeUserCount = await User.countDocuments({ companyId: req.companyId, isActive: true });
            if (activeUserCount >= company.planId.maxUsers) {
                return res.status(403).json({
                    message: `User limit reached (${company.planId.maxUsers}). Please upgrade your plan to add more users.`
                });
            }
        }

        // Validate Role
        const role = await Role.findOne({ _id: roleId, companyId: req.companyId });
        if (!role) {
            return res.status(400).json({ message: 'Invalid Role' });
        }

        const user = await User.create({
            companyId: req.companyId,
            firstName,
            lastName,
            email,
            password,
            roles: [roleId],
            department,
            workLocation,
            employmentType,
            employeeCode,
            joiningDate,
            reportingManagers: reportingManagers || [],
            attendanceMode: attendanceMode || 'clock_in_out',
            attendanceShiftCode: attendanceShiftCode || 'general'
        });

        // Handle Direct Reports
        if (directReports && Array.isArray(directReports) && directReports.length > 0) {
            await User.updateMany(
                { _id: { $in: directReports } },
                { $addToSet: { reportingManagers: user._id } }
            );
        }

        if (user) {
            res.status(201).json({
                _id: user._id,
                firstName: user.firstName,
                email: user.email,
                role: role.name
            });
        } else {
            res.status(400).json({ message: 'Invalid user data' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update User Role
// @route   PUT /api/users/:id/role
// @access  Private (Admin)
const updateUserRole = async (req, res) => {
    const { roleId } = req.body;
    try {
        const user = await User.findOne({ _id: req.params.id, companyId: req.companyId });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.roles = [roleId];
        await user.save();

        res.json({ message: 'User role updated' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update User Details
// @route   PUT /api/users/:id
// @access  Private (Admin)
const updateUser = async (req, res) => {
    const { firstName, lastName, email, password, roleId, department, workLocation, employmentType, employeeCode, joiningDate, directReports, attendanceMode, attendanceShiftCode } = req.body;
    console.log('Update User Body:', req.body); // DEBUG LOG
    try {
        const user = await User.findOne({ _id: req.params.id, companyId: req.companyId });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Validate Email Domain if email is being updated
        if (email && email !== user.email) {
            const company = await Company.findById(req.companyId);
            if (company && company.allowedDomains && company.allowedDomains.length > 0) {
                const userEmailDomain = email.split('@')[1];
                if (!company.allowedDomains.includes(userEmailDomain)) {
                    return res.status(400).json({ message: `Access Denied: Email domain '@${userEmailDomain}' is not allowed for this company. Allowed domains: ${company.allowedDomains.join(', ')}` });
                }
            }
        }

        user.firstName = firstName || user.firstName;
        user.lastName = lastName || user.lastName;
        user.email = email || user.email;
        if (password) user.password = password;
        user.department = department || user.department;
        user.workLocation = workLocation || user.workLocation;
        user.employmentType = employmentType || user.employmentType;
        user.employeeCode = employeeCode || user.employeeCode;
        user.attendanceMode = attendanceMode || user.attendanceMode;
        user.attendanceShiftCode = attendanceShiftCode || user.attendanceShiftCode;
        if (joiningDate) user.joiningDate = joiningDate;

        if (roleId) {
            // Only update role if it's different and valid
            const currentRoleId = user.roles && user.roles.length > 0 ? user.roles[0].toString() : null;
            if (currentRoleId !== roleId) {
                const role = await Role.findOne({ _id: roleId, companyId: req.companyId });
                if (role) {
                    user.roles = [roleId];
                }
            }
        }

        await user.save();

        // Handle Direct Reports (Assign subordinates)
        if (directReports && Array.isArray(directReports)) {
            // 1. Remove this user from reportingManagers of users who are NO LONGER direct reports
            await User.updateMany(
                { reportingManagers: user._id, _id: { $nin: directReports } },
                { $pull: { reportingManagers: user._id } }
            );

            // 2. Add this user to reportingManagers of users who ARE direct reports
            await User.updateMany(
                { _id: { $in: directReports } },
                { $addToSet: { reportingManagers: user._id } }
            );
        }

        res.json({ message: 'User updated successfully', user });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

const getMyTeam = async (req, res) => {
    try {
        const team = await User.find({ reportingManagers: req.user._id, companyId: req.companyId })
            .select('firstName lastName email roles reportingManagers employeeProfile department workLocation employmentType employeeCode joiningDate isActive profilePicture createdAt updatedAt attendanceMode attendanceShiftCode')
            .populate('roles', 'name')
            .populate('reportingManagers', 'firstName lastName email')
            .populate('employeeProfile', 'hris')
            .lean();
        res.json(team);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

const getMyself = async (req, res) => {
    try {
        const effectiveCompanyId = req.companyId || req.user?.companyId;
        const roles = req.user.roles || [];
        const roleNames = roles.map(role => role.name);
        let permissions = [...new Set(req.user.permissions || [])];
        let hasAllPermissions = permissions.includes('*');

        const [
            totalPerms,
            directReportsCount,
            subordinates,
            taCount,
            reportingManagers,
            company,
            analyticsViewerCount
        ] = await Promise.all([
            hasAllPermissions ? Promise.resolve(0) : Permission.countDocuments({ key: { $ne: '*' } }),
            User.countDocuments({ reportingManagers: req.user._id, companyId: effectiveCompanyId }),
            User.find({ reportingManagers: req.user._id, companyId: effectiveCompanyId })
                .select('firstName lastName email department')
                .lean(),
            HiringRequest.countDocuments({
                companyId: effectiveCompanyId,
                $or: [
                    { createdBy: req.user._id },
                    { 'ownership.hiringManager': req.user._id },
                    { assignedUsers: req.user._id },
                    { 'ownership.interviewPanel': req.user._id },
                    ...(getAssignedClientNames(req.user).length > 0 ? [{ client: { $in: getAssignedClientNames(req.user) } }] : [])
                ]
            }),
            User.findById(req.user._id).select('reportingManagers').populate('reportingManagers', 'firstName lastName email').lean(),
            req.company
                ? Promise.resolve(req.company)
                : Company.findById(effectiveCompanyId)
                    .select('name subdomain email timezone status enabledModules settings logo themeColor planId')
                    .lean(),
            HiringRequest.countDocuments({
                companyId: effectiveCompanyId,
                analyticsViewers: req.user._id
            })
        ]);

        if (hasAllPermissions) {
            const allPermissions = await Permission.find({}).select('key').lean();
            permissions = [...new Set([...permissions, ...allPermissions.map(p => p.key)])];
        } else if (totalPerms > 0 && permissions.length >= totalPerms) {
            hasAllPermissions = true;
        }

        let isInterviewer = false;

        // Final concurrent batch for TA/Interviewer checks if not already determined
        const hasTAAccessByPermission = hasDirectTAPermission(permissions);

        if (taCount === 0 && !hasTAAccessByPermission) {
            const interviewCount = await Candidate.countDocuments({
                'interviewRounds.assignedTo': req.user._id,
                companyId: effectiveCompanyId
            });
            isInterviewer = interviewCount > 0;
        }

        const normalizedCompany = company
            ? {
                ...(company.toObject ? company.toObject() : company),
                enabledModules: normalizeEnabledModules(company.enabledModules || [])
            }
            : company;

        res.json({
            // Core identity
            _id: req.user._id,
            firstName: req.user.firstName,
            lastName: req.user.lastName,
            email: req.user.email,
            profilePicture: req.user.profilePicture,
            employeeCode: req.user.employeeCode,
            department: req.user.department,
            workLocation: req.user.workLocation,
            employmentType: req.user.employmentType,
            attendanceMode: req.user.attendanceMode || 'clock_in_out',
            attendanceShiftCode: req.user.attendanceShiftCode || 'general',
            joiningDate: req.user.joiningDate,
            isActive: req.user.isActive,
            createdAt: req.user.createdAt,
            updatedAt: req.user.updatedAt,
            reportingManagers: reportingManagers?.reportingManagers || [],
            // Auth & access control
            roles: roleNames,
            roleNames,
            permissions,
            hasAllPermissions,
            directReports: subordinates,
            directReportsCount,
            isTAParticipant: hasTAAccessByPermission || taCount > 0 || isInterviewer,
            isTAAnalyticsViewer: analyticsViewerCount > 0 || permissions.includes('ta.analytics.assigned') || permissions.includes('ta.analytics.global') || permissions.includes('ta.manage') || permissions.includes('*'),
            company: normalizedCompany  // Always includes enabledModules
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

const getUserById = async (req, res) => {
    try {
        const includeDeleted = req.query.includeDeleted === 'true';
        const user = await User.findOne(
            { _id: req.params.id, companyId: req.companyId },
            null,
            includeDeleted ? { includeDeleted: true } : undefined
        )
            .select('firstName lastName email roles reportingManagers department workLocation employmentType employeeCode joiningDate isActive isDeleted profilePicture createdAt updatedAt attendanceMode attendanceShiftCode')
            .populate('roles', 'name isSystem')
            .populate('reportingManagers', 'firstName lastName email')
            .lean();

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Fetch direct reports to allow frontend checkbox pre-filling
        const directReports = await User.find({
            reportingManagers: user._id,
            companyId: req.companyId
        }).select('_id firstName lastName email').lean();

        user.directReports = directReports;
        user.isProtectedPrimaryAdmin = await isProtectedPrimaryAdminUser(user, req.companyId);

        res.json(user);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// TEMP DEBUG: Remove after fixing isTAParticipant issue
const debugTA = async (req, res) => {
    try {
        const user = await User.findOne({ _id: req.user._id, companyId: req.companyId }).populate({ path: 'roles', populate: { path: 'permissions' } });
        const permissions = [...new Set(user.roles.flatMap(r => (r.permissions || []).filter(p => p).map(p => p.key)))];

        const taParticipantHRRs = await HiringRequest.find({
            companyId: req.companyId,
            $or: [
                { createdBy: req.user._id },
                { 'ownership.hiringManager': req.user._id },
                { assignedUsers: req.user._id },
                ...(getAssignedClientNames(req.user).length > 0 ? [{ client: { $in: getAssignedClientNames(req.user) } }] : [])
            ]
        }).select('requestId createdBy ownership.hiringManager assignedUsers').lean();

        const panelHRRs = await HiringRequest.find({ 'ownership.interviewPanel': req.user._id, companyId: req.companyId }).select('requestId').lean();

        const assignedCandidates = await Candidate.find({ 'interviewRounds.assignedTo': req.user._id, companyId: req.companyId }).select('candidateName hiringRequestId').lean();

        const approverHRRs = await HiringRequest.find({ 'approvalChain.approvers': req.user._id, companyId: req.companyId }).select('requestId').lean();

        res.json({
            userId: req.user._id,
            email: user.email,
            roles: user.roles.map(r => r.name),
            permissions,
            taParticipantHRRs: taParticipantHRRs.map(h => h.requestId),
            panelHRRs: panelHRRs.map(h => h.requestId),
            assignedCandidates: assignedCandidates.map(c => c.candidateName),
            approverHRRs: approverHRRs.map(h => h.requestId),
            calculatedIsTAParticipant: taParticipantHRRs.length > 0 || panelHRRs.length > 0 || assignedCandidates.length > 0
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const toggleUserStatus = async (req, res) => {
    try {
        const user = await User.findOne(
            { _id: req.params.id, companyId: req.companyId },
            null,
            { includeDeleted: true }
        );
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.isDeleted) {
            return res.status(400).json({ message: 'Users in the recycle bin cannot be activated or deactivated.' });
        }

        if (user.isActive && await isProtectedPrimaryAdminUser(user, req.companyId)) {
            return res.status(403).json({ message: 'The main admin created by Super Admin cannot be deactivated.' });
        }

        user.isActive = !user.isActive;

        await user.save();

        res.json({
            message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
            isActive: user.isActive
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

const deleteUser = async (req, res) => {
    try {
        const user = await User.findOne(
            { _id: req.params.id, companyId: req.companyId },
            null,
            { includeDeleted: true }
        );
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.isDeleted) {
            return res.status(400).json({ message: 'User is already in the recycle bin.' });
        }

        if (await isProtectedPrimaryAdminUser(user, req.companyId)) {
            return res.status(403).json({ message: 'The main admin created by Super Admin cannot be moved to the bin.' });
        }

        user.isActive = false;
        user.isDeleted = true;
        user.deletedAt = new Date();
        user.deletedBy = req.user._id;
        await user.save();

        res.json({ message: 'User moved to bin' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    getUsers,
    createUser,
    updateUserRole,
    updateUser,
    getMyTeam,
    getMyself,
    getUserById,
    toggleUserStatus,
    deleteUser,
    debugTA
};
const getAssignedClientNames = (user) => (
    [...new Set(
        (Array.isArray(user?.taAssignedClients) ? user.taAssignedClients : [])
            .map((client) => String(client || '').trim())
            .filter(Boolean)
    )]
);
