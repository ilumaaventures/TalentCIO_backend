
const BusinessUnit = require('../models/BusinessUnit');
const Client = require('../models/Client');
const Project = require('../models/Project');
const Module = require('../models/Module');
const Task = require('../models/Task');

const User = require('../models/User');

const hasPermission = (req, permission) => (req.user.permissions || []).includes(permission);
const hasAnyPermission = (req, permissions) => permissions.some(permission => hasPermission(req, permission));
const isAdminUser = (req) => (req.user.roles || []).some(r => r.name === 'Admin');

// --- Employees (Helper for Dropdowns) ---
const getEmployees = async (req, res) => {
    try {
        res.set('Cache-Control', 'private, max-age=45, stale-while-revalidate=45');
        const users = await User.find({ companyId: req.companyId })
            .select('firstName lastName email')
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
        const client = await Client.findOneAndUpdate({ _id: req.params.id, companyId: req.companyId },
            req.body,
            { new: true }
        );
        if (!client) return res.status(404).json({ message: 'Client not found' });
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
        let query = { companyId: req.companyId };

        // Check if user is Admin
        // Check if user is Admin or has global read permission
        const canViewAll = isAdminUser(req) || hasPermission(req, 'project.read');
        const canViewAssigned = hasPermission(req, 'project.view_assigned');
        const canViewTeam = hasPermission(req, 'project.view_team');

        if (canViewAll) {
            // Fetch all projects
        } else if (canViewAssigned || canViewTeam) {
            const orConditions = [];

            // 1. Assigned Projects (Manager, Member, or Task Assigned)
            const assignedModuleIds = await Task.distinct('module', { assignees: req.user._id, companyId: req.companyId });
            const taskProjectIds = await Module.distinct('project', { _id: { $in: assignedModuleIds }, companyId: req.companyId });

            orConditions.push({ manager: req.user._id });
            orConditions.push({ members: req.user._id });
            orConditions.push({ _id: { $in: taskProjectIds } });

            // 2. Team Projects
            if (canViewTeam) {
                const directReports = await User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('_id').lean();
                const reportIds = directReports.map(u => u._id);

                if (reportIds.length > 0) {
                    orConditions.push({ manager: { $in: reportIds } });
                    orConditions.push({ members: { $in: reportIds } });

                    const teamAssignedModuleIds = await Task.distinct('module', { assignees: { $in: reportIds }, companyId: req.companyId });
                    const teamTaskProjectIds = await Module.distinct('project', { _id: { $in: teamAssignedModuleIds }, companyId: req.companyId });
                    orConditions.push({ _id: { $in: teamTaskProjectIds } });
                }
            }

            query.$or = orConditions;
        } else {
            // Neither Admin, nor Read All, nor View Assigned -> See Nothing
            // Setting a query that returns nothing
            query._id = null;
        }

        const projects = await Project.find(query)
            .populate('client', 'name')
            .populate('manager', 'firstName lastName')
            .populate('members', 'firstName lastName') // Populate members to show them if needed
            .lean();
        res.json(projects);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getProjectHierarchy = async (req, res) => {
    try {
        const { id } = req.params;
        const project = await Project.findOne({ _id: id, companyId: req.companyId })
            .populate('client', 'name')
            .populate('manager', 'firstName lastName')
            .populate('members', '_id') // Need IDs to check membership
            .lean();

        if (!project) return res.status(404).json({ message: 'Project not found' });

        // Security Check
        const canViewAll = isAdminUser(req) || hasPermission(req, 'project.read');
        const canViewAssigned = hasPermission(req, 'project.view_assigned');
        const canViewTeam = hasPermission(req, 'project.view_team');
        const canLogTime = hasAnyPermission(req, ['timesheet.submit', 'timesheet.create']);
        
        // Strict Check: If not Admin/Read, MUST have view_assigned, view_team, OR be able to log time
        if (!canViewAll && !canViewAssigned && !canViewTeam && !canLogTime) {
            return res.status(403).json({ message: 'Not authorized to view projects' });
        }

        // Fetch project modules first to have them available for security and hierarchy
        const projectModules = await Module.find({ project: id, companyId: req.companyId })
            .select('_id name startDate endDate status')
            .lean();
        const projectModuleIds = projectModules.map(m => m._id);

        const isManager = project.manager?._id.toString() === req.user._id.toString();
        const isMember = project.members.some(m => m._id.toString() === req.user._id.toString());

        // Determine Access
        let hasAccess = canViewAll || isManager || isMember || canLogTime;

        if (!hasAccess) {
            // Already fetched above

            // 1. Check Assigned Task
            if (canViewAssigned || canViewTeam || canLogTime) {
                const assignedTask = await Task.findOne({ 
                    module: { $in: projectModuleIds }, 
                    assignees: req.user._id, 
                    companyId: req.companyId 
                }).lean();
                if (assignedTask) hasAccess = true;
            }

            // 2. Check Team Access
            if (!hasAccess && canViewTeam) {
                const directReports = await User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('_id').lean();
                const reportIds = directReports.map(u => u._id.toString());

                if (reportIds.length > 0) {
                    // Check if report is manager or member
                    const reportIsManager = project.manager && reportIds.includes(project.manager._id.toString());
                    const reportIsMember = project.members.some(m => reportIds.includes(m._id.toString()));

                    if (reportIsManager || reportIsMember) {
                        hasAccess = true;
                    } else {
                        // Check if report has task
                        const teamTask = await Task.findOne({ module: { $in: projectModuleIds }, assignees: { $in: reportIds }, companyId: req.companyId });
                        if (teamTask) hasAccess = true;
                    }
                }
            }
        }

        if (!hasAccess) {
            return res.status(403).json({ message: 'Not authorized to view this project' });
        }



        // Define the missing taskQuery
        const taskQuery = { module: { $in: projectModuleIds }, companyId: req.companyId };

        // Parallelize fetching of tasks and other data
        const [tasks] = await Promise.all([
            Task.find(taskQuery)
                .populate('assignees', 'firstName lastName')
                .sort({ startDate: 1 })
                .lean()
        ]);

        const modules = projectModules; // Reuse fetched modules

        // Fetch Work Logs for these tasks
        // We need WorkLog model here
        const WorkLog = require('../models/WorkLog'); // Ensure this is imported or use mongoose.model
        const taskIds = tasks.map(t => t._id);

        let workLogs = [];
        const canViewWorkLogs = canViewAll ||
            hasPermission(req, 'project.view_work_logs');

        // Logic: 
        // 1. Admin/Global Read -> See all.
        // 2. Has project.view_work_logs -> See all.
        // 3. Manager/Member -> See all (Usually they need context).
        // 4. Assigned User (No other permission) -> DOES NOT SEE LOGS (as requested).

        // Wait, current logic for canViewAll handles Admin/project.read.
        // Let's refine based on "employee can see hierarchy NOT work log".
        // If I am just an assigned user (not manager/member), I shouldn't see logs of others or maybe even mine if that's the strict request.
        // But usually one sees their own. The user said "not the work log on that project" (singular/general).
        // I will hide ALL logs if not authorized.

        if (canViewWorkLogs || isManager || isMember) {
            workLogs = await WorkLog.find({ task: { $in: taskIds }, companyId: req.companyId })
                .populate('user', 'firstName lastName')
                .sort({ date: -1 })
                .lean();
        } else {
            // User can see the hierarchy (modules/tasks) but NOT the work logs.
            // We return empty logs.
            workLogs = [];
        }

        // Structure the response
        const hierarchy = {
            ...project,
            modules: modules.map(module => ({
                ...module,
                tasks: tasks
                    .filter(task => task.module.toString() === module._id.toString())
                    .map(task => {
                        const taskLogs = workLogs.filter(log => log.task.toString() === task._id.toString());
                        const totalLogged = taskLogs.reduce((sum, log) => sum + log.hours, 0);
                        return {
                            ...task,
                            workLogs: taskLogs,
                            loggedHours: totalLogged
                        };
                    })
            }))
        };

        res.json(hierarchy);
    } catch (error) {
        console.error(error); // Add console log for debug
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
        const project = await Project.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
        if (!project) return res.status(404).json({ message: 'Project not found' });

        // Cascade Delete
        const modules = await Module.find({ project: project._id, companyId: req.companyId });
        const moduleIds = modules.map(m => m._id);

        if (moduleIds.length > 0) {
            const tasks = await Task.find({ module: { $in: moduleIds }, companyId: req.companyId });
            const taskIds = tasks.map(t => t._id);

            const WorkLog = require('../models/WorkLog');
            if (taskIds.length > 0) {
                await WorkLog.deleteMany({ task: { $in: taskIds }, companyId: req.companyId });
            }
            await Task.deleteMany({ module: { $in: moduleIds }, companyId: req.companyId });
            await Module.deleteMany({ project: project._id, companyId: req.companyId });
        }

        res.json({ message: 'Project and associated data deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// --- Modules ---
const getModules = async (req, res) => {
    try {
        const { projectId } = req.params;

        // Security Check: Implicit Access
        const project = await Project.findOne({ _id: projectId, companyId: req.companyId });
        if (!project) return res.status(404).json({ message: 'Project not found' });

        const canViewAll = isAdminUser(req) || hasPermission(req, 'project.read');
        const canViewAssigned = hasPermission(req, 'project.view_assigned');
        const canViewTeam = hasPermission(req, 'project.view_team');
        const canLogTime = hasAnyPermission(req, ['timesheet.submit', 'timesheet.create']);
        
        // Strict Check: If not Admin/Read, MUST have view_assigned, view_team, OR be able to log time
        if (!canViewAll && !canViewAssigned && !canViewTeam && !canLogTime) {
            return res.status(403).json({ message: 'Not authorized to view modules for this project' });
        }

        const isManager = project.manager?.toString() === req.user._id.toString();
        const isMember = project.members?.some(m => m.toString() === req.user._id.toString());

        let hasAccess = canViewAll || isManager || isMember || canLogTime;

        if (!hasAccess) {
            const modules = await Module.find({ project: projectId, companyId: req.companyId }).select('_id');
            const moduleIds = modules.map(m => m._id);

            // 1. Check Assigned Task
            if (canViewAssigned || canViewTeam || canLogTime) {
                const assignedTask = await Task.findOne({ module: { $in: moduleIds }, assignees: req.user._id, companyId: req.companyId });
                if (assignedTask) hasAccess = true;
            }

            // 2. Check Team Access
            if (!hasAccess && canViewTeam) {
                const directReports = await User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('_id').lean();
                const reportIds = directReports.map(u => u._id.toString());
                if (reportIds.length > 0) {
                    const reportIsManager = project.manager && reportIds.includes(project.manager.toString());
                    const reportIsMember = project.members && project.members.some(m => reportIds.includes(m.toString()));
                    if (reportIsManager || reportIsMember) {
                        hasAccess = true;
                    } else {
                        const teamTask = await Task.findOne({ module: { $in: moduleIds }, assignees: { $in: reportIds }, companyId: req.companyId });
                        if (teamTask) hasAccess = true;
                    }
                }
            }
        }

        if (!hasAccess) {
            return res.status(403).json({ message: 'Not authorized to view modules for this project' });
        }

        const { userId: queryUserId } = req.query;
        const query = { project: projectId, companyId: req.companyId };

        // Target user for restriction check: queryUserId (from Timesheet.jsx) or current user (if not Admin)
        // If queryUserId is provided (which it will be from Timesheet.jsx), apply strict restriction.
        const targetUserId = queryUserId;

        if (targetUserId) {
            // Check if user is Project Manager or Member
            const isProjectAssigned = project.manager?.toString() === targetUserId.toString() ||
                project.members?.some(m => m.toString() === targetUserId.toString());

            if (!isProjectAssigned) {
                // Filter modules where the user has assigned tasks
                const tasksOfUser = await Task.find({ assignees: targetUserId, companyId: req.companyId }).select('module');
                const userModuleIds = tasksOfUser.map(t => t.module);
                query._id = { $in: userModuleIds };
            }
        }

        const modules = await Module.find(query);
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
        const module = await Module.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
        if (!module) return res.status(404).json({ message: 'Module not found' });

        // Cascade Delete
        const tasks = await Task.find({ module: module._id, companyId: req.companyId });
        const taskIds = tasks.map(t => t._id);

        const WorkLog = require('../models/WorkLog');
        if (taskIds.length > 0) {
            await WorkLog.deleteMany({ task: { $in: taskIds }, companyId: req.companyId });
        }
        await Task.deleteMany({ module: module._id, companyId: req.companyId });

        res.json({ message: 'Module and tasks deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// --- Tasks ---
const getTasks = async (req, res) => {
    try {
        // Can filter by module or assignee
        const query = { companyId: req.companyId };
        if (req.query.moduleId) query.module = req.query.moduleId;
        if (req.query.assignees) query.assignees = req.query.assignees; // Check assignees array

        const { userId: queryUserId } = req.query;

        // Restriction target
        const targetUserId = queryUserId;

        if (targetUserId) {
            // Check if user has Project-level access
            let isProjectAssigned = false;
            
            // If moduleId is provided, check its project
            if (req.query.moduleId) {
                const module = await Module.findById(req.query.moduleId).populate('project');
                if (module && module.project) {
                    const project = module.project;
                    isProjectAssigned = project.manager?.toString() === targetUserId.toString() ||
                        project.members?.some(m => m.toString() === targetUserId.toString());
                }
            }

            if (!isProjectAssigned) {
                // Explicitly filter by assignee for timesheet/other views
                query.assignees = targetUserId;
            }
        } else {
            // If no userId passed, and user is NOT admin, restrict to self
            const isAdmin = req.user.roles?.some(r => 
                (typeof r === 'string' && r === 'Admin') || 
                (typeof r === 'object' && r.name === 'Admin')
            ) || req.user.permissions?.includes('*');

            if (!isAdmin) {
                query.assignees = req.user._id;
            }
        }

        const tasks = await Task.find(query)
            .populate('assignees', 'firstName lastName')
            .populate({
                path: 'module',
                select: 'name project',
                populate: {
                    path: 'project',
                    select: 'name'
                }
            });
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const createTask = async (req, res) => {
    try {
        const task = await Task.create({ ...req.body, companyId: req.companyId });
        res.status(201).json(task);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const updateTask = async (req, res) => {
    try {
        const task = await Task.findOneAndUpdate({ _id: req.params.id, companyId: req.companyId }, req.body, { new: true });
        if (!task) return res.status(404).json({ message: 'Task not found' });
        res.json(task);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const deleteTask = async (req, res) => {
    try {
        const task = await Task.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
        if (!task) return res.status(404).json({ message: 'Task not found' });

        const WorkLog = require('../models/WorkLog');
        await WorkLog.deleteMany({ task: task._id, companyId: req.companyId });

        res.json({ message: 'Task deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getBusinessUnits, createBusinessUnit, updateBusinessUnit,
    getClients, createClient, updateClient,
    getProjects, createProject, updateProject, deleteProject, getProjectHierarchy,
    getModules, createModule, updateModule, deleteModule,
    getTasks, createTask, updateTask, deleteTask,
    getEmployees
};
