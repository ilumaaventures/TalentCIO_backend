const mongoose = require('mongoose');
const Project = require('../project/project.model');
const Module = require('../task/module.model');
const Task = require('../task/task.model');
const TaskActivity = require('../task/taskActivity.model');
const WorkLog = require('../timesheet/workLog.model');
const Discussion = require('../discussion/discussion.model');
const User = require('../user/user.model');

const isAdminOrManager = (user) => {
    const roles = Array.isArray(user?.roles) ? user.roles : [];
    return roles.some((r) => {
        const name = typeof r === 'string' ? r : r?.name;
        const lower = String(name || '').toLowerCase();
        return lower === 'admin' || lower === 'system admin' || lower === 'super admin' || r?.isSystem === true;
    }) || user?.permissions?.includes('*') || user?.permissions?.includes('admin');
};

/**
 * Helper to check access permission for project performance
 */
const canAccessProject = async (req, project) => {
    if (isAdminOrManager(req.user) || (req.user.permissions || []).includes('project.read')) {
        return true;
    }
    const userIdStr = String(req.user._id);
    if (project.manager && String(project.manager._id || project.manager) === userIdStr) {
        return true;
    }
    if (Array.isArray(project.members) && project.members.some(m => String(m._id || m) === userIdStr)) {
        return true;
    }
    // Check if user has direct report in project
    const directReports = await User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('_id').lean();
    const reportIdStrs = new Set(directReports.map(d => String(d._id)));
    if (project.manager && reportIdStrs.has(String(project.manager._id || project.manager))) {
        return true;
    }
    if (Array.isArray(project.members) && project.members.some(m => reportIdStrs.has(String(m._id || m)))) {
        return true;
    }
    return false;
};

/**
 * @desc Get comprehensive project performance metrics
 * @route GET /api/projects/:id/performance
 */
