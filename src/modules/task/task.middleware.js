const mongoose = require('mongoose');
const Task = require('./task.model');
const Module = require('./module.model');
const Project = require('../project/project.model');

const isSuperAdminOrAdmin = (user) => {
    if (!user) return false;
    const roles = Array.isArray(user.roles) ? user.roles : [];
    const hasAdminRole = roles.some((role) => {
        const roleName = typeof role === 'string' ? role : role?.name;
        const lower = String(roleName || '').toLowerCase().trim();
        return role?.isSystem ||
            lower === 'admin' ||
            lower === 'system admin' ||
            lower === 'super admin' ||
            (role?.permissions || []).some((permission) => (permission?.key || permission) === '*');
    });
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    return hasAdminRole || perms.includes('*') || perms.includes('admin');
};

const hasAnyPerm = (user, permKeys) => {
    if (!user) return false;
    if (isSuperAdminOrAdmin(user)) return true;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    return permKeys.some(k => perms.includes(k));
};

const canAccessTaskReorder = async (req, res, next) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }
        if (hasAnyPerm(req.user, ['project.update', 'task.update'])) {
            return next();
        }

        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return next();
        }

        const taskIds = items.map(i => i.id).filter(id => id && mongoose.Types.ObjectId.isValid(id));
        const tasks = await Task.find({ _id: { $in: taskIds }, companyId: req.companyId })
            .select('assignees reporter module')
            .lean();

        if (tasks.length === 0) {
            return next();
        }

        const taskModuleIds = tasks.map(t => t.module?._id || t.module).filter(Boolean);
        const itemModuleIds = items.map(i => i.module?._id || i.module).filter(Boolean);
        const allModuleIds = [...new Set([...taskModuleIds, ...itemModuleIds])].filter(
            id => id !== 'UNASSIGNED' && mongoose.Types.ObjectId.isValid(id)
        );

        const modules = await Module.find({ _id: { $in: allModuleIds }, companyId: req.companyId })
            .populate('project', 'manager members')
            .lean();
        const moduleMap = new Map(modules.map(m => [String(m._id), m]));

        const currentUserId = String(req.user._id);

        // Check if user is manager or member of any of the involved projects
        const isProjectMemberOrManager = modules.some(mod => {
            const project = mod?.project;
            if (!project) return false;
            const isManager = String(project.manager?._id || project.manager) === currentUserId;
            const isMember = Array.isArray(project.members) && project.members.some(m => String(m?._id || m) === currentUserId);
            return isManager || isMember;
        });

        if (isProjectMemberOrManager) {
            return next();
        }

        // Also check task-level assignee or reporter
        const isTaskAssigneeOrReporter = tasks.some(task => {
            const isAssignee = Array.isArray(task.assignees) && task.assignees.some(a => String(a?._id || a) === currentUserId);
            const isReporter = String(task.reporter?._id || task.reporter) === currentUserId;
            return isAssignee || isReporter;
        });

        if (isTaskAssigneeOrReporter) {
            return next();
        }

        // Fallback: check if user is a manager or member of any project in this company
        const userProject = await Project.findOne({
            companyId: req.companyId,
            $or: [
                { manager: currentUserId },
                { members: currentUserId }
            ]
        }).select('_id').lean();

        if (userProject) {
            return next();
        }

        return res.status(403).json({
            message: 'Forbidden: You do not have permission to move these tasks'
        });
    } catch (err) {
        console.error('[canAccessTaskReorder] error:', err);
        return res.status(500).json({ message: err.message });
    }
};

const canAccessTaskUpdate = async (req, res, next) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }
        if (hasAnyPerm(req.user, ['project.update', 'task.update'])) {
            return next();
        }

        const taskId = req.params.id || req.params.taskId;
        const task = await Task.findOne({ _id: taskId, companyId: req.companyId })
            .select('assignees reporter module')
            .populate({
                path: 'module',
                select: 'project',
                populate: { path: 'project', select: 'manager members' }
            })
            .lean();

        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        const currentUserId = String(req.user._id);
        const isAssignee = Array.isArray(task.assignees) && task.assignees.some(a => String(a?._id || a) === currentUserId);
        const isReporter = String(task.reporter?._id || task.reporter) === currentUserId;
        const project = task.module?.project;
        const isManager = project && String(project.manager?._id || project.manager) === currentUserId;
        const isMember = project && Array.isArray(project.members) && project.members.some(m => String(m?._id || m) === currentUserId);

        if (isAssignee || isReporter || isManager || isMember) {
            return next();
        }

        return res.status(403).json({
            message: 'Forbidden: You do not have permission to update this task'
        });
    } catch (err) {
        console.error('[canAccessTaskUpdate] error:', err);
        return res.status(500).json({ message: err.message });
    }
};

const canAccessTaskCreate = async (req, res, next) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }
        if (hasAnyPerm(req.user, ['project.create', 'task.create'])) {
            return next();
        }

        const moduleId = req.body?.module;
        if (!moduleId) {
            return next();
        }

        const mod = await Module.findOne({ _id: moduleId, companyId: req.companyId })
            .select('project')
            .populate('project', 'manager members')
            .lean();

        if (!mod || !mod.project) {
            return next();
        }

        const currentUserId = String(req.user._id);
        const isManager = String(mod.project.manager?._id || mod.project.manager) === currentUserId;
        const isMember = Array.isArray(mod.project.members) && mod.project.members.some(m => String(m?._id || m) === currentUserId);

        if (isManager || isMember) {
            return next();
        }

        return res.status(403).json({
            message: 'Forbidden: You do not have permission to create tasks in this project'
        });
    } catch (err) {
        console.error('[canAccessTaskCreate] error:', err);
        return res.status(500).json({ message: err.message });
    }
};

const canAccessTaskDelete = async (req, res, next) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }
        if (hasAnyPerm(req.user, ['project.delete', 'task.delete'])) {
            return next();
        }

        const taskId = req.params.id || req.params.taskId;
        const task = await Task.findOne({ _id: taskId, companyId: req.companyId })
            .select('reporter module')
            .populate({
                path: 'module',
                select: 'project',
                populate: { path: 'project', select: 'manager members' }
            })
            .lean();

        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        const currentUserId = String(req.user._id);
        const isReporter = String(task.reporter?._id || task.reporter) === currentUserId;
        const project = task.module?.project;
        const isManager = project && String(project.manager?._id || project.manager) === currentUserId;

        if (isReporter || isManager) {
            return next();
        }

        return res.status(403).json({
            message: 'Forbidden: You do not have permission to delete this task'
        });
    } catch (err) {
        console.error('[canAccessTaskDelete] error:', err);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    isSuperAdminOrAdmin,
    canAccessTaskReorder,
    canAccessTaskCreate,
    canAccessTaskUpdate,
    canAccessTaskDelete
};
