const Role = require('../models/Role');
const Permission = require('../models/Permission');
const User = require('../models/User');

// @desc    Get All Roles
// @route   GET /api/roles
// @access  Private
const getRoles = async (req, res) => {
    try {
        res.set('Cache-Control', 'no-cache');
        const roles = await Role.find({ companyId: req.companyId }).populate('permissions');
        res.json(roles);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Create Role
// @route   POST /api/roles
// @access  Private (Admin)
const createRole = async (req, res) => {
    const { name, permissions } = req.body; // permissions = array of permission IDs

    try {
        const role = await Role.create({
            companyId: req.companyId,
            name,
            permissions,
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

        const updatedRole = await role.save();

        // Auto-logout users with this role by incrementing their tokenVersion
        await User.updateMany(
            { roles: role._id },
            { $inc: { tokenVersion: 1 } }
        );

        // Return populated role for the frontend
        const populated = await Role.findById(updatedRole._id).populate('permissions').lean();
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
        let permissions = await Permission.find({});
        // Explicit filter
        permissions = permissions.filter(p => p.key !== '*');
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
            else if (curr.key.startsWith('helpdesk.')) groupName = 'HELP DESK';
            else if (curr.key.startsWith('discussion.')) groupName = 'DISCUSSIONS';
            else if (curr.key.startsWith('dossier.')) groupName = 'EMPLOYEE DOSSIER';
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