const getProjectPerformance = async (req, res) => {
    try {
        const { id: projectId, userId: paramUserId } = req.params;
        const targetUserId = paramUserId || req.query?.userId || null;
        const companyId = new mongoose.Types.ObjectId(req.companyId);

        const project = await Project.findOne({ _id: projectId, companyId })
            .populate('manager', 'firstName lastName email profilePicture')
            .populate('members', 'firstName lastName email profilePicture')
            .lean();

        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        const hasAccess = await canAccessProject(req, project);
        if (!hasAccess) {
            return res.status(403).json({ message: 'Not authorized to view performance for this project' });
        }

        const modules = await Module.find({ project: projectId, companyId }).select('_id name').lean();
        const moduleIds = modules.map(m => m._id);

        const taskQuery = {
            module: { $in: moduleIds },
            companyId,
            isDeleted: { $ne: true }
        };
        if (targetUserId) {
            taskQuery.assignees = targetUserId;
        }

        // Fetch all project tasks
        const tasks = await Task.find(taskQuery)
            .populate('assignees', 'firstName lastName email profilePicture')
            .populate('reporter', 'firstName lastName email profilePicture')
            .populate('blockedBy', '_id taskKey name status priority')
            .lean();

        const taskIds = tasks.map(t => t._id);

        // Summary calculations
        let completedCount = 0;
        let inProgressCount = 0;
        let reviewCount = 0;
        let todoCount = 0;
        let blockedCount = 0;
        let overdueCount = 0;
        let totalEstimatedHours = 0;
        let tasksWithEstimatesCount = 0;
        let tasksWithoutEstimatesCount = 0;
        let totalStoryPoints = 0;
        let completedStoryPoints = 0;
        let tasksWithStoryPointsCount = 0;

        const now = new Date();

        tasks.forEach(t => {
            const status = t.status || 'TODO';
            if (status === 'DONE') completedCount++;
            else if (status === 'IN_PROGRESS') inProgressCount++;
            else if (status === 'REVIEW') reviewCount++;
            else if (status === 'BLOCKED') blockedCount++;
            else todoCount++;

            if (t.dueDate && new Date(t.dueDate) < now && status !== 'DONE') {
                overdueCount++;
            }

            if (t.estimatedHours && t.estimatedHours > 0) {
                totalEstimatedHours += Number(t.estimatedHours);
                tasksWithEstimatesCount++;
            } else {
                tasksWithoutEstimatesCount++;
            }

            if (t.storyPoints !== null && t.storyPoints !== undefined) {
                totalStoryPoints += Number(t.storyPoints);
                tasksWithStoryPointsCount++;
                if (status === 'DONE') {
                    completedStoryPoints += Number(t.storyPoints);
                }
            }
        });

        const totalTasks = tasks.length;
        const completionRate = totalTasks > 0 ? Number(((completedCount / totalTasks) * 100).toFixed(2)) : 0;

        // Worklog hours aggregation
        const worklogQuery = {
            companyId,
            isDeleted: { $ne: true },
            $or: [
                { project: projectId },
                ...(taskIds.length > 0 ? [{ task: { $in: taskIds } }] : [])
            ]
        };
        if (targetUserId) {
            worklogQuery.user = targetUserId;
        }

        const worklogs = await WorkLog.find(worklogQuery).select('user hours date status').lean();

        let totalLoggedHours = 0;
        let approvedLoggedHours = 0;
        const userLoggedHoursMap = new Map();

        worklogs.forEach(w => {
            const h = Number(w.hours) || 0;
            totalLoggedHours += h;
            if (w.status === 'APPROVED') {
                approvedLoggedHours += h;
            }
            if (w.user) {
                const uStr = String(w.user);
                userLoggedHoursMap.set(uStr, (userLoggedHoursMap.get(uStr) || 0) + h);
            }
        });

        totalLoggedHours = Number(totalLoggedHours.toFixed(2));
        approvedLoggedHours = Number(approvedLoggedHours.toFixed(2));
        const remainingHours = Number(Math.max(0, totalEstimatedHours - totalLoggedHours).toFixed(2));

        // 1. Velocity (completed tasks & story points per week)
        const velocityMatch = {
            module: { $in: moduleIds },
            companyId,
            status: 'DONE',
            isDeleted: { $ne: true },
            completedAt: { $ne: null }
        };
        if (targetUserId) {
            velocityMatch.assignees = new mongoose.Types.ObjectId(targetUserId);
        }

        const velocityAggregation = await Task.aggregate([
            {
                $match: velocityMatch
            },
            {
                $group: {
                    _id: {
                        year: { $isoWeekYear: '$completedAt' },
                        week: { $isoWeek: '$completedAt' }
                    },
                    weekStartDate: { $min: '$completedAt' },
                    tasksCompleted: { $sum: 1 },
                    storyPointsCompleted: { $sum: { $ifNull: ['$storyPoints', 0] } }
                }
            },
            { $sort: { '_id.year': 1, '_id.week': 1 } }
        ]);

        const velocity = velocityAggregation.map(v => {
            const dateStr = v.weekStartDate ? new Date(v.weekStartDate).toISOString().slice(0, 10) : `W${v._id.week}`;
            return {
                week: dateStr,
                weekNumber: v._id.week,
                year: v._id.year,
                tasksCompleted: v.tasksCompleted,
                storyPointsCompleted: v.storyPointsCompleted
            };
        });

        // 2. On-Time Completion
        let completedWithDueDate = 0;
        let onTimeCount = 0;

        tasks.filter(t => t.status === 'DONE').forEach(t => {
            if (t.dueDate) {
                completedWithDueDate++;
                const compDate = t.completedAt ? new Date(t.completedAt) : new Date(t.updatedAt || t.createdAt);
                if (compDate <= new Date(t.dueDate)) {
                    onTimeCount++;
                }
            }
        });

        const onTimeRate = completedWithDueDate > 0
            ? Number(((onTimeCount / completedWithDueDate) * 100).toFixed(2))
            : null;

        const onTimeCompletion = {
            completed: completedCount,
            withDueDate: completedWithDueDate,
            onTime: onTimeCount,
            rate: onTimeRate,
            withoutDueDate: completedCount - completedWithDueDate
        };

        // 3. Overdue tasks list
        const overdue = tasks
            .filter(t => t.dueDate && new Date(t.dueDate) < now && t.status !== 'DONE')
            .map(t => ({
                _id: t._id,
                taskKey: t.taskKey || t.key,
                name: t.name,
                status: t.status,
                priority: t.priority,
                dueDate: t.dueDate,
                assignees: t.assignees,
                estimatedHours: t.estimatedHours
            }));

        // 4. Blocked tasks list
        const blocked = tasks
            .filter(t => t.status === 'BLOCKED' || (Array.isArray(t.blockedBy) && t.blockedBy.some(b => b.status !== 'DONE')))
            .map(t => ({
                _id: t._id,
                taskKey: t.taskKey || t.key,
                name: t.name,
                status: t.status,
                priority: t.priority,
                assignees: t.assignees,
                blockedBy: t.blockedBy
            }));

        // 5. Workload distribution per project member
        const memberMap = new Map();
        (project.members || []).forEach(m => {
            memberMap.set(String(m._id), {
                user: m,
                openTasks: 0,
                completedTasks: 0,
                estimatedHours: 0,
                loggedHours: userLoggedHoursMap.get(String(m._id)) || 0
            });
        });

        tasks.forEach(t => {
            const isDone = t.status === 'DONE';
            (t.assignees || []).forEach(a => {
                const aId = String(a._id);
                if (!memberMap.has(aId)) {
                    memberMap.set(aId, {
                        user: a,
                        openTasks: 0,
                        completedTasks: 0,
                        estimatedHours: 0,
                        loggedHours: userLoggedHoursMap.get(aId) || 0
                    });
                }
                const entry = memberMap.get(aId);
                if (isDone) entry.completedTasks++;
                else entry.openTasks++;
                entry.estimatedHours += Number(t.estimatedHours || 0);
            });
        });

        const workload = Array.from(memberMap.values()).map(w => ({
            ...w,
            estimatedHours: Number(w.estimatedHours.toFixed(2)),
            loggedHours: Number(w.loggedHours.toFixed(2))
        }));

        // 6. Cycle Time & Rework calculation via TaskActivity
        const activities = await TaskActivity.find({
            task: { $in: taskIds },
            companyId,
            field: 'status'
        })
            .sort({ createdAt: 1 })
            .lean();

        // Calculate cycle times per task (first IN_PROGRESS to final DONE)
        const taskStatusTransitions = new Map();
        activities.forEach(a => {
            const tId = String(a.task);
            if (!taskStatusTransitions.has(tId)) {
                taskStatusTransitions.set(tId, []);
            }
            taskStatusTransitions.get(tId).push({
                oldValue: a.oldValue,
                newValue: a.newValue,
                date: new Date(a.createdAt)
            });
        });

        const cycleTimesInDays = [];
        let totalReopenedTasks = 0;

        tasks.forEach(t => {
            if (t.reopenCount && t.reopenCount > 0) {
                totalReopenedTasks++;
            }
            const transitions = taskStatusTransitions.get(String(t._id)) || [];
            const firstInProgress = transitions.find(tr => tr.newValue === 'IN_PROGRESS');
            const doneTransition = transitions.find(tr => tr.newValue === 'DONE') || (t.completedAt ? { date: new Date(t.completedAt) } : null);

            if (firstInProgress && doneTransition && doneTransition.date >= firstInProgress.date) {
                const diffDays = (doneTransition.date.getTime() - firstInProgress.date.getTime()) / (1000 * 60 * 60 * 24);
                cycleTimesInDays.push(diffDays);
            }
        });

        const avgCycleTimeDays = cycleTimesInDays.length > 0
            ? Number((cycleTimesInDays.reduce((a, b) => a + b, 0) / cycleTimesInDays.length).toFixed(1))
            : null;

        const reworkRate = completedCount > 0
            ? Number(((totalReopenedTasks / completedCount) * 100).toFixed(2))
            : 0;

        // 7. Burndown (Remaining estimated hours over time)
        // Generate daily intervals between project startDate (or earliest task) and now/dueDate
        const projectStart = project.startDate ? new Date(project.startDate) : (tasks.length > 0 ? new Date(Math.min(...tasks.map(t => new Date(t.createdAt).getTime()))) : new Date());
        const projectDue = project.dueDate ? new Date(project.dueDate) : new Date(projectStart.getTime() + 30 * 24 * 60 * 60 * 1000);

        const burndownPoints = [];
        const daysSpan = Math.max(1, Math.min(60, Math.ceil((now.getTime() - projectStart.getTime()) / (1000 * 60 * 60 * 24))));
        const stepDays = daysSpan > 30 ? 3 : 1;

        for (let d = 0; d <= daysSpan; d += stepDays) {
            const checkDate = new Date(projectStart.getTime() + d * 24 * 60 * 60 * 1000);
            if (checkDate > now) break;

            // Ideal burn line
            const totalProjectDays = Math.max(1, (projectDue.getTime() - projectStart.getTime()) / (1000 * 60 * 60 * 24));
            const elapsedDays = Math.max(0, (checkDate.getTime() - projectStart.getTime()) / (1000 * 60 * 60 * 24));
            const idealRemaining = Number(Math.max(0, totalEstimatedHours * (1 - (elapsedDays / totalProjectDays))).toFixed(1));

            // Actual remaining estimate on checkDate
            let actualRemaining = 0;
            tasks.forEach(t => {
                const createdTime = new Date(t.createdAt).getTime();
                if (createdTime <= checkDate.getTime()) {
                    const compTime = t.completedAt ? new Date(t.completedAt).getTime() : null;
                    const wasCompletedOnDate = compTime && compTime <= checkDate.getTime();
                    if (!wasCompletedOnDate) {
                        actualRemaining += Number(t.estimatedHours || 0);
                    }
                }
            });

            burndownPoints.push({
                date: checkDate.toISOString().slice(0, 10),
                remainingEstimatedHours: Number(actualRemaining.toFixed(1)),
                idealEstimatedHours: idealRemaining
            });
        }

        // Estimation accuracy
        const estimationRatio = totalEstimatedHours > 0
            ? Number((totalLoggedHours / totalEstimatedHours).toFixed(2))
            : null;

        res.json({
            summary: {
                totalTasks,
                completedTasks: completedCount,
                inProgressTasks: inProgressCount,
                reviewTasks: reviewCount,
                todoTasks: todoCount,
                blockedTasks: blockedCount,
                overdueTasks: overdueCount,
                completionRate,
                estimatedHours: totalEstimatedHours,
                loggedHours: totalLoggedHours,
                approvedLoggedHours,
                remainingHours,
                tasksWithEstimatesCount,
                tasksWithoutEstimatesCount,
                storyPoints: {
                    total: totalStoryPoints,
                    completed: completedStoryPoints,
                    completionRate: totalStoryPoints > 0 ? Number(((completedStoryPoints / totalStoryPoints) * 100).toFixed(2)) : 0,
                    tasksWithStoryPointsCount
                }
            },
            velocity,
            burndown: burndownPoints,
            onTimeCompletion,
            overdue,
            blocked,
            workload,
            cycleTime: {
                averageDays: avgCycleTimeDays,
                formula: 'Elapsed time from first IN_PROGRESS transition to DONE transition',
                tasksAnalyzed: cycleTimesInDays.length
            },
            rework: {
                reopenedTasks: totalReopenedTasks,
                reworkRate,
                formula: 'Tasks with reopenCount > 0 / Total completed tasks * 100'
            },
            estimationAccuracy: {
                estimatedHours: totalEstimatedHours,
                loggedHours: totalLoggedHours,
                ratio: estimationRatio,
                formula: 'Total logged hours / Total estimated hours'
            },
            throughput: {
                totalCompleted: completedCount,
                weeklyRate: velocity.length > 0 ? Number((completedCount / velocity.length).toFixed(1)) : completedCount
            }
        });
    } catch (error) {
        console.error('[PerformanceController] getProjectPerformance error:', error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * @desc Get project performance metrics scoped to a specific project member
 * @route GET /api/projects/:id/performance/:userId
 */
const getProjectMemberPerformance = async (req, res) => {
    return getProjectPerformance(req, res);
};

/**
 * @desc Get cross-project employee performance
 * @route GET /api/users/:id/performance?range=30d
 */
const getEmployeePerformance = async (req, res) => {
    try {
        const { id: userId } = req.params;
        const companyId = new mongoose.Types.ObjectId(req.companyId);
        const range = req.query.range || '30d'; // 7d, 30d, 90d

        // Check permission: Own profile, direct report, or Admin
        const isSelf = String(req.user._id) === String(userId);
        const isAdmin = isAdminOrManager(req.user) || (req.user.permissions || []).includes('project.read');
        let isManager = false;

        if (!isSelf && !isAdmin) {
            const directReport = await User.findOne({ _id: userId, reportingManagers: req.user._id, companyId }).select('_id');
            if (directReport) isManager = true;
        }

        if (!isSelf && !isAdmin && !isManager) {
            return res.status(403).json({ message: 'Not authorized to view performance for this user' });
        }

        const employee = await User.findOne({ _id: userId, companyId })
            .select('firstName lastName email profilePicture department')
            .lean();
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        // Calculate date cutoff
        let days = 30;
        if (range === '7d') days = 7;
        else if (range === '90d') days = 90;
        else if (range === 'all' || range === 'all_time') days = 3650;

        const cutoffDate = (range === 'all' || range === 'all_time')
            ? new Date(0)
            : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // Fetch all projects where user is explicitly allocated (manager or member)
        const allocatedProjects = await Project.find({
            companyId,
            isDeleted: { $ne: true },
            $or: [
                { members: userId },
                { manager: userId }
            ]
        })
            .populate('client', 'name')
            .select('name status client manager members startDate dueDate estimatedHours isActive')
            .lean();

        // Find all tasks assigned to user created or updated within range
        const tasks = await Task.find({
            assignees: userId,
            companyId,
            isDeleted: { $ne: true },
            updatedAt: { $gte: cutoffDate }
        })
            .populate({
                path: 'module',
                select: 'name project',
                populate: { path: 'project', select: 'name status client' }
            })
            .lean();

        const completedTasks = tasks.filter(t => t.status === 'DONE' && (!t.completedAt || new Date(t.completedAt) >= cutoffDate));
        const totalAssigned = tasks.length;
        const totalCompleted = completedTasks.length;

        // Worklogs in date range with project details
        const worklogs = await WorkLog.find({
            user: userId,
            companyId,
            isDeleted: { $ne: true },
            date: { $gte: cutoffDate }
        })
            .populate('project', 'name status client')
            .populate('task', 'name')
            .sort({ date: -1 })
            .lean();

        const totalLoggedHours = Number(worklogs.reduce((sum, w) => sum + (Number(w.hours) || 0), 0).toFixed(2));
        const totalEstimatedHours = Number(tasks.reduce((sum, t) => sum + (Number(t.estimatedHours) || 0), 0).toFixed(2));
        const estimationRatio = totalEstimatedHours > 0 ? Number((totalLoggedHours / totalEstimatedHours).toFixed(2)) : null;

        // Discussions created & completed in range
        const userDiscussions = await Discussion.find({
            companyId,
            isDeleted: { $ne: true },
            $or: [
                { createdBy: userId },
                { supervisor: userId },
                { participants: userId }
            ],
            createdAt: { $gte: cutoffDate }
        }).select('status createdBy supervisor participants').lean();

        const discussionsCreated = userDiscussions.filter(d => String(d.createdBy) === String(userId)).length;
        const discussionsCompleted = userDiscussions.filter(d =>
            ['mark as complete', 'completed', 'complete'].includes(String(d.status || '').toLowerCase())
        ).length;

        // Breakdown per project
        const projectMap = new Map();

        allocatedProjects.forEach(p => {
            const pId = String(p._id);
            const isMgr = String(p.manager?._id || p.manager) === String(userId);
            projectMap.set(pId, {
                _id: pId,
                name: p.name || 'Untitled Project',
                status: p.status || (p.isActive !== false ? 'Active' : 'Completed'),
                clientName: p.client?.name || '-',
                role: isMgr ? 'Project Manager' : 'Team Member',
                isAllocated: true,
                loggedHours: 0,
                estimatedHours: 0,
                tasksAssigned: 0,
                tasksCompleted: 0
            });
        });

        tasks.forEach(t => {
            const proj = t.module?.project;
            const projId = proj?._id || proj;
            if (projId) {
                const pId = String(projId);
                if (!projectMap.has(pId)) {
                    projectMap.set(pId, {
                        _id: pId,
                        name: proj?.name || 'Project',
                        status: proj?.status || 'Active',
                        clientName: '-',
                        role: 'Assignee',
                        isAllocated: false,
                        loggedHours: 0,
                        estimatedHours: 0,
                        tasksAssigned: 0,
                        tasksCompleted: 0
                    });
                }
                const entry = projectMap.get(pId);
                entry.tasksAssigned++;
                if (t.status === 'DONE') entry.tasksCompleted++;
                entry.estimatedHours += Number(t.estimatedHours || 0);
            }
        });

        worklogs.forEach(w => {
            const proj = w.project;
            const projId = proj?._id || proj;
            if (projId) {
                const pId = String(projId);
                if (!projectMap.has(pId)) {
                    projectMap.set(pId, {
                        _id: pId,
                        name: proj?.name || 'Project',
                        status: proj?.status || 'Active',
                        clientName: '-',
                        role: 'Contributor',
                        isAllocated: false,
                        loggedHours: 0,
                        estimatedHours: 0,
                        tasksAssigned: 0,
                        tasksCompleted: 0
                    });
                }
                const entry = projectMap.get(pId);
                entry.loggedHours = Number((entry.loggedHours + (Number(w.hours) || 0)).toFixed(2));
            }
        });

        const projectBreakdown = Array.from(projectMap.values()).map(p => ({
            ...p,
            loggedHours: Number(p.loggedHours.toFixed(2)),
            estimatedHours: Number(p.estimatedHours.toFixed(2))
        })).sort((a, b) => b.loggedHours - a.loggedHours || b.tasksAssigned - a.tasksAssigned);

        // Timing & On-time completion
        let completedWithDueDate = 0;
        let onTimeCount = 0;
        let reopenedCount = 0;

        completedTasks.forEach(t => {
            if (t.reopenCount && t.reopenCount > 0) reopenedCount++;
            if (t.dueDate) {
                completedWithDueDate++;
                const cDate = t.completedAt ? new Date(t.completedAt) : new Date(t.updatedAt);
                if (cDate <= new Date(t.dueDate)) onTimeCount++;
            }
        });

        const onTimeRate = completedWithDueDate > 0
            ? Number(((onTimeCount / completedWithDueDate) * 100).toFixed(2))
            : null;

        // Cycle time calculation
        const activities = await TaskActivity.find({
            task: { $in: completedTasks.map(t => t._id) },
            companyId,
            field: 'status'
        }).sort({ createdAt: 1 }).lean();

        const cycleTimes = [];
        completedTasks.forEach(t => {
            const taskActs = activities.filter(a => String(a.task) === String(t._id));
            const inProg = taskActs.find(a => a.newValue === 'IN_PROGRESS');
            const done = taskActs.find(a => a.newValue === 'DONE') || (t.completedAt ? { createdAt: t.completedAt } : null);
            if (inProg && done) {
                const diffDays = (new Date(done.createdAt).getTime() - new Date(inProg.createdAt).getTime()) / (1000 * 60 * 60 * 24);
                if (diffDays >= 0) cycleTimes.push(diffDays);
            }
        });

        const avgCycleTimeDays = cycleTimes.length > 0
            ? Number((cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length).toFixed(1))
            : null;

        const reworkRate = totalCompleted > 0
            ? Number(((reopenedCount / totalCompleted) * 100).toFixed(2))
            : 0;

        // Time-series trend (weekly or daily buckets)
        const bucketIntervalDays = days <= 14 ? 1 : 7;
        const trendMap = new Map();

        for (let i = 0; i < Math.min(days, 90); i += bucketIntervalDays) {
            const bStart = new Date(cutoffDate.getTime() + i * 24 * 60 * 60 * 1000);
            const bEnd = new Date(bStart.getTime() + bucketIntervalDays * 24 * 60 * 60 * 1000);
            const key = bStart.toISOString().slice(0, 10);
            trendMap.set(key, {
                date: key,
                tasksAssigned: 0,
                tasksCompleted: 0,
                loggedHours: 0,
                estimatedHours: 0,
                bStart,
                bEnd
            });
        }

        tasks.forEach(t => {
            const cDate = new Date(t.createdAt);
            for (const [, bucket] of trendMap.entries()) {
                if (cDate >= bucket.bStart && cDate < bucket.bEnd) {
                    bucket.tasksAssigned++;
                    bucket.estimatedHours += Number(t.estimatedHours || 0);
                    break;
                }
            }
            if (t.status === 'DONE' && t.completedAt) {
                const compDate = new Date(t.completedAt);
                for (const [, bucket] of trendMap.entries()) {
                    if (compDate >= bucket.bStart && compDate < bucket.bEnd) {
                        bucket.tasksCompleted++;
                        break;
                    }
                }
            }
        });

        worklogs.forEach(w => {
            const wDate = new Date(w.date);
            for (const [, bucket] of trendMap.entries()) {
                if (wDate >= bucket.bStart && wDate < bucket.bEnd) {
                    bucket.loggedHours += Number(w.hours || 0);
                    break;
                }
            }
        });

        const trend = Array.from(trendMap.values()).map(b => ({
            date: b.date,
            tasksAssigned: b.tasksAssigned,
            tasksCompleted: b.tasksCompleted,
            loggedHours: Number(b.loggedHours.toFixed(1)),
            estimatedHours: Number(b.estimatedHours.toFixed(1))
        }));

        res.json({
            user: employee,
            range,
            delivery: {
                tasksAssigned: totalAssigned,
                tasksCompleted: totalCompleted,
                throughput: totalCompleted,
                averageCycleTimeDays: avgCycleTimeDays
            },
            timing: {
                onTimeCompletionRate: onTimeRate,
                onTimeCount,
                completedWithDueDate,
                averageCycleTimeDays: avgCycleTimeDays
            },
            estimation: {
                estimatedHours: totalEstimatedHours,
                loggedHours: totalLoggedHours,
                ratio: estimationRatio
            },
            rework: {
                reopenedTasks: reopenedCount,
                reworkRate
            },
            discussions: {
                created: discussionsCreated,
                completed: discussionsCompleted
            },
            trend,
            projectsAllocated: {
                totalAllocated: allocatedProjects.length,
                totalActiveAllocated: allocatedProjects.filter(p => p.status === 'Active' || p.isActive !== false).length,
                list: projectBreakdown
            },
            recentLogs: worklogs.slice(0, 20).map(w => ({
                _id: w._id,
                date: w.date,
                hours: Number(w.hours || 0),
                description: w.description || '',
                projectName: w.project?.name || 'Project',
                taskTitle: w.task?.name || 'General Task'
            }))
        });
    } catch (error) {
        console.error('[PerformanceController] getEmployeePerformance error:', error);
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getProjectPerformance,
    getProjectMemberPerformance,
    getEmployeePerformance
};
