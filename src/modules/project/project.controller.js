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


// --- Client Projects Snapshot ---
const getClientProjectsSnapshot = async (req, res) => {
    try {
        const { clientId } = req.params;
        if (!clientId || !mongoose.isValidObjectId(clientId)) {
            return res.status(400).json({ message: 'Valid clientId is required' });
        }

        const clientDoc = await Client.findOne({ _id: clientId, companyId: req.companyId, isDeleted: { $ne: true } })
            .select('name companyName nickname status businessUnit')
            .populate('businessUnit', 'name')
            .lean();

        if (!clientDoc) {
            return res.status(404).json({ message: 'Client not found' });
        }

        const clientObjId = new mongoose.Types.ObjectId(clientId);
        const projectQuery = {
            companyId: req.companyId,
            isDeleted: { $ne: true },
            $or: [
                { client: clientObjId },
                { client: String(clientId) }
            ]
        };

        const canViewAll = isAdminUser(req) || hasPermission(req, 'project.read') || hasPermission(req, 'client.read');
        const canViewTeam = hasPermission(req, 'project.view_team');

        if (!canViewAll) {
            const orConditions = [];
            orConditions.push({ manager: req.user._id });
            orConditions.push({ members: req.user._id });

            const assignedModuleIds = await Task.distinct('module', { assignees: req.user._id, companyId: req.companyId, isDeleted: { $ne: true } });
            const taskProjectIds = await Module.distinct('project', { _id: { $in: assignedModuleIds }, companyId: req.companyId, isDeleted: { $ne: true } });
            if (taskProjectIds.length > 0) {
                orConditions.push({ _id: { $in: taskProjectIds } });
            }

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

            projectQuery.$and = [{ $or: orConditions.length > 0 ? orConditions : [{ _id: null }] }];
        }

        const projects = await Project.find(projectQuery)
            .populate('businessUnit', 'name')
            .populate('manager', 'firstName lastName email profilePicture profilePhoto')
            .populate('members', 'firstName lastName email profilePicture profilePhoto')
            .sort({ createdAt: -1 })
            .lean();

        if (projects.length === 0) {
            return res.json({
                client: clientDoc,
                summary: {
                    totalProjects: 0,
                    activeProjects: 0,
                    completedProjects: 0,
                    onHoldProjects: 0,
                    totalHoursSpent: 0,
                    totalEstimatedHours: 0,
                    totalAllocatedMembers: 0,
                    totalModules: 0,
                    totalTasks: 0,
                    completedTasks: 0,
                    totalDiscussions: 0
                },
                projects: [],
                topContributors: []
            });
        }

        const projectIds = projects.map(p => p._id);
        const projIdStrs = projectIds.map(id => String(id));

        // Modules
        const modules = await Module.find({
            project: { $in: projectIds },
            companyId: req.companyId,
            isDeleted: { $ne: true }
        }).sort({ createdAt: 1 }).lean();

        const moduleIds = modules.map(m => m._id);

        // Tasks
        const tasks = await Task.find({
            module: { $in: moduleIds },
            companyId: req.companyId,
            isDeleted: { $ne: true }
        })
            .populate('assignees', 'firstName lastName email profilePicture profilePhoto')
            .populate('reporter', 'firstName lastName email profilePicture profilePhoto')
            .sort({ order: 1, startDate: 1 })
            .lean();

        const taskIds = tasks.map(t => t._id);

        // Discussions
        const Discussion = require('../discussion/discussion.model');
        const discussions = await Discussion.find({
            project: { $in: projectIds },
            companyId: req.companyId,
            isDeleted: { $ne: true }
        })
            .populate('createdBy', 'firstName lastName email profilePicture profilePhoto')
            .populate('supervisor', 'firstName lastName email profilePicture profilePhoto')
            .populate('visibleToUsers', 'firstName lastName email profilePicture profilePhoto')
            .populate('module', 'name')
            .sort({ createdAt: -1 })
            .lean();

        const discIds = discussions.map(d => d._id);

        // WorkLogs
        const WorkLog = require('../timesheet/workLog.model');
        const orConditions = [
            { project: { $in: [...projectIds, ...projIdStrs] } }
        ];
        if (taskIds.length > 0) {
            orConditions.push({ task: { $in: taskIds } });
        }
        if (discIds.length > 0) {
            orConditions.push({ discussion: { $in: discIds } });
        }

        const workLogs = await WorkLog.find({
            companyId: req.companyId,
            isDeleted: { $ne: true },
            $or: orConditions
        })
            .populate('user', 'firstName lastName email profilePicture profilePhoto')
            .sort({ date: -1 })
            .lean();

        // Map tasks to modules
        const moduleMap = new Map();
        modules.forEach(m => {
            moduleMap.set(String(m._id), {
                ...m,
                tasks: [],
                taskCounts: { total: 0, completed: 0, inProgress: 0, todo: 0 },
                loggedHours: 0
            });
        });

        const taskLogsMap = new Map();
        const discLogsMap = new Map();
        const globalUserHoursMap = new Map();

        workLogs.forEach(log => {
            const hours = Number(log.hours) || 0;
            const uId = log.user?._id ? String(log.user._id) : (log.user ? String(log.user) : null);
            if (uId) {
                if (!globalUserHoursMap.has(uId)) {
                    globalUserHoursMap.set(uId, {
                        user: log.user,
                        hours: 0,
                        entriesCount: 0
                    });
                }
                const rec = globalUserHoursMap.get(uId);
                rec.hours += hours;
                rec.entriesCount += 1;
            }

            if (log.task) {
                const tId = String(log.task);
                if (!taskLogsMap.has(tId)) taskLogsMap.set(tId, []);
                taskLogsMap.get(tId).push(log);
            }
            if (log.discussion) {
                const dId = String(log.discussion);
                if (!discLogsMap.has(dId)) discLogsMap.set(dId, []);
                discLogsMap.get(dId).push(log);
            }
        });

        tasks.forEach(t => {
            const mId = t.module ? String(t.module) : null;
            const tLogs = taskLogsMap.get(String(t._id)) || [];
            const taskLoggedHours = tLogs.reduce((acc, l) => acc + (Number(l.hours) || 0), 0);
            const enrichedTask = {
                ...t,
                loggedHours: taskLoggedHours,
                workLogsCount: tLogs.length
            };

            if (mId && moduleMap.has(mId)) {
                const mod = moduleMap.get(mId);
                mod.tasks.push(enrichedTask);
                mod.taskCounts.total += 1;
                mod.loggedHours += taskLoggedHours;

                const statusUpper = String(t.status || '').toUpperCase();
                if (statusUpper === 'COMPLETED' || statusUpper === 'DONE') {
                    mod.taskCounts.completed += 1;
                } else if (statusUpper.includes('PROGRESS') || statusUpper === 'IN_PROGRESS' || statusUpper === 'REVIEW') {
                    mod.taskCounts.inProgress += 1;
                } else {
                    mod.taskCounts.todo += 1;
                }
            }
        });

        const projectModulesMap = new Map();
        modules.forEach(m => {
            const pId = String(m.project);
            if (!projectModulesMap.has(pId)) projectModulesMap.set(pId, []);
            projectModulesMap.get(pId).push(moduleMap.get(String(m._id)));
        });

        const projectDiscussionsMap = new Map();
        discussions.forEach(d => {
            const pId = String(d.project);
            if (!projectDiscussionsMap.has(pId)) projectDiscussionsMap.set(pId, []);
            const dLogs = discLogsMap.get(String(d._id)) || [];
            const discLoggedHours = dLogs.reduce((acc, l) => acc + (Number(l.hours) || 0), 0);
            projectDiscussionsMap.get(pId).push({
                ...d,
                loggedHours: discLoggedHours
            });
        });

        let totalClientLoggedHours = 0;
        let totalClientEstimatedHours = 0;
        let totalClientTasks = 0;
        let totalClientCompletedTasks = 0;
        const allClientAllocatedUsers = new Map();

        const enrichedProjects = projects.map(project => {
            const pIdStr = String(project._id);
            const projModules = projectModulesMap.get(pIdStr) || [];
            const projDiscussions = projectDiscussionsMap.get(pIdStr) || [];
            const projTasks = projModules.flatMap(m => m.tasks || []);

            const projTaskIds = new Set(projTasks.map(t => String(t._id)));
            const projDiscIds = new Set(projDiscussions.map(d => String(d._id)));

            const projWorkLogs = workLogs.filter(log => {
                const matchProj = log.project && String(log.project) === pIdStr;
                const matchTask = log.task && projTaskIds.has(String(log.task));
                const matchDisc = log.discussion && projDiscIds.has(String(log.discussion));
                return matchProj || matchTask || matchDisc;
            });

            const projectLoggedHours = projWorkLogs.reduce((acc, l) => acc + (Number(l.hours) || 0), 0);
            totalClientLoggedHours += projectLoggedHours;

            const projEstimated = Number(project.estimatedHours) || 0;
            totalClientEstimatedHours += projEstimated;

            const allocatedUserMap = new Map();

            if (project.manager) {
                const mgrId = String(project.manager._id || project.manager);
                allocatedUserMap.set(mgrId, {
                    user: project.manager,
                    role: 'Project Manager',
                    hoursLogged: 0,
                    assignedTaskCount: 0
                });
                allClientAllocatedUsers.set(mgrId, project.manager);
            }

            (project.members || []).forEach(mem => {
                const memId = String(mem._id || mem);
                if (!allocatedUserMap.has(memId)) {
                    allocatedUserMap.set(memId, {
                        user: mem,
                        role: 'Team Member',
                        hoursLogged: 0,
                        assignedTaskCount: 0
                    });
                }
                allClientAllocatedUsers.set(memId, mem);
            });

            projTasks.forEach(task => {
                (task.assignees || []).forEach(assignee => {
                    const aId = String(assignee._id || assignee);
                    if (!allocatedUserMap.has(aId)) {
                        allocatedUserMap.set(aId, {
                            user: assignee,
                            role: 'Task Contributor',
                            hoursLogged: 0,
                            assignedTaskCount: 0
                        });
                    }
                    allocatedUserMap.get(aId).assignedTaskCount += 1;
                    allClientAllocatedUsers.set(aId, assignee);
                });
            });

            projWorkLogs.forEach(log => {
                const uId = log.user?._id ? String(log.user._id) : (log.user ? String(log.user) : null);
                if (uId) {
                    if (!allocatedUserMap.has(uId)) {
                        allocatedUserMap.set(uId, {
                            user: log.user,
                            role: 'Contributor',
                            hoursLogged: 0,
                            assignedTaskCount: 0
                        });
                        allClientAllocatedUsers.set(uId, log.user);
                    }
                    allocatedUserMap.get(uId).hoursLogged += (Number(log.hours) || 0);
                }
            });

            let completedTasksCount = 0;
            let inProgressTasksCount = 0;
            let pendingTasksCount = 0;

            projTasks.forEach(t => {
                const s = String(t.status || '').toUpperCase();
                if (s === 'COMPLETED' || s === 'DONE') {
                    completedTasksCount++;
                } else if (s.includes('PROGRESS') || s === 'IN_PROGRESS' || s === 'REVIEW') {
                    inProgressTasksCount++;
                } else {
                    pendingTasksCount++;
                }
            });

            totalClientTasks += projTasks.length;
            totalClientCompletedTasks += completedTasksCount;

            const allocatedMembersList = Array.from(allocatedUserMap.values()).sort((a, b) => b.hoursLogged - a.hoursLogged);

            return {
                ...project,
                totalLoggedHours: Math.round(projectLoggedHours * 10) / 10,
                estimatedHours: projEstimated,
                hoursUtilizationPct: projEstimated > 0 ? Math.round((projectLoggedHours / projEstimated) * 100) : null,
                taskStats: {
                    total: projTasks.length,
                    completed: completedTasksCount,
                    inProgress: inProgressTasksCount,
                    pending: pendingTasksCount,
                    completionPct: projTasks.length > 0 ? Math.round((completedTasksCount / projTasks.length) * 100) : 0
                },
                modulesCount: projModules.length,
                modules: projModules,
                discussionsCount: projDiscussions.length,
                discussions: projDiscussions,
                allocatedMembersCount: allocatedMembersList.length,
                allocatedMembers: allocatedMembersList,
                recentWorkLogs: projWorkLogs.slice(0, 10)
            };
        });

        const topContributors = Array.from(globalUserHoursMap.values())
            .map(c => ({
                user: c.user,
                hours: Math.round(c.hours * 10) / 10,
                entriesCount: c.entriesCount
            }))
            .sort((a, b) => b.hours - a.hours)
            .slice(0, 8);

        const activeCount = projects.filter(p => p.status === 'Active' || (p.isActive && !p.status)).length;
        const completedCount = projects.filter(p => p.status === 'Completed').length;
        const onHoldCount = projects.filter(p => p.status === 'On Hold').length;

        const summary = {
            totalProjects: projects.length,
            activeProjects: activeCount,
            completedProjects: completedCount,
            onHoldProjects: onHoldCount,
            totalHoursSpent: Math.round(totalClientLoggedHours * 10) / 10,
            totalEstimatedHours: totalClientEstimatedHours,
            totalAllocatedMembers: allClientAllocatedUsers.size,
            totalModules: modules.length,
            totalTasks: totalClientTasks,
            completedTasks: totalClientCompletedTasks,
            taskCompletionPct: totalClientTasks > 0 ? Math.round((totalClientCompletedTasks / totalClientTasks) * 100) : 0,
            totalDiscussions: discussions.length
        };

        return res.json({
            client: clientDoc,
            summary,
            projects: enrichedProjects,
            topContributors
        });
    } catch (error) {
        console.error('Error in getClientProjectsSnapshot:', error);
        return res.status(500).json({ message: 'Failed to fetch client project snapshot', error: error.message });
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
    getClientProjectsSnapshot,
    getModules, createModule, updateModule, deleteModule,
    getTasks, createTask, updateTask, deleteTask,
    getEmployees
};
