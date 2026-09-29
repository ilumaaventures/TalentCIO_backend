const mongoose = require('mongoose');
const Task = require('./task.model');
const Module = require('./module.model');
const TaskComment = require('./taskComment.model');
const TaskActivity = require('./taskActivity.model');
const User = require('../user/user.model');
const NotificationService = require('../../services/notificationService');
const {
    generateNextTaskKey,
    checkCircularDependency,
    recordTaskActivities,
    applyTaskWorkflowRules
} = require('./task.service');
const { softDeleteTaskTree } = require('../bin/bin.service');

const isAdminOrManager = (user) => {
    const roles = Array.isArray(user?.roles) ? user.roles : [];
    return roles.some((r) => {
        const name = typeof r === 'string' ? r : r?.name;
        const lower = String(name || '').toLowerCase();
        return lower === 'admin' || lower === 'system admin' || lower === 'super admin' || r?.isSystem === true;
    }) || user?.permissions?.includes('*') || user?.permissions?.includes('admin');
};

/**
 * @desc Get tasks with optional filters (backward compatible with existing /projects/tasks)
 * @route GET /api/tasks or GET /api/projects/tasks
 */
const getTasks = async (req, res) => {
    try {
        const query = { companyId: req.companyId, isDeleted: { $ne: true } };

        if (req.query.moduleId) {
            query.module = req.query.moduleId;
        }

        if (req.query.projectId) {
            const modules = await Module.find({ project: req.query.projectId, companyId: req.companyId, isDeleted: { $ne: true } }).select('_id');
            const moduleIds = modules.map(m => m._id);
            query.module = { $in: moduleIds };
        }

        if (req.query.assignees) {
            query.assignees = req.query.assignees;
        }

        if (req.query.status) {
            query.status = req.query.status;
        }

        if (req.query.priority) {
            query.priority = req.query.priority;
        }

        // Top-level only (exclude subtasks when requested)
        if (req.query.topLevelOnly === 'true') {
            query.parentTask = null;
        } else if (req.query.parentTask) {
            query.parentTask = req.query.parentTask;
        }

        // Search by keyword
        if (req.query.search) {
            const regex = new RegExp(req.query.search.trim(), 'i');
            query.$or = [
                { name: regex },
                { taskKey: regex },
                { key: regex },
                { description: regex },
                { labels: regex }
            ];
        }

        // Restriction target (timesheet/attendance support)
        const targetUserId = req.query.userId;
        const canViewAll = isAdminOrManager(req.user) || (req.user.permissions || []).includes('project.read');
        const isViewingOther = targetUserId && String(targetUserId) !== String(req.user._id);

        if ((isViewingOther || !canViewAll) && !req.query.assignees && !req.query.search) {
            const effectiveTarget = targetUserId || req.user._id;
            let isProjectManager = false;
            let isProjectMember = false;

            if (req.query.moduleId) {
                const mod = await Module.findById(req.query.moduleId).populate('project');
                if (mod && mod.project) {
                    const proj = mod.project;
                    isProjectManager = (proj.manager?._id || proj.manager)?.toString() === effectiveTarget.toString();
                    isProjectMember = Array.isArray(proj.members) && proj.members.some(m => (m?._id || m)?.toString() === effectiveTarget.toString());
                }
            } else if (req.query.projectId) {
                const Project = require('../project/project.model');
                const proj = await Project.findById(req.query.projectId);
                if (proj) {
                    isProjectManager = (proj.manager?._id || proj.manager)?.toString() === effectiveTarget.toString();
                    isProjectMember = Array.isArray(proj.members) && proj.members.some(m => (m?._id || m)?.toString() === effectiveTarget.toString());
                }
            }

            if (req.query.assignedOnly === 'true' || (!isProjectManager && !isProjectMember && !isAdminOrManager(req.user))) {
                query.assignees = effectiveTarget;
            }
        }

        const tasks = await Task.find(query)
            .populate('assignees', 'firstName lastName email profilePicture')
            .populate('reporter', 'firstName lastName email profilePicture')
            .populate({
                path: 'module',
                select: 'name project',
                populate: {
                    path: 'project',
                    select: 'name'
                }
            })
            .populate('blockedBy', '_id name taskKey key status priority')
            .sort({ order: 1, createdAt: -1 })
            .lean();

        // Calculate subtask completion progress for each task
        const taskIds = tasks.map(t => t._id);
        const subtasksSummary = await Task.aggregate([
            {
                $match: {
                    companyId: new mongoose.Types.ObjectId(req.companyId),
                    parentTask: { $in: taskIds },
                    isDeleted: { $ne: true }
                }
            },
            {
                $group: {
                    _id: '$parentTask',
                    total: { $sum: 1 },
                    completed: {
                        $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] }
                    }
                }
            }
        ]);

        const subtaskMap = new Map();
        subtasksSummary.forEach(s => {
            subtaskMap.set(String(s._id), { total: s.total, completed: s.completed });
        });

        const enrichedTasks = tasks.map(task => {
            const subtaskStats = subtaskMap.get(String(task._id)) || { total: 0, completed: 0 };
            return {
                ...task,
                key: task.key || task.taskKey,
                taskKey: task.taskKey || task.key,
                subtaskStats
            };
        });

        res.json(enrichedTasks);
    } catch (error) {
        console.error('[TaskController] getTasks error:', error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc Get single task by ID with full details
 * @route GET /api/tasks/:id
 */
const getTaskById = async (req, res) => {
    try {
        const { id } = req.params;
        const task = await Task.findOne({ _id: id, companyId: req.companyId })
            .populate('assignees', 'firstName lastName email profilePicture')
            .populate('reporter', 'firstName lastName email profilePicture')
            .populate('parentTask', '_id name taskKey key status priority')
            .populate('blockedBy', '_id name taskKey key status priority')
            .populate({
                path: 'module',
                select: 'name project',
                populate: {
                    path: 'project',
                    select: 'name manager members'
                }
            })
            .lean();

        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        // Subtasks
        const subtasks = await Task.find({
            parentTask: id,
            companyId: req.companyId,
            isDeleted: { $ne: true }
        })
            .populate('assignees', 'firstName lastName profilePicture')
            .sort({ order: 1, createdAt: 1 })
            .lean();

        const completedSubtasks = subtasks.filter(s => s.status === 'DONE').length;

        // Tasks that are blocked BY this task (reverse dependencies)
        const blocksTasks = await Task.find({
            blockedBy: id,
            companyId: req.companyId,
            isDeleted: { $ne: true }
        })
            .select('_id name taskKey key status priority')
        // WorkLogs
        const WorkLog = require('../timesheet/workLog.model');
        const workLogs = await WorkLog.find({
            task: id,
            companyId: req.companyId,
            isDeleted: { $ne: true }
        })
            .populate('user', 'firstName lastName email profilePicture')
            .sort({ date: -1 })
            .lean();

        const loggedHours = Number(workLogs.reduce((sum, w) => sum + (Number(w.hours) || 0), 0).toFixed(2));

        res.json({
            ...task,
            key: task.key || task.taskKey,
            taskKey: task.taskKey || task.key,
            subtasks,
            subtaskStats: {
                total: subtasks.length,
                completed: completedSubtasks
            },
            blocks: blocksTasks,
            workLogs,
            loggedHours
        });
    } catch (error) {
        console.error('[TaskController] getTaskById error:', error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc Create new task (supports both /api/tasks and /api/projects/tasks)
 * @route POST /api/tasks or POST /api/projects/tasks
 */
const createTask = async (req, res) => {
    try {
        const body = { ...req.body };
        body.companyId = req.companyId;

        if (!body.module) {
            return res.status(400).json({ message: 'Module ID is required' });
        }
        if (!body.name || !body.name.trim()) {
            return res.status(400).json({ message: 'Task title is required' });
        }

        // Default reporter to current user if not provided
        if (!body.reporter) {
            body.reporter = req.user._id;
        }

        // Auto-generate task key if not provided
        if (!body.taskKey) {
            const nextKey = await generateNextTaskKey(req.companyId, body.module);
            body.taskKey = nextKey;
            body.key = nextKey;
        } else {
            body.key = body.taskKey;
        }

        // Validate parent task if provided
        if (body.parentTask) {
            const parent = await Task.findOne({ _id: body.parentTask, companyId: req.companyId });
            if (!parent) {
                return res.status(400).json({ message: 'Parent task not found' });
            }
        }

        // Validate dependencies
        if (Array.isArray(body.blockedBy) && body.blockedBy.length > 0) {
            const cycleCheck = await checkCircularDependency(null, body.blockedBy, req.companyId);
            if (cycleCheck.hasCycle) {
                return res.status(400).json({ message: cycleCheck.message });
            }
        }

        if (body.status === 'DONE') {
            body.completedAt = new Date();
        }

        const task = await Task.create(body);

        // Record initial creation activity
        await TaskActivity.create({
            task: task._id,
            field: 'status',
            oldValue: null,
            newValue: task.status,
            changedBy: req.user._id,
            companyId: req.companyId
        });

        // Notify assigned users
        if (Array.isArray(task.assignees) && task.assignees.length > 0) {
            const io = req.app.get('io');
            task.assignees.forEach(assigneeId => {
                if (String(assigneeId) !== String(req.user._id)) {
                    NotificationService.createNotification(io, {
                        user: assigneeId,
                        companyId: req.companyId,
                        title: 'New Task Assigned',
                        message: `${req.user.firstName || 'A team member'} assigned you to task ${task.taskKey}: "${task.name}"`,
                        type: 'Action',
                        link: `/projects/${task.module}`
                    }).catch(err => console.error('Notification error:', err));
                }
            });
        }

        const populatedTask = await Task.findById(task._id)
            .populate('assignees', 'firstName lastName email profilePicture')
            .populate('reporter', 'firstName lastName email profilePicture')
            .populate({
                path: 'module',
                select: 'name project',
                populate: { path: 'project', select: 'name' }
            })
            .lean();

        res.status(201).json(populatedTask);
    } catch (error) {
        console.error('[TaskController] createTask error:', error);
        res.status(400).json({ message: error.message });
    }
};

/**
 * @desc Update task with full activity auditing, workflow transitions & circular check
 * @route PUT /api/tasks/:id or PUT /api/projects/tasks/:id
 */
const updateTask = async (req, res) => {
    try {
        const { id } = req.params;
        const currentTask = await Task.findOne({ _id: id, companyId: req.companyId }).lean();

        if (!currentTask) {
            return res.status(404).json({ message: 'Task not found' });
        }

        const updates = { ...req.body };
        delete updates.companyId; // Never overwrite tenant scope

        // Validate dependencies if blockedBy is updated
        if (updates.blockedBy !== undefined) {
            const cycleCheck = await checkCircularDependency(id, updates.blockedBy, req.companyId);
            if (cycleCheck.hasCycle) {
                return res.status(400).json({ message: cycleCheck.message });
            }
        }

        // Apply status rules (DONE completedAt, reopenCount)
        applyTaskWorkflowRules(updates, currentTask);

        const updatedTask = await Task.findOneAndUpdate(
            { _id: id, companyId: req.companyId },
            { $set: updates },
            { new: true, runValidators: true }
        )
            .populate('assignees', 'firstName lastName email profilePicture')
            .populate('reporter', 'firstName lastName email profilePicture')
            .populate('parentTask', '_id name taskKey key status priority')
            .populate('blockedBy', '_id name taskKey key status priority')
            .populate({
                path: 'module',
                select: 'name project',
                populate: { path: 'project', select: 'name' }
            });

        // Record audit activity logs
        await recordTaskActivities({
            taskId: id,
            oldTask: currentTask,
            updates,
            changedBy: req.user._id,
            companyId: req.companyId
        });

        // Notify newly added assignees
        if (Array.isArray(updates.assignees)) {
            const oldAssigneeSet = new Set((currentTask.assignees || []).map(a => String(a)));
            const newAssignees = updates.assignees.filter(a => !oldAssigneeSet.has(String(a)));
            const io = req.app.get('io');

            newAssignees.forEach(assigneeId => {
                if (String(assigneeId) !== String(req.user._id)) {
                    NotificationService.createNotification(io, {
                        user: assigneeId,
                        companyId: req.companyId,
                        title: 'Assigned to Task',
                        message: `${req.user.firstName || 'A team member'} assigned you to task ${updatedTask.taskKey || id}: "${updatedTask.name}"`,
                        type: 'Action',
                        link: `/projects/${updatedTask.module?._id}`
                    }).catch(err => console.error('Notification error:', err));
                }
            });
        }

        res.json(updatedTask);
    } catch (error) {
        console.error('[TaskController] updateTask error:', error);
        res.status(400).json({ message: error.message });
    }
};

/**
 * @desc Delete task with tree cleanup
 * @route DELETE /api/tasks/:id or DELETE /api/projects/tasks/:id
 */
const deleteTask = async (req, res) => {
    try {
        const task = await Task.findOne({ _id: req.params.id, companyId: req.companyId });
        if (!task) return res.status(404).json({ message: 'Task not found' });

        await task.softDelete(req.user._id);
        await softDeleteTaskTree(task._id, req.companyId, req.user._id);

        // Also soft-delete any subtasks
        const subtasks = await Task.find({ parentTask: task._id, companyId: req.companyId });
        for (const sub of subtasks) {
            await sub.softDelete(req.user._id);
            await softDeleteTaskTree(sub._id, req.companyId, req.user._id);
        }

        res.json({ message: 'Task moved to bin' });
    } catch (error) {
        console.error('[TaskController] deleteTask error:', error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc Reorder tasks (Kanban drag & drop ordering)
 * @route POST /api/tasks/reorder
 */
const reorderTasks = async (req, res) => {
    try {
        const { items } = req.body; // Array of { id, order, status }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'Items array is required for reordering' });
        }

        const taskIds = items.map(i => i.id);
        const currentTasks = await Task.find({ _id: { $in: taskIds }, companyId: req.companyId }).lean();
        const currentTaskMap = new Map(currentTasks.map(t => [String(t._id), t]));

        const bulkOps = [];
        const activityOps = [];

        for (const item of items) {
            const current = currentTaskMap.get(String(item.id));
            if (!current) continue;

            const updateFields = { order: Number(item.order) || 0 };
            const statusChanged = item.status && item.status !== current.status;

            if (statusChanged) {
                updateFields.status = item.status;
                if (item.status === 'DONE') {
                    updateFields.completedAt = new Date();
                } else if (current.status === 'DONE') {
                    updateFields.reopenCount = (current.reopenCount || 0) + 1;
                    updateFields.completedAt = null;
                }

                activityOps.push({
                    task: item.id,
                    field: 'status',
                    oldValue: current.status,
                    newValue: item.status,
                    changedBy: req.user._id,
                    companyId: req.companyId
                });
            }

            if (item.module !== undefined) {
                if (item.module === null || item.module === 'UNASSIGNED' || item.module === '') {
                    if (current.module) {
                        updateFields.module = null;
                        activityOps.push({
                            task: item.id,
                            field: 'module',
                            oldValue: current.module,
                            newValue: null,
                            changedBy: req.user._id,
                            companyId: req.companyId
                        });
                    }
                } else {
                    const targetModId = String(item.module?._id || item.module || '');
                    if (targetModId && targetModId !== String(current.module)) {
                        updateFields.module = targetModId;
                        activityOps.push({
                            task: item.id,
                            field: 'module',
                            oldValue: current.module,
                            newValue: targetModId,
                            changedBy: req.user._id,
                            companyId: req.companyId
                        });
                    }
                }
            }

            bulkOps.push({
                updateOne: {
                    filter: { _id: item.id, companyId: req.companyId },
                    update: { $set: updateFields }
                }
            });
        }

        if (bulkOps.length > 0) {
            await Task.bulkWrite(bulkOps);
        }

        if (activityOps.length > 0) {
            await TaskActivity.insertMany(activityOps);
        }

        res.json({ message: 'Tasks reordered successfully' });
    } catch (error) {
        console.error('[TaskController] reorderTasks error:', error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc Get subtasks of a task
 * @route GET /api/tasks/:taskId/subtasks
 */
const getSubtasks = async (req, res) => {
    try {
        const { taskId } = req.params;
        const parent = await Task.findOne({ _id: taskId, companyId: req.companyId }).lean();
        if (!parent) return res.status(404).json({ message: 'Parent task not found' });

        const subtasks = await Task.find({
            parentTask: taskId,
            companyId: req.companyId,
            isDeleted: { $ne: true }
        })
            .populate('assignees', 'firstName lastName profilePicture')
            .sort({ order: 1, createdAt: 1 })
            .lean();

        const completed = subtasks.filter(s => s.status === 'DONE').length;

        res.json({
            subtasks,
            total: subtasks.length,
            completed
        });
    } catch (error) {
        console.error('[TaskController] getSubtasks error:', error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc Create a subtask under a parent task
 * @route POST /api/tasks/:taskId/subtasks
 */
const createSubtask = async (req, res) => {
    try {
        const { taskId } = req.params;
        const parent = await Task.findOne({ _id: taskId, companyId: req.companyId });
        if (!parent) return res.status(404).json({ message: 'Parent task not found' });

        const body = { ...req.body };
        body.companyId = req.companyId;
        body.parentTask = taskId;
        body.module = parent.module; // Inherit module from parent

        if (!body.name || !body.name.trim()) {
            return res.status(400).json({ message: 'Subtask title is required' });
        }

        if (!body.reporter) {
            body.reporter = req.user._id;
        }

        const nextKey = await generateNextTaskKey(req.companyId, parent.module);
        body.taskKey = nextKey;
        body.key = nextKey;

        const subtask = await Task.create(body);

        await TaskActivity.create({
            task: taskId,
            field: 'parentTask',
            oldValue: null,
            newValue: `Subtask created: ${subtask.taskKey} - ${subtask.name}`,
            changedBy: req.user._id,
            companyId: req.companyId
        });

        const populated = await Task.findById(subtask._id)
            .populate('assignees', 'firstName lastName profilePicture')
            .lean();

        res.status(201).json(populated);
    } catch (error) {
        console.error('[TaskController] createSubtask error:', error);
        res.status(400).json({ message: error.message });
    }
};

/**
 * @desc Get task comments
 * @route GET /api/tasks/:taskId/comments
 */
const getComments = async (req, res) => {
    try {
        const { taskId } = req.params;
        const comments = await TaskComment.find({
            task: taskId,
            companyId: req.companyId,
            isDeleted: { $ne: true }
        })
            .populate('user', 'firstName lastName email profilePicture')
            .populate('mentions', 'firstName lastName email')
            .sort({ createdAt: 1 })
            .lean();

        res.json(comments);
    } catch (error) {
        console.error('[TaskController] getComments error:', error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc Create task comment
 * @route POST /api/tasks/:taskId/comments
 */
const createComment = async (req, res) => {
    try {
        const { taskId } = req.params;
        const { message, mentions = [], attachments = [] } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ message: 'Comment message is required' });
        }

        const task = await Task.findOne({ _id: taskId, companyId: req.companyId });
        if (!task) return res.status(404).json({ message: 'Task not found' });

        const comment = await TaskComment.create({
            task: taskId,
            user: req.user._id,
            message: message.trim(),
            mentions,
            attachments,
            companyId: req.companyId
        });

        // Notify mentioned users
        if (Array.isArray(mentions) && mentions.length > 0) {
            const io = req.app.get('io');
            mentions.forEach(mentionUserId => {
                if (String(mentionUserId) !== String(req.user._id)) {
                    NotificationService.createNotification(io, {
                        user: mentionUserId,
                        companyId: req.companyId,
                        title: 'Mentioned in Task Comment',
                        message: `${req.user.firstName || 'A team member'} mentioned you on task ${task.taskKey || task.name}: "${message.slice(0, 100)}"`,
                        type: 'Info',
                        link: `/projects/${task.module}`
                    }).catch(err => console.error('Mention notification error:', err));
                }
            });
        }

        const populated = await TaskComment.findById(comment._id)
            .populate('user', 'firstName lastName email profilePicture')
            .populate('mentions', 'firstName lastName email')
            .lean();

        res.status(201).json(populated);
    } catch (error) {
        console.error('[TaskController] createComment error:', error);
        res.status(400).json({ message: error.message });
    }
};

/**
 * @desc Update task comment (only author or admin)
 * @route PUT /api/tasks/:taskId/comments/:commentId
 */
const updateComment = async (req, res) => {
    try {
        const { taskId, commentId } = req.params;
        const { message } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ message: 'Comment message is required' });
        }

        const comment = await TaskComment.findOne({
            _id: commentId,
            task: taskId,
            companyId: req.companyId
        });

        if (!comment) return res.status(404).json({ message: 'Comment not found' });

        const isAuthor = String(comment.user) === String(req.user._id);
        const isAdmin = isAdminOrManager(req.user);

        if (!isAuthor && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized to edit this comment' });
        }

        comment.message = message.trim();
        await comment.save();

        const populated = await TaskComment.findById(comment._id)
            .populate('user', 'firstName lastName email profilePicture')
            .populate('mentions', 'firstName lastName email')
            .lean();

        res.json(populated);
    } catch (error) {
        console.error('[TaskController] updateComment error:', error);
        res.status(400).json({ message: error.message });
    }
};

/**
 * @desc Delete task comment
 * @route DELETE /api/tasks/:taskId/comments/:commentId
 */
const deleteComment = async (req, res) => {
    try {
        const { taskId, commentId } = req.params;
        const comment = await TaskComment.findOne({
            _id: commentId,
            task: taskId,
            companyId: req.companyId
        });

        if (!comment) return res.status(404).json({ message: 'Comment not found' });

        const isAuthor = String(comment.user) === String(req.user._id);
        const isAdmin = isAdminOrManager(req.user);

        if (!isAuthor && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized to delete this comment' });
        }

        await comment.softDelete(req.user._id);

        res.json({ message: 'Comment deleted' });
    } catch (error) {
        console.error('[TaskController] deleteComment error:', error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc Get activity history for a task
 * @route GET /api/tasks/:taskId/activity
 */
const getTaskActivity = async (req, res) => {
    try {
        const { taskId } = req.params;
        const activities = await TaskActivity.find({
            task: taskId,
            companyId: req.companyId
        })
            .populate('changedBy', 'firstName lastName email profilePicture')
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        res.json(activities);
    } catch (error) {
        console.error('[TaskController] getTaskActivity error:', error);
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getTasks,
    getTaskById,
    createTask,
    updateTask,
    deleteTask,
    reorderTasks,
    getSubtasks,
    createSubtask,
    getComments,
    createComment,
    updateComment,
    deleteComment,
    getTaskActivity
};
