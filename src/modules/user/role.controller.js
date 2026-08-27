const Role = require('./role.model');
const Permission = require('./permission.model');
const User = require('./user.model');
const Company = require('../company/company.model');
const { validateRoleInheritanceGraph } = require('../../utils/permissionResolver');
const { filterPermissionsByEnabledModules } = require('../company/enabledModules');

const LEGACY_HIDDEN_PERMISSION_KEYS = new Set([
    'ta.analytics.requisition',
    'ta.client.confidential.view',
    'ta.offer.create',
    'ta.offer.view',
    'ta.offer.approve',
    'ta.offer.revoke'
]);

const isVisiblePermission = (permission) =>
    permission &&
    permission.key !== '*' &&
    permission.isDeprecated !== true &&
    !LEGACY_HIDDEN_PERMISSION_KEYS.has(permission.key);

// @desc    Get All Roles
// @route   GET /api/roles
// @access  Private
const getRoles = async (req, res) => {
    try {
        res.set('Cache-Control', 'no-cache');
        const [roles, company] = await Promise.all([
            Role.find({ companyId: req.companyId })
                .populate('permissions')
                .populate('inheritsFrom', 'name isSystem'),
            Company.findById(req.companyId).select('enabledModules').lean()
        ]);
        const enabledModules = company?.enabledModules || [];
        const sanitizedRoles = roles.map(role => {
            const rawPermissions = (role.permissions || []).filter(isVisiblePermission);
            return {
                ...role.toObject(),
                permissions: filterPermissionsByEnabledModules(rawPermissions, enabledModules)
            };
        });
        res.json(sanitizedRoles);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Create Role
// @route   POST /api/roles
// @access  Private (Admin)
const createRole = async (req, res) => {
    const { name, permissions, inheritsFrom = [] } = req.body; // permissions = array of permission IDs

    try {
        const validatedParentRoleIds = await validateRoleInheritanceGraph({
            inheritsFrom,
            companyId: req.companyId
        });

        const role = await Role.create({
            companyId: req.companyId,
            name,
            permissions,
            inheritsFrom: validatedParentRoleIds,
            isSystem: false
        });
        res.status(201).json(role);
    } catch (error) {
        console.error('CREATE ROLE ERROR:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Update Role
// @route   PUT /api/roles/:id
// @access  Private (Admin)
const updateRole = async (req, res) => {
    try {
        const role = await Role.findOne({ _id: req.params.id, companyId: req.companyId });

        if (!role) {
            return res.status(404).json({ message: 'Role not found' });
        }

        if (role.isSystem) {
            return res.status(403).json({ message: 'System roles cannot be modified' });
        }

        role.name = req.body.name || role.name;
        role.permissions = req.body.permissions || role.permissions;
        if (req.body.inheritsFrom !== undefined) {
            role.inheritsFrom = await validateRoleInheritanceGraph({
                roleId: role._id,
                inheritsFrom: req.body.inheritsFrom,
                companyId: req.companyId
            });
        }

        const updatedRole = await role.save();

        // Auto-logout users with this role by incrementing their tokenVersion
        await User.updateMany(
            { roles: role._id },
            { $inc: { tokenVersion: 1 } }
        );

        // Return populated role for the frontend
        const populated = await Role.findById(updatedRole._id)
            .populate('permissions')
            .populate('inheritsFrom', 'name isSystem')
            .lean();
        res.json(populated);
    } catch (error) {
        console.error('UPDATE ROLE ERROR:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get All Permissions
// @route   GET /api/permissions
// @access  Private
const getPermissions = async (req, res) => {
    try {
        res.set('Cache-Control', 'no-cache');
        const company = await Company.findById(req.companyId).select('enabledModules').lean();
        const enabledModules = company?.enabledModules || [];
        let permissions = await Permission.find({});
        permissions = permissions.filter(isVisiblePermission);
        permissions = filterPermissionsByEnabledModules(permissions, enabledModules);
        console.log(`Fetching permissions for UI. Count after filter: ${permissions.length}`);
        // Group permissions by module for easier frontend display
        const grouped = permissions.reduce((acc, curr) => {
            let groupName = curr.module || 'OTHER';

            // Custom grouping for granular interface control
            if (curr.key.startsWith('business_unit.')) groupName = 'BUSINESS UNITS';
            else if (curr.key.startsWith('client.')) groupName = 'CLIENTS';
            else if (curr.key.startsWith('task.')) groupName = 'TASKS';
            else if (curr.key.startsWith('project.') || curr.key.startsWith('module.') || groupName === 'PROJECT') groupName = 'PROJECTS';
            else if (curr.key.startsWith('user.')) groupName = 'USER MANAGEMENT';
            else if (curr.key.startsWith('role.')) groupName = 'ROLE MANAGEMENT';
            else if (curr.key.startsWith('timesheet.')) groupName = 'TIMESHEETS';
            else if (curr.key.startsWith('attendance.')) groupName = 'ATTENDANCE';
            else if (curr.key.startsWith('ta.')) groupName = 'TALENT ACQUISITION';
            else if (curr.key.startsWith('onboarding.')) groupName = 'ONBOARDING';
            else if (curr.key.startsWith('helpdesk.')) groupName = 'HELP DESK';
            else if (curr.key.startsWith('discussion.')) groupName = 'DISCUSSIONS';
            else if (curr.key.startsWith('dossier.') || curr.key.startsWith('employee.revision.') || groupName === 'DOSSIER') groupName = 'EMPLOYEE DOSSIER';
            else if (curr.key.startsWith('leave.')) groupName = 'LEAVES';

            if (!acc[groupName]) acc[groupName] = [];
            acc[groupName].push(curr);
            return acc;
        }, {});

        res.json(grouped);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    getRoles,
    createRole,
    updateRole,
    getPermissions
};
