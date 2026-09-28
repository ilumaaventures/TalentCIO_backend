const mongoose = require('mongoose');
const BusinessUnit = require('../business-unit/businessUnit.model');
const Client = require('../client/client.model');
const Project = require('./project.model');
const Module = require('../task/module.model');
const Task = require('../task/task.model');
const { HiringRequest } = require('../talent-acquisition/model/hiringRequest.model');

const User = require('../../modules/user/user.model');
const {
    softDeleteProjectTree,
    softDeleteModuleTree,
    softDeleteTaskTree
} = require('../bin/bin.service');

const hasPermission = (req, permission) => (req.user.permissions || []).includes(permission);
const hasAnyPermission = (req, permissions) => permissions.some(permission => hasPermission(req, permission));
const isAdminUser = (req) => {
    const user = req?.user || req;
    return (user?.roles || []).some(r => {
        const roleName = typeof r === 'string' ? r : r?.name;
        const lower = String(roleName || '').toLowerCase().trim();
        return lower === 'admin' || lower === 'system admin' || lower === 'super admin' || r?.isSystem === true;
    }) ||
    user?.permissions?.includes('*') ||
    user?.permissions?.includes('admin') ||
    user?.hasAllPermissions === true;
};

// --- Employees (Helper for Dropdowns) ---
const getEmployees = async (req, res) => {
    try {
        const canManageProjectDirectory = isAdminUser(req) || hasAnyPermission(req, [
            'project.create',
            'project.update',
            'task.create',
            'task.update'
        ]);

        if (!canManageProjectDirectory) {
            return res.status(403).json({ message: 'Not authorized to view employee directory for projects' });
        }

        res.set('Cache-Control', 'private, max-age=45, stale-while-revalidate=45');
        const users = await User.find({ companyId: req.companyId })
            .select('firstName lastName email profilePicture profilePhoto')
            .lean();
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// --- Business Units ---
const getBusinessUnits = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=60');
        const units = await BusinessUnit.find({ companyId: req.companyId })
            .populate('headOfUnit', 'firstName lastName')
            .lean();
        res.json(units);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const createBusinessUnit = async (req, res) => {
    try {
        const unit = await BusinessUnit.create({ ...req.body, companyId: req.companyId });
        res.status(201).json(unit);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const updateBusinessUnit = async (req, res) => {
    try {
        const unit = await BusinessUnit.findOneAndUpdate({ _id: req.params.id, companyId: req.companyId },
            req.body,
            { new: true }
        );
        if (!unit) return res.status(404).json({ message: 'Unit not found' });
        res.json(unit);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// --- Clients ---
const getClients = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=60');
        const clients = await Client.find({ companyId: req.companyId })
            .populate('businessUnit', 'name')
            .lean();
        res.json(clients);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const createClient = async (req, res) => {
    try {
        const client = await Client.create({ ...req.body, companyId: req.companyId });
        res.status(201).json(client);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const updateClient = async (req, res) => {
    try {
        const updateData = { ...req.body };
        if (req.body.status === 'Inactive') {
            updateData.taStatus = 'Inactive';
        }

        const client = await Client.findOneAndUpdate({ _id: req.params.id, companyId: req.companyId },
            updateData,
            { new: true }
        );
        if (!client) return res.status(404).json({ message: 'Client not found' });

        // If client is marked Inactive from Client page, also close and unpublish all TA requisitions
        if (req.body.status === 'Inactive') {
            const clientName = client.name || client.companyName;
            if (clientName) {
                const escapeRegex = (string) => (string || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const escapedName = escapeRegex(clientName);
                const matchingReqs = await HiringRequest.find({
                    companyId: req.companyId,
                    client: { $regex: new RegExp('^' + escapedName + '$', 'i') }
                }).select('_id hiringDetails').lean();

                for (const reqDoc of matchingReqs) {
                    const hiringDetails = reqDoc.hiringDetails || {};
                    const openPos = Math.max(Number(hiringDetails.openPositions) || 0, 0);
                    const closedPos = Math.max(Number(hiringDetails.closedPositions) || 0, 0);
                    const origPos = Math.max(Number(hiringDetails.originalOpenPositions) || 0, openPos + closedPos, 1);

                    await HiringRequest.findByIdAndUpdate(
                        reqDoc._id,
                        {
                            $set: {
                                status: 'Closed',
                                closedAt: new Date(),
                                isPublic: false,
                                isJobVisible: false,
                                isResourceGatewayPublic: false,
                                'hiringDetails.openPositions': 0,
                                'hiringDetails.closedPositions': origPos,
                                'hiringDetails.originalOpenPositions': origPos
                            }
                        }
                    );
                }
            }
        }

        res.json(client);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// --- Projects (Enhanced) ---
const getProjects = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=45, stale-while-revalidate=45');
        // If user is basic employee, maybe we want to filter? 
        // For now, adhering to 'project.read' permission check in route.
        // If Admin, fetch all. If not, fetch only assigned projects (manager, member, or has assigned task)
        let query = { companyId: req.companyId, isDeleted: { $ne: true } };

        const canViewAssigned = hasPermission(req, 'project.view_assigned');
        const canViewTeam = hasPermission(req, 'project.view_team');
        const canViewAll = isAdminUser(req) || hasPermission(req, 'project.read');

        if (canViewAll && req.query.assignedOnly !== 'true') {
            // Fetch all projects for Admin or project.read
        } else {
            const orConditions = [];

            // 1. Assigned Projects (Manager, Member, or Task Assigned)
            const assignedModuleIds = await Task.distinct('module', { assignees: req.user._id, companyId: req.companyId, isDeleted: { $ne: true } });
            const taskProjectIds = await Module.distinct('project', { _id: { $in: assignedModuleIds }, companyId: req.companyId, isDeleted: { $ne: true } });

            orConditions.push({ manager: req.user._id });
            orConditions.push({ members: req.user._id });
            if (taskProjectIds.length > 0) {
                orConditions.push({ _id: { $in: taskProjectIds } });
            }

            // 2. Team Projects
            if (canViewTeam) {
                const directReports = await User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('_id').lean();
                const reportIds = directReports.map(u => u._id);

                if (reportIds.length > 0) {
                    orConditions.push({ manager: { $in: reportIds } });
                    orConditions.push({ members: { $in: reportIds } });

                    const teamAssignedModuleIds = await Task.distinct('module', { assignees: { $in: reportIds }, companyId: req.companyId, isDeleted: { $ne: true } });
                    const teamTaskProjectIds = await Module.distinct('project', { _id: { $in: teamAssignedModuleIds }, companyId: req.companyId, isDeleted: { $ne: true } });
                    if (teamTaskProjectIds.length > 0) {
                        orConditions.push({ _id: { $in: teamTaskProjectIds } });
                    }
                }
            }

            query.$or = orConditions.length > 0 ? orConditions : [{ _id: null }];
        }

        const projects = await Project.find(query)
            .populate('client', 'name')
            .populate('businessUnit', 'name')
            .populate('manager', 'firstName lastName profilePicture profilePhoto')
            .populate('members', 'firstName lastName email profilePicture profilePhoto')
            .sort({ createdAt: -1 })
            .lean();
        res.json(projects);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getProjectHierarchy = async (req, res) => {
    try {
        const { id } = req.params;
        const project = await Project.findOne({ _id: id, companyId: req.companyId, isDeleted: { $ne: true } })
            .populate('client', 'name')
            .populate('businessUnit', 'name')
            .populate('manager', 'firstName lastName profilePicture profilePhoto')
            .populate('members', '_id firstName lastName email profilePicture profilePhoto')
            .lean();

        if (!project) return res.status(404).json({ message: 'Project not found' });

        // Security Check
        const canViewAssigned = hasPermission(req, 'project.view_assigned');
        const canViewTeam = hasPermission(req, 'project.view_team');
        const canViewAll = isAdminUser(req) || hasPermission(req, 'project.read');
        const canLogTime = hasAnyPermission(req, ['timesheet.submit', 'timesheet.create']);
        
        // Fetch project modules first to have them available for security and hierarchy
        const projectModules = await Module.find({ project: id, companyId: req.companyId, isDeleted: { $ne: true } })
            .select('_id name description status startDate dueDate')
            .sort({ createdAt: 1 })
            .lean();
        const projectModuleIds = projectModules.map(m => m._id);

        const managerIdStr = (project.manager?._id || project.manager)?.toString();
        const currentUserIdStr = req.user?._id?.toString();

        const isManager = Boolean(managerIdStr && currentUserIdStr && managerIdStr === currentUserIdStr);
        const isMember = Array.isArray(project.members) && project.members.some(m => {
            const memberIdStr = (m?._id || m)?.toString();
            return Boolean(memberIdStr && currentUserIdStr && memberIdStr === currentUserIdStr);
        });

        // Determine Access
        let hasAccess = canViewAll || isManager || isMember;

        if (!hasAccess) {
            // 1. Check Assigned Task
            const assignedTask = await Task.findOne({ 
                module: { $in: projectModuleIds }, 
                assignees: req.user._id, 
                companyId: req.companyId,
                isDeleted: { $ne: true }
            }).lean();
            if (assignedTask) hasAccess = true;

            // 2. Check Team Access
            if (!hasAccess && canViewTeam) {
                const directReports = await User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('_id').lean();
                const reportIds = directReports.map(u => u._id.toString());

                if (reportIds.length > 0) {
                    const reportIsManager = Boolean(managerIdStr && reportIds.includes(managerIdStr));
                    const reportIsMember = Array.isArray(project.members) && project.members.some(m => {
                        const memberIdStr = (m?._id || m)?.toString();
                        return Boolean(memberIdStr && reportIds.includes(memberIdStr));
                    });

                    if (reportIsManager || reportIsMember) {
                        hasAccess = true;
                    } else {
                        const teamTask = await Task.findOne({ module: { $in: projectModuleIds }, assignees: { $in: reportIds }, companyId: req.companyId, isDeleted: { $ne: true } });
                        if (teamTask) hasAccess = true;
                    }
                }
            }
        }

        if (!hasAccess) {
            return res.status(403).json({ message: 'Not authorized to view this project' });
        }

        const taskQuery = {
            module: { $in: projectModuleIds },
            companyId: req.companyId,
            isDeleted: { $ne: true }
        };

        const [tasks] = await Promise.all([
            Task.find(taskQuery)
                .populate('assignees', 'firstName lastName email profilePicture')
                .populate('reporter', 'firstName lastName email profilePicture')
                .populate('parentTask', '_id name taskKey key status priority')
                .populate('blockedBy', '_id name taskKey key status priority')
                .sort({ order: 1, startDate: 1 })
                .lean()
        ]);

        const modules = projectModules;

        const WorkLog = require('../timesheet/workLog.model');
        const Discussion = require('../discussion/discussion.model');
        const taskIds = tasks.map(t => t._id);
        const projIdStr = String(id);
        const projIdMatch = mongoose.isValidObjectId(projIdStr)
            ? { $in: [projIdStr, new mongoose.Types.ObjectId(projIdStr)] }
            : projIdStr;

        const projectDiscussions = await Discussion.find({
            project: projIdMatch,
            isDeleted: { $ne: true }
        }).select('_id').lean();

        const discObjAndStrIds = [];
        projectDiscussions.forEach(d => {
            if (d && d._id) {
                const s = String(d._id);
                discObjAndStrIds.push(s);
                if (mongoose.isValidObjectId(s)) {
                    discObjAndStrIds.push(new mongoose.Types.ObjectId(s));
                }
            }
        });

        const projObjAndStrIds = [projIdStr];
        if (mongoose.isValidObjectId(projIdStr)) {
            projObjAndStrIds.push(new mongoose.Types.ObjectId(projIdStr));
        }

        let workLogs = [];
        const canViewWorkLogs = canViewAll || hasPermission(req, 'project.view_work_logs');

        if (canViewWorkLogs || isManager || isMember) {
            const orConditions = [
                { project: { $in: projObjAndStrIds } }
            ];
            if (taskIds.length > 0) {
                orConditions.push({ task: { $in: taskIds } });
            }
            if (discObjAndStrIds.length > 0) {
                orConditions.push({ discussion: { $in: discObjAndStrIds } });
            }

            workLogs = await WorkLog.find({
                companyId: req.companyId,
                isDeleted: { $ne: true },
                $or: orConditions
            })
                .populate('user', 'firstName lastName email profilePhoto profilePicture')
                .populate('discussion', 'title discussion status priority hours')
                .sort({ date: -1 })
                .lean();
        } else {
            workLogs = [];
        }

        const directWorkLogs = workLogs.filter(log => !log.task);
        const totalLoggedHours = workLogs.reduce((sum, log) => sum + (Number(log.hours) || 0), 0);

        // Structure the response
        const hierarchy = {
            ...project,
            members: Array.isArray(project.members) ? project.members : [],
            hasModules: project.hasModules !== false,
            directWorkLogs,
            workLogs,
            totalLoggedHours,
            modules: modules.map(module => ({
                ...module,
                tasks: tasks
                    .filter(task => (task.module?._id || task.module)?.toString() === module._id.toString())
                    .map(task => {
                        const taskLogs = workLogs.filter(log => log.task && (log.task?._id || log.task)?.toString() === task._id.toString());
                        const totalLogged = taskLogs.reduce((sum, log) => sum + (Number(log.hours) || 0), 0);
                        return {
                            ...task,
                            module: module._id,
                            key: task.key || task.taskKey,
                            taskKey: task.taskKey || task.key,
                            workLogs: taskLogs,
                            loggedHours: totalLogged
                        };
                    })
            }))
        };

        res.json(hierarchy);
    } catch (error) {
        console.error('[getProjectHierarchy] error:', error);
        res.status(500).json({ message: error.message });
    }
};

const createProject = async (req, res) => {
    try {
        const project = await Project.create({ ...req.body, companyId: req.companyId });
        res.status(201).json(project);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const updateProject = async (req, res) => {
    try {
        const project = await Project.findOneAndUpdate({ _id: req.params.id, companyId: req.companyId },
            req.body,
            { new: true }
        );
        if (!project) return res.status(404).json({ message: 'Project not found' });
        res.json(project);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const deleteProject = async (req, res) => {
    try {
        const project = await Project.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!project) return res.status(404).json({ message: 'Project not found' });

        await project.softDelete(req.user._id);
        await softDeleteProjectTree(project._id, req.companyId, req.user._id);

        res.json({ message: 'Project moved to bin' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// --- Modules ---
const getModules = async (req, res) => {
    try {
        const { projectId } = req.params;

        // Security Check: Implicit Access
        const project = await Project.findOne({ _id: projectId, companyId: req.companyId, isDeleted: { $ne: true } });
        if (!project) return res.status(404).json({ message: 'Project not found' });

        const canViewAssigned = hasPermission(req, 'project.view_assigned');
        const canViewTeam = hasPermission(req, 'project.view_team');
        const canViewAll = isAdminUser(req) || hasPermission(req, 'project.read');
        const canLogTime = hasAnyPermission(req, ['timesheet.submit', 'timesheet.create']);

        const managerIdStr = (project.manager?._id || project.manager)?.toString();
        const currentUserIdStr = req.user?._id?.toString();

        const isManager = Boolean(managerIdStr && currentUserIdStr && managerIdStr === currentUserIdStr);
        const isMember = Array.isArray(project.members) && project.members.some(m => {
            const memberIdStr = (m?._id || m)?.toString();
            return Boolean(memberIdStr && currentUserIdStr && memberIdStr === currentUserIdStr);
        });

        let hasAccess = canViewAll || isManager || isMember;

        if (!hasAccess) {
            const modules = await Module.find({ project: projectId, companyId: req.companyId, isDeleted: { $ne: true } }).select('_id');
            const moduleIds = modules.map(m => m._id);

            // 1. Check Assigned Task
            if (canViewAssigned || canViewTeam || canLogTime) {
                const assignedTask = await Task.findOne({ module: { $in: moduleIds }, assignees: req.user._id, companyId: req.companyId, isDeleted: { $ne: true } });
                if (assignedTask) hasAccess = true;
            }

            // 2. Check Team Access
            if (!hasAccess && canViewTeam) {
                const directReports = await User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('_id').lean();
                const reportIds = directReports.map(u => u._id.toString());
                if (reportIds.length > 0) {
                    const reportIsManager = Boolean(managerIdStr && reportIds.includes(managerIdStr));
                    const reportIsMember = Array.isArray(project.members) && project.members.some(m => {
                        const memberIdStr = (m?._id || m)?.toString();
                        return Boolean(memberIdStr && reportIds.includes(memberIdStr));
                    });
                    if (reportIsManager || reportIsMember) {
                        hasAccess = true;
                    } else {
                        const teamTask = await Task.findOne({ module: { $in: moduleIds }, assignees: { $in: reportIds }, companyId: req.companyId, isDeleted: { $ne: true } });
                        if (teamTask) hasAccess = true;
                    }
                }
            }
        }

        if (!hasAccess) {
            return res.status(403).json({ message: 'Not authorized to view modules for this project' });
        }

        const { userId: queryUserId } = req.query;
        const query = { project: projectId, companyId: req.companyId, isDeleted: { $ne: true } };

        // Target user for restriction check: queryUserId (from Timesheet.jsx) or current user (if not Admin)
        const targetUserId = queryUserId;
        const isViewingOther = targetUserId && String(targetUserId) !== String(req.user._id);

        const isRestricted = !canViewAll;

        if (isViewingOther || isRestricted) {
            const effectiveTarget = targetUserId || req.user._id;
            const effectiveTargetStr = effectiveTarget.toString();
            // Check if user is Project Manager or Member
            const isProjectAssigned = Boolean(managerIdStr && managerIdStr === effectiveTargetStr) ||
                (Array.isArray(project.members) && project.members.some(m => {
                    const memberIdStr = (m?._id || m)?.toString();
                    return Boolean(memberIdStr && memberIdStr === effectiveTargetStr);
                }));

            if (!isProjectAssigned) {
                // Filter modules where the user has assigned tasks
                const tasksOfUser = await Task.find({ assignees: effectiveTarget, companyId: req.companyId, isDeleted: { $ne: true } }).select('module');
                const userModuleIds = tasksOfUser.map(t => t.module);
                query._id = { $in: userModuleIds };
            }
        }

        const modules = await Module.find(query).sort({ createdAt: 1 }).lean();
        res.json(modules);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const createModule = async (req, res) => {
    try {
        const module = await Module.create({ ...req.body, companyId: req.companyId });
        res.status(201).json(module);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const updateModule = async (req, res) => {
    try {
        const module = await Module.findOneAndUpdate({ _id: req.params.id, companyId: req.companyId }, req.body, { new: true });
        if (!module) return res.status(404).json({ message: 'Module not found' });
        res.json(module);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const deleteModule = async (req, res) => {
    try {
        const module = await Module.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!module) return res.status(404).json({ message: 'Module not found' });

        await module.softDelete(req.user._id);
        await softDeleteModuleTree(module._id, req.companyId, req.user._id);

        res.json({ message: 'Module moved to bin' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// --- Tasks (Delegated to authoritative Task Controller) ---
const {
    getTasks,
    createTask,
    updateTask,
    deleteTask
} = require('../task/task.controller');

module.exports = {
    getBusinessUnits, createBusinessUnit, updateBusinessUnit,
    getClients, createClient, updateClient,
    getProjects, createProject, updateProject, deleteProject, getProjectHierarchy,
    getModules, createModule, updateModule, deleteModule,
    getTasks, createTask, updateTask, deleteTask,
    getEmployees
};
