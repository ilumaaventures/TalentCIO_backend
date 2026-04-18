const Timesheet = require('../models/Timesheet');
const Project = require('../models/Project');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const { startOfMonth, endOfMonth, startOfWeek, endOfWeek, format, startOfDay, endOfDay, addWeeks, subWeeks } = require('date-fns');
const WorkLog = require('../models/WorkLog');
const Task = require('../models/Task');
const Module = require('../models/Module');
const NotificationService = require('../services/notificationService');

const getTimesheetPeriodIdForDate = (dateValue, cycle = 'Monthly') => {
    const date = new Date(dateValue);
    if (cycle === 'Weekly') return format(date, "yyyy-'W'II");
    if (cycle === 'Daily') return format(date, 'yyyy-MM-dd');
    return format(date, 'yyyy-MM');
};

// @desc    Get Current Month Timesheet
// @route   GET /api/timesheet/current
// @access  Private
const getCurrentTimesheet = async (req, res) => {
    try {
        const currentMonth = req.query.month || format(new Date(), 'yyyy-MM');

        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated (req.user missing)' });
        }

        let timesheet = await Timesheet.findOne({
            user: req.user._id,
            month: currentMonth,
            companyId: req.companyId
        }).lean();

        if (!timesheet) {
            // Create a draft if it doesn't exist
            timesheet = await Timesheet.create({
                user: req.user._id,
                month: currentMonth,
                companyId: req.companyId,
                status: 'DRAFT',
                rejectionReason: ''
            });
        }

        try {
            fullUser = await User.findById(req.user._id)
                .select('firstName lastName email employeeCode joiningDate')
                .populate('reportingManagers', 'firstName lastName email')
                .lean();
        } catch (err) {
            console.error('Error populating user details:', err);
            fullUser = {
                firstName: req.user.firstName,
                lastName: req.user.lastName,
                email: req.user.email,
                employeeCode: req.user.employeeCode
            };
        }

        // Fetch WorkLogs for this period based on cycle
        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        let start, end;

        if (cycle === 'Weekly') {
            if (currentMonth.includes('-W')) {
                const [year, weekStr] = currentMonth.split('-W');
                const weekNum = parseInt(weekStr);
                const firstDayOfYear = new Date(parseInt(year), 0, 1);
                const daysToFirstMonday = (8 - firstDayOfYear.getDay()) % 7;
                const firstMonday = new Date(parseInt(year), 0, 1 + daysToFirstMonday);
                start = startOfWeek(addWeeks(firstMonday, weekNum - 1));
                end = endOfWeek(start);
            } else {
                // Fallback context
                const date = new Date(currentMonth + '-01');
                start = startOfWeek(date);
                end = endOfWeek(date);
            }
        } else if (cycle === 'Daily') {
            start = startOfDay(new Date(currentMonth));
            end = endOfDay(start);
        } else {
            // Monthly
            const [year, month] = currentMonth.split('-');
            const date = new Date(parseInt(year), parseInt(month) - 1, 1);
            start = startOfMonth(date);
            end = endOfMonth(date);
        }

        const [workLogs, attendance] = await Promise.all([
            WorkLog.find({
                user: req.user._id,
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            }).populate({
                path: 'task',
                select: 'name module',
                populate: {
                    path: 'module',
                    select: 'name project',
                    populate: { path: 'project', select: 'name client' }
                }
            }).sort({ date: 1 }).lean(),
            Attendance.find({
                user: req.user._id,
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            }).select('date clockInIST clockOutIST duration clockIn clockOut').lean()
        ]);

        const entries = workLogs.map(log => ({
            _id: log._id,
            date: log.date,
            project: log.task?.module?.project || { name: 'Unknown Project' },
            module: log.task?.module,
            task: log.task,
            taskName: log.task?.name,
            hours: log.hours,
            description: log.description,
            status: log.status,
            rejectionReason: log.rejectionReason
        }));

        res.json({
            ...(timesheet || {}),
            userDetails: fullUser,
            user: fullUser,
            entries,
            attendanceLog: attendance
        });
    } catch (error) {
        console.error('getCurrentTimesheet Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Add Entry to Timesheet
// @route   POST /api/timesheet/entry
// @access  Private
const addEntry = async (req, res) => {
    const { date: entryDate, hours, description, projectId, moduleId, taskId, userId } = req.body;

    try {
        // 1. Resolve Target User
        let targetUserId = req.user._id;
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || 
          req.user.permissions?.includes('timesheet.create') ||
          req.user.permissions?.includes('timesheet.update_others');

        if (userId && isAdmin) {
            targetUserId = userId;
        }

        // Validate Date and other required fields
        if (!entryDate || !hours || !projectId || !taskId) {
            return res.status(400).json({ message: 'Date, Project, Task, and Hours are required' });
        }

        // Check for Existing Timesheet Logic
        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = getTimesheetPeriodIdForDate(entryDate, cycle);

        const timesheet = await Timesheet.findOne({
            user: targetUserId,
            month: periodId,
            companyId: req.companyId
        });

        if (timesheet && (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED')) {
            return res.status(400).json({ message: 'Cannot add entries to a submitted or approved timesheet.' });
        }

        // Check Joining Date
        const targetUser = await User.findById(targetUserId);

        if (targetUser?.joiningDate && !isAdmin) {
            const joiningStart = startOfDay(new Date(targetUser.joiningDate));
            const entryStart = startOfDay(new Date(entryDate));

            if (entryStart < joiningStart) {
                return res.status(400).json({ message: 'Cannot add entries before joining date.' });
            }
        }

        // 2. Resolve Task
        let task = taskId;
        if (!task) {
            // If no task provided, try to find a default/general task for the module/project
            // For now, we require task or at least module to find a task? 
            // If the UI sends projectId but not taskId, we might need to handle "General" task creation or assignment.
            // But let's assume UI forces selection or we default to a "General" task if logic exists.

            // If strict:
            if (!moduleId && !taskId) {
                // return res.status(400).json({ message: 'Task or Module is required' });
                // Let's rely on UI providing the necessary IDs.
                // However, for "General Work" we might need to be flexible.
            }
        }

        // 3. Create WorkLog
        const workLog = new WorkLog({
            user: targetUserId,
            date: entryDate,
            companyId: req.companyId,
            task: taskId, // This implies taskId is required. 
            // If we support Project-only logs, we'd need a Task to hold it (e.g. "General Task" under project)
            // But WorkLog schema likely has 'task' as ref. 
            hours: Number(hours),
            description: description || '',
            status: 'PENDING'
        });

        // 3.5 Check if we need to create a dummy task/module if missing? 
        // For this iteration, let's assume the UI provides valid IDs.

        await workLog.save();

        // 4. Update Timesheet (Legacy/Cache Sync) - Optional but good for consistency if logic relies on it
        // We defer this or relying on WorkLog aggregation in getCurrentTimesheet.
        // Given getCurrentTimesheet uses WorkLog.find, we are good.

        // Populate return
        await workLog.populate({
            path: 'task',
            populate: {
                path: 'module',
                populate: { path: 'project' }
            }
        });

        res.status(201).json(workLog);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};


// @desc    Submit Timesheet
// @route   POST /api/timesheet/submit
// @access  Private
const submitTimesheet = async (req, res) => {
    const { month } = req.body;
    try {
        const company = req.company;
        const timesheet = await Timesheet.findOne({
            user: req.user._id,
            month: month,
            companyId: req.companyId
        });

        if (!timesheet) {
            return res.status(404).json({ message: 'Timesheet not found' });
        }

        const cycle = company?.settings?.timesheet?.approvalCycle || 'Monthly';
        
        timesheet.status = 'SUBMITTED';
        timesheet.submissionCycle = cycle;
        timesheet.submittedAt = new Date();
        await timesheet.save();

        // Notify Managers
        const currentUser = await User.findById(req.user._id).populate('reportingManagers');
        if (currentUser && currentUser.reportingManagers && currentUser.reportingManagers.length > 0) {
            const io = req.app.get('io');
            const notifications = currentUser.reportingManagers.map(manager => ({
                user: manager._id,
                companyId: req.companyId,
                title: 'Timesheet Submitted',
                message: `${currentUser.firstName} ${currentUser.lastName} has submitted their timesheet for ${timesheet.month}.`,
                type: 'Approval',
                link: '/timesheet'
            }));
            await NotificationService.createManyNotifications(io, notifications);
        }

        res.json(timesheet);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get All Projects (for dropdown)
// @route   GET /api/timesheet/projects
// @access  Private
const getProjects = async (req, res) => {
    try {
        const { userId } = req.query;
        let targetUserId = req.user._id;

        // Check Permissions for viewing other's projects
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('timesheet.view');

        if (userId && (isAdmin || userId === req.user._id.toString())) {
            targetUserId = userId;
        }

        // If Admin AND NO userId query, show all active projects (for Project Management / General view)
        // BUT if userId query exists, we stick to the restriction logic below.
        if (isAdmin && !userId) {
            const projects = await Project.find({ companyId: req.companyId, isActive: true }).lean();
            return res.json(projects);
        }

        // For regular users (or when viewing a specific user):
        // Find projects where the user is:
        // 1. Manager
        // 2. Member
        // 3. Assigned to a task within the project

        // Get Task IDs assigned to the user
        const assignedTasks = await Task.find({ assignees: targetUserId, companyId: req.companyId }).select('module');
        const moduleIds = [...new Set(assignedTasks.map(t => t.module))];

        // Get Project IDs for those modules
        const modules = await Module.find({ _id: { $in: moduleIds } }).select('project');
        const taskProjectIds = [...new Set(modules.map(m => m.project))];

        const projects = await Project.find({
            companyId: req.companyId,
            isActive: true,
            $or: [
                { manager: targetUserId },
                { members: targetUserId },
                { _id: { $in: taskProjectIds } }
            ]
        }).lean();

        res.json(projects);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Create Dummy Project (Helper)
// @route   POST /api/timesheet/projects
// @access  Private (Admin)
const createProject = async (req, res) => {
    try {
        const project = await Project.create({
            ...req.body,
            companyId: req.companyId
        });
        res.json(project);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};


// @desc    Get Specific User's Timesheet (Manager/Admin)
// @route   GET /api/timesheet/user/:userId
// @access  Private
const getUserTimesheet = async (req, res) => {
    try {
        const targetUserId = req.params.userId;
        const currentMonth = req.query.month || format(new Date(), 'yyyy-MM');

        if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

        // 1. Check Permissions
        const targetUser = await User.findOne({ _id: targetUserId, companyId: req.companyId });

        if (!targetUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || 
             req.user.permissions?.includes('timesheet.view') ||
             req.user.permissions?.includes('timesheet.update_others') ||
             req.user.permissions?.includes('attendance.view');

        const isManager = targetUser.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        if (!isManager && !isAdmin && targetUserId !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Not authorized to view this timesheet' });
        }

        let timesheet = await Timesheet.findOne({
            user: targetUserId,
            month: currentMonth,
            companyId: req.companyId
        }).lean();

        // Fetch WorkLogs
        const [year, month] = currentMonth.split('-');
        const currentMonthIdx = parseInt(month) - 1;

        let start, end;
        if (!isNaN(currentMonthIdx)) {
            start = startOfMonth(new Date(parseInt(year), currentMonthIdx));
            end = endOfMonth(new Date(parseInt(year), currentMonthIdx));
        } else {
            start = startOfMonth(new Date());
            end = endOfMonth(new Date());
        }

        const [workLogs, attendance, fullTargetUser] = await Promise.all([
            WorkLog.find({
                user: targetUserId,
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            }).populate({
                path: 'task',
                populate: {
                    path: 'module',
                    populate: { path: 'project' }
                }
            }).sort({ date: 1 }).lean(),
            Attendance.find({
                user: targetUserId,
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            }).select('date clockInIST clockOutIST clockIn clockOut duration').lean(),
            User.findOne({ _id: targetUserId, companyId: req.companyId })
                .select('firstName lastName email employeeCode')
                .populate('reportingManagers', 'firstName lastName email')
                .lean()
        ]);

        let responseData = timesheet ? { ...timesheet } : {
            month: currentMonth,
            status: 'NOT_STARTED'
        };

        const entries = workLogs.map(log => ({
            _id: log._id,
            date: log.date,
            project: log.task?.module?.project || { name: 'Unknown Project' },
            module: log.task?.module,
            task: log.task,
            taskName: log.task?.name,
            hours: log.hours,
            description: log.description,
            status: log.status,
            rejectionReason: log.rejectionReason
        }));

        responseData.userDetails = fullTargetUser;
        responseData.user = fullTargetUser;
        responseData.entries = entries;
        responseData.attendanceLog = attendance;

        res.json(responseData);

    } catch (error) {
        console.error('getUserTimesheet Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get Pending Timesheets (Manager View)
// @route   GET /api/timesheet/approvals
// @access  Private
// @desc    Get Pending Timesheets (Manager View)
// @route   GET /api/timesheet/approvals
// @access  Private
const getPendingTimesheets = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

        let timesheets;

        // Check if user is Admin
        // req.user.roles is populated with Role objects
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('timesheet.approve');

        if (isAdmin) {
            // Admin sees ALL submitted timesheets
            timesheets = await Timesheet.find({
                status: 'SUBMITTED',
                companyId: req.companyId
            }).populate('user', 'firstName lastName email employeeCode')
                .sort({ month: -1 });
        } else {
            // Regular Manager: Find subordinates (where I am one of the reporting managers)
            const subordinates = await User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('_id');
            const subordinateIds = subordinates.map(u => u._id);

            timesheets = await Timesheet.find({
                user: { $in: subordinateIds },
                status: 'SUBMITTED',
                companyId: req.companyId
            }).populate('user', 'firstName lastName email employeeCode')
                .sort({ month: -1 });
        }

        // Enrich with Entries
        const enrichedTimesheets = await Promise.all(timesheets.map(async (ts) => {
            const [year, month] = ts.month.split('-');
            const start = startOfMonth(new Date(parseInt(year), parseInt(month) - 1));
            const end = endOfMonth(new Date(parseInt(year), parseInt(month) - 1));

            const workLogs = await WorkLog.find({
                user: ts.user._id,
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            }).populate({
                path: 'task',
                select: 'name module',
                populate: {
                    path: 'module',
                    select: 'name project',
                    populate: { path: 'project', select: 'name' }
                }
            }).sort({ date: 1 }).lean();

            const entries = workLogs.map(log => ({
                _id: log._id,
                date: log.date,
                project: log.task?.module?.project || { name: 'Unknown Project' },
                module: log.task?.module,
                task: log.task,
                taskName: log.task?.name,
                hours: log.hours,
                description: log.description,
                status: log.status,
                rejectionReason: log.rejectionReason
            }));

            return {
                ...(ts.toObject ? ts.toObject() : ts),
                entries
            };
        }));

        res.json(enrichedTimesheets);
    } catch (error) {
        console.error('getPendingTimesheets Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Approve/Reject Timesheet
// @route   PUT /api/timesheet/:id/approve
// @access  Private
const approveTimesheet = async (req, res) => {
    const { status, reason, type = 'FULL', rejectedEntryIds = [] } = req.body;
    try {
        const timesheet = await Timesheet.findOne({ _id: req.params.id, companyId: req.companyId })
            .populate('user', 'reportingManagers');

        if (!timesheet) {
            return res.status(404).json({ message: 'Timesheet not found' });
        }

        const targetUser = timesheet.user;
        const isManager = targetUser.reportingManagers?.some(m => m.toString() === req.user._id.toString());

        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || req.user.permissions?.includes('timesheet.approve');

        if (!isManager && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const [year, month] = timesheet.month.split('-');
        const start = startOfMonth(new Date(parseInt(year), parseInt(month) - 1));
        const end = endOfMonth(new Date(parseInt(year), parseInt(month) - 1));

        if (status === 'REJECTED' && type === 'PARTIAL') {
            timesheet.status = 'REJECTED';
            timesheet.approver = req.user._id;
            timesheet.rejectionReason = "Partial Rejection: " + reason;

            if (rejectedEntryIds.length > 0) {
                await WorkLog.updateMany(
                    { _id: { $in: rejectedEntryIds }, companyId: req.companyId },
                    { $set: { status: 'REJECTED', rejectionReason: reason } }
                );
            }

        } else {
            timesheet.status = status;
            timesheet.approver = req.user._id;
            if (reason) timesheet.rejectionReason = reason;

            const entryStatus = status === 'APPROVED' ? 'APPROVED' : 'REJECTED';
            const updateDoc = { status: entryStatus };
            if (status === 'REJECTED') updateDoc.rejectionReason = reason;

            await WorkLog.updateMany(
                {
                    user: targetUser._id,
                    companyId: req.companyId,
                    date: { $gte: start, $lte: end }
                },
                { $set: updateDoc }
            );
        }

        await timesheet.save();

        // Notify Employee
        const io = req.app.get('io');
        await NotificationService.createNotification(io, {
            user: targetUser._id,
            companyId: req.companyId,
            title: `Timesheet ${status}`,
            message: `Your timesheet for ${timesheet.month} has been ${status === 'APPROVED' ? 'approved' : 'rejected'}. ${reason ? 'Reason: ' + reason : ''}`,
            type: status === 'APPROVED' ? 'Info' : 'Alert',
            link: '/timesheet'
        });

        res.json(timesheet);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update Timesheet Entry (Regularize)
// @route   PUT /api/timesheet/entry/:entryId
// @access  Private
const updateEntry = async (req, res) => {
    const { hours, description } = req.body;
    try {
        const workLog = await WorkLog.findOne({ _id: req.params.entryId, companyId: req.companyId }).populate('user');

        if (!workLog) {
            return res.status(404).json({ message: 'Entry (WorkLog) not found' });
        }

        const owner = workLog.user;
        const requestor = req.user;

        const isOwner = owner._id.toString() === requestor._id.toString();
        const isManager = owner.reportingManagers?.some(m => m.toString() === requestor._id.toString());
        const isAdmin = requestor.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || requestor.permissions?.includes('*') || 
          requestor.permissions?.includes('timesheet.update') ||
          requestor.permissions?.includes('timesheet.update_others');

        if (!isOwner && !isManager && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = getTimesheetPeriodIdForDate(workLog.date, cycle);
        const timesheet = await Timesheet.findOne({ user: owner._id, month: periodId, companyId: req.companyId });

        if (timesheet && (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED')) {
            return res.status(400).json({ message: 'Cannot edit submitted/approved timesheets' });
        }

        // Check Joining Date
        if (owner.joiningDate && !isAdmin) {
            // For updateEntry, we check the workLog date
            const joiningStart = startOfDay(new Date(owner.joiningDate));
            const logStart = startOfDay(workLog.date);

            if (logStart < joiningStart) {
                return res.status(400).json({ message: 'Cannot edit entries before joining date.' });
            }
        }

        if (hours !== undefined) workLog.hours = hours;
        if (description !== undefined) workLog.description = description;

        // Support for changing hierarchy (Task/Project)
        if (req.body.taskId) workLog.task = req.body.taskId;
        // Project/Module are inferred from Task, but if we track them in future or validation requires checking:
        // We only really need to update the Task reference in WorkLog.

        if (workLog.status === 'REJECTED') {
            workLog.status = 'PENDING';
            workLog.rejectionReason = undefined;
        }

        await workLog.save();
        res.json(workLog);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    getCurrentTimesheet,
    getUserTimesheet,
    addEntry,
    updateEntry,
    submitTimesheet,
    getProjects,
    createProject,
    getPendingTimesheets,
    approveTimesheet
};
