const mongoose = require('mongoose');
const Timesheet = require('./timesheet.model');
const Project = require('../project/project.model');
const User = require('../../modules/user/user.model');
const Attendance = require('../../modules/attendance/model/attendance.model');
const { startOfDay } = require('date-fns');
const WorkLog = require('./workLog.model');
const Task = require('../task/task.model');
const Module = require('../task/module.model');
const NotificationService = require('../../services/notificationService');
const { buildTimesheetPeriodRange, getTimesheetPeriodIdForDate } = require('./timesheetPeriod');
const { parseDateAsIST } = require('../../modules/attendance/attendancePolicy');

const canUpdateFutureRecords = (user) => (
    user?.roles?.some(r =>
        (typeof r === 'string' && r === 'Admin') ||
        (typeof r === 'object' && r.name === 'Admin')
    ) ||
    user?.permissions?.includes('*') ||
    user?.permissions?.includes('attendance.update_future')
);

const isProjectAssignedToUser = async (projectId, userId, companyId) => {
    const project = await Project.findOne({ _id: projectId, companyId, isActive: true });
    if (!project) return false;

    const uId = userId.toString();
    if (project.manager?.toString() === uId) return true;
    if (project.members?.some(m => m.toString() === uId)) return true;

    const modules = await Module.find({ project: projectId, companyId }).select('_id').lean();
    const moduleIds = (modules || []).map(m => m._id);
    const hasAssignedTask = await Task.exists({
        module: { $in: moduleIds },
        assignees: userId,
        companyId
    });
    return Boolean(hasAssignedTask);
};

const populateWorkLogHierarchy = (query) => (
    query
        .populate({
            path: 'task',
            select: 'name module',
            populate: {
                path: 'module',
                select: 'name project',
                populate: { path: 'project', select: 'name client' }
            }
        })
        .populate('module', 'name')
        .populate({
            path: 'project',
            select: 'name client hasModules',
            populate: { path: 'client', select: 'name' }
        })
        .populate('discussion', 'discussion title')
);

const mapWorkLogToTimesheetEntry = (log) => ({
    _id: log._id,
    date: log.date,
    project: log.project || log.task?.module?.project || { name: 'Unknown Project' },
    module: log.module || log.task?.module || null,
    task: log.task || null,
    taskName: log.task?.name || null,
    discussion: log.discussion || null,
    hours: log.hours,
    description: log.description,
    status: log.status,
    rejectionReason: log.rejectionReason
});

// @desc    Get Current Month Timesheet
// @route   GET /api/timesheet/current
// @access  Private
const getCurrentTimesheet = async (req, res) => {
    try {
        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const currentMonth = req.query.month || getTimesheetPeriodIdForDate(new Date(), cycle);

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
            const created = await Timesheet.create({
                user: req.user._id,
                month: currentMonth,
                companyId: req.companyId,
                status: 'DRAFT',
                rejectionReason: ''
            });
            timesheet = created.toObject();
        }

        let fullUser;
        try {
            fullUser = await User.findById(req.user._id)
                .select('firstName lastName email employeeCode joiningDate attendanceMode customFlexibleOffDays')
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

        const { start, end } = buildTimesheetPeriodRange(currentMonth, cycle);

        const [workLogs, attendance] = await Promise.all([
            populateWorkLogHierarchy(WorkLog.find({
                user: req.user._id,
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            })).sort({ date: 1 }).lean(),
            Attendance.find({
                user: req.user._id,
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            }).select('date clockInIST clockOutIST duration clockIn clockOut attendanceMode maxWorkingHours').lean()
        ]);

        const entries = workLogs.map(mapWorkLogToTimesheetEntry);

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
    const { date: entryDate, hours, description, projectId, moduleId, taskId, discussionId, userId } = req.body;

    try {
        // 1. Resolve Target User
        let targetUserId = req.user._id;
        const isAdmin = req.user.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') || 
          req.user.permissions?.includes('admin');
        const canUpdateOthers = isAdmin || req.user.permissions?.includes('timesheet.update_others');

        if (userId && canUpdateOthers) {
            targetUserId = userId;
        }

        // Validate Date and other required fields
        if (!entryDate || !hours || !projectId) {
            return res.status(400).json({ message: 'Date, Project, and Hours are required' });
        }

        const isSelfAdmin = isAdmin && String(targetUserId) === String(req.user._id);
        if (!isSelfAdmin) {
            const isAssigned = await isProjectAssignedToUser(projectId, targetUserId, req.companyId);
            if (!isAssigned) {
                return res.status(403).json({ message: 'Selected project is not assigned to this employee' });
            }
        }

        // Check for Existing Timesheet Logic
        const parsedEntryDate = new Date(entryDate);
        if (!entryDate || Number.isNaN(parsedEntryDate.getTime())) {
            return res.status(400).json({ message: 'Valid work log date is required' });
        }
        const normalizedEntryDate = parseDateAsIST(parsedEntryDate);
        if (normalizedEntryDate > parseDateAsIST(new Date()) && !canUpdateFutureRecords(req.user)) {
            return res.status(403).json({ message: 'Not authorized to add work logs for future dates' });
        }

        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = getTimesheetPeriodIdForDate(normalizedEntryDate, cycle);

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
            const joiningDateIST = parseDateAsIST(targetUser.joiningDate);

            if (joiningDateIST && normalizedEntryDate < joiningDateIST) {
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
            date: normalizedEntryDate,
            companyId: req.companyId,
            project: projectId,
            module: moduleId || null,
            task: taskId || null,
            discussion: discussionId || null,
            hours: Number(hours),
            description: description || '',
            status: 'PENDING'
        });

        // 3.5 Check if we need to create a dummy task/module if missing? 
        // For this iteration, let's assume the UI provides valid IDs.

        await workLog.save();

        if (!timesheet) {
            await Timesheet.updateOne({
                user: targetUserId,
                month: periodId,
                companyId: req.companyId
            }, {
                $setOnInsert: {
                    status: 'DRAFT',
                    rejectionReason: ''
                }
            }, { upsert: true });
        }

        const populatedWorkLog = await populateWorkLogHierarchy(
            WorkLog.findOne({ _id: workLog._id, companyId: req.companyId })
        ).lean();

        res.status(201).json(mapWorkLogToTimesheetEntry(populatedWorkLog));

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

        if (timesheet.status === 'APPROVED') {
            return res.status(400).json({ message: 'Approved timesheets cannot be resubmitted.' });
        }

        if (timesheet.status === 'SUBMITTED') {
            return res.status(400).json({ message: 'Timesheet is already submitted.' });
        }
        
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
                preferenceKey: 'timesheet_submitted',
                title: 'Timesheet Submitted',
                message: `${currentUser.firstName} ${currentUser.lastName} has submitted their timesheet for ${timesheet.month}.`,
                type: 'Approval',
                link: '/timesheet',
                origin: req.headers?.origin || ''
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
        const isAdmin = (req.user.roles?.some(r => {
            const roleName = typeof r === 'string' ? r : r?.name;
            return roleName === 'Admin' || roleName === 'System Admin' || roleName === 'Super Admin';
        }) || req.user.permissions?.includes('*') || req.user.permissions?.includes('admin'));

        const canViewOthers = isAdmin || req.user.permissions?.includes('timesheet.view') || (req.user.directReports && req.user.directReports.length > 0);

        if (userId && (canViewOthers || userId === req.user._id.toString())) {
            targetUserId = userId;
        }

        const isViewingOther = targetUserId && targetUserId.toString() !== req.user._id.toString();

        // If Admin viewing self, show all active projects
        if (isAdmin && !isViewingOther) {
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
        const modules = await Module.find({ _id: { $in: moduleIds }, companyId: req.companyId }).select('project');
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
        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const currentMonth = req.query.month || getTimesheetPeriodIdForDate(new Date(), cycle);

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

        const { start, end } = buildTimesheetPeriodRange(currentMonth, cycle);

        const [workLogs, attendance, fullTargetUser] = await Promise.all([
            populateWorkLogHierarchy(WorkLog.find({
                user: targetUserId,
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            })).sort({ date: 1 }).lean(),
            Attendance.find({
                user: targetUserId,
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            }).select('date clockInIST clockOutIST clockIn clockOut duration attendanceMode maxWorkingHours').lean(),
            User.findOne({ _id: targetUserId, companyId: req.companyId })
                .select('firstName lastName email employeeCode attendanceMode customFlexibleOffDays joiningDate')
                .populate('reportingManagers', 'firstName lastName email')
                .lean()
        ]);

        let responseData = timesheet ? { ...timesheet } : {
            month: currentMonth,
            status: 'NOT_STARTED'
        };

        const entries = workLogs.map(mapWorkLogToTimesheetEntry);

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
            const cycle = ts.submissionCycle || req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
            const { start, end } = buildTimesheetPeriodRange(ts.month, cycle);

            const [workLogs, attendanceLog] = await Promise.all([
                populateWorkLogHierarchy(WorkLog.find({
                    user: ts.user._id,
                    companyId: req.companyId,
                    date: { $gte: start, $lte: end }
                })).sort({ date: 1 }).lean(),
                Attendance.find({
                    user: ts.user._id,
                    companyId: req.companyId,
                    date: { $gte: start, $lte: end }
                })
                    .select('date clockIn clockOut clockInIST clockOutIST attendanceMode status approvalStatus rejectionReason')
                    .sort({ date: 1 })
                    .lean()
            ]);

            const entries = workLogs.map(mapWorkLogToTimesheetEntry);

            return {
                ...(ts.toObject ? ts.toObject() : ts),
                entries,
                attendanceLog
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

        if (timesheet.status !== 'SUBMITTED') {
            return res.status(400).json({ message: 'Only submitted timesheets can be approved or rejected.' });
        }

        if (!['APPROVED', 'REJECTED'].includes(status)) {
            return res.status(400).json({ message: 'Invalid approval status.' });
        }

        const cycle = timesheet.submissionCycle || req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const { start, end } = buildTimesheetPeriodRange(timesheet.month, cycle);

        if (status === 'REJECTED' && type === 'PARTIAL') {
            if (rejectedEntryIds.length === 0) {
                return res.status(400).json({ message: 'Select at least one timesheet item to reject.' });
            }

            const workLogIds = rejectedEntryIds
                .filter((entryId) => String(entryId).startsWith('worklog:'))
                .map((entryId) => String(entryId).slice('worklog:'.length));
            const attendanceIds = rejectedEntryIds
                .filter((entryId) => String(entryId).startsWith('attendance:'))
                .map((entryId) => String(entryId).slice('attendance:'.length));

            const unscopedIds = rejectedEntryIds.filter((entryId) => {
                const normalized = String(entryId);
                return !normalized.startsWith('worklog:') && !normalized.startsWith('attendance:');
            });

            if (unscopedIds.length > 0) {
                return res.status(400).json({ message: 'One or more selected items are invalid.' });
            }

            const [scopedRejectedEntries, scopedRejectedAttendance] = await Promise.all([
                workLogIds.length > 0
                    ? WorkLog.find({
                        _id: { $in: workLogIds },
                        user: targetUser._id,
                        companyId: req.companyId,
                        date: { $gte: start, $lte: end }
                    }).select('_id').lean()
                    : Promise.resolve([]),
                attendanceIds.length > 0
                    ? Attendance.find({
                        _id: { $in: attendanceIds },
                        user: targetUser._id,
                        companyId: req.companyId,
                        date: { $gte: start, $lte: end }
                    }).select('_id').lean()
                    : Promise.resolve([])
            ]);

            if ((scopedRejectedEntries.length + scopedRejectedAttendance.length) !== rejectedEntryIds.length) {
                return res.status(400).json({ message: 'One or more selected entries are outside this timesheet period.' });
            }

            timesheet.status = 'REJECTED';
            timesheet.approver = req.user._id;
            timesheet.rejectionReason = "Partial Rejection: " + reason;

            await Promise.all([
                workLogIds.length > 0
                    ? WorkLog.updateMany(
                        {
                            _id: { $in: workLogIds },
                            user: targetUser._id,
                            companyId: req.companyId,
                            date: { $gte: start, $lte: end }
                        },
                        { $set: { status: 'REJECTED', rejectionReason: reason } }
                    )
                    : Promise.resolve(),
                attendanceIds.length > 0
                    ? Attendance.updateMany(
                        {
                            _id: { $in: attendanceIds },
                            user: targetUser._id,
                            companyId: req.companyId,
                            date: { $gte: start, $lte: end }
                        },
                        { $set: { approvalStatus: 'REJECTED', rejectionReason: reason } }
                    )
                    : Promise.resolve()
            ]);

        } else {
            timesheet.status = status;
            timesheet.approver = req.user._id;
            if (reason) timesheet.rejectionReason = reason;

            const entryStatus = status === 'APPROVED' ? 'APPROVED' : 'REJECTED';
            const workLogUpdateDoc = { status: entryStatus };
            if (status === 'REJECTED') workLogUpdateDoc.rejectionReason = reason;

            const attendanceUpdateDoc = { approvalStatus: entryStatus };
            if (status === 'REJECTED') attendanceUpdateDoc.rejectionReason = reason;

            await Promise.all([
                WorkLog.updateMany(
                    {
                        user: targetUser._id,
                        companyId: req.companyId,
                        date: { $gte: start, $lte: end }
                    },
                    { $set: workLogUpdateDoc }
                ),
                Attendance.updateMany(
                    {
                        user: targetUser._id,
                        companyId: req.companyId,
                        date: { $gte: start, $lte: end }
                    },
                    { $set: attendanceUpdateDoc }
                )
            ]);
        }

        await timesheet.save();

        // Notify Employee
        const io = req.app.get('io');
        await NotificationService.createNotification(io, {
            user: targetUser._id,
            companyId: req.companyId,
            preferenceKey: 'timesheet_status_updated',
            title: `Timesheet ${status}`,
            message: `Your timesheet for ${timesheet.month} has been ${status === 'APPROVED' ? 'approved' : 'rejected'}. ${reason ? 'Reason: ' + reason : ''}`,
            type: status === 'APPROVED' ? 'Info' : 'Alert',
            link: '/timesheet',
            origin: req.headers?.origin || ''
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
        const isTrueAdmin = requestor.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || requestor.permissions?.includes('*') || 
          requestor.permissions?.includes('admin');
        const canUpdateOthers = isTrueAdmin || requestor.permissions?.includes('timesheet.update_others');

        if (!isOwner && !isManager && !canUpdateOthers) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = getTimesheetPeriodIdForDate(workLog.date, cycle);
        const timesheet = await Timesheet.findOne({ user: owner._id, month: periodId, companyId: req.companyId });

        if (timesheet && (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED')) {
            return res.status(400).json({ message: 'Cannot edit submitted/approved timesheets' });
        }

        if (parseDateAsIST(workLog.date) > parseDateAsIST(new Date()) && !canUpdateFutureRecords(req.user)) {
            return res.status(403).json({ message: 'Not authorized to update work logs for future dates' });
        }

        // Check Joining Date
        if (owner.joiningDate && !isTrueAdmin) {
            // For updateEntry, we check the workLog date
            const joiningDateIST = parseDateAsIST(owner.joiningDate);
            const logDateIST = parseDateAsIST(workLog.date);

            if (joiningDateIST && logDateIST && logDateIST < joiningDateIST) {
                return res.status(400).json({ message: 'Cannot edit entries before joining date.' });
            }
        }

        if (hours !== undefined) workLog.hours = hours;
        if (description !== undefined) workLog.description = description;

        // Support for changing hierarchy (Task/Project/Module/Discussion)
        if (req.body.projectId !== undefined) {
            if (req.body.projectId) {
                const isSelfAdmin = isTrueAdmin && String(owner._id) === String(requestor._id);
                if (!isSelfAdmin) {
                    const isAssigned = await isProjectAssignedToUser(req.body.projectId, owner._id, req.companyId);
                    if (!isAssigned) {
                        return res.status(403).json({ message: 'Selected project is not assigned to this employee' });
                    }
                }
                workLog.project = req.body.projectId;
            } else {
                workLog.project = null;
            }
        }
        if (req.body.moduleId !== undefined) workLog.module = req.body.moduleId || null;
        if (req.body.taskId !== undefined) workLog.task = req.body.taskId || null;
        if (req.body.discussionId !== undefined) workLog.discussion = req.body.discussionId || null;

        if (workLog.status === 'REJECTED') {
            workLog.status = 'PENDING';
            workLog.rejectionReason = undefined;
        }

        await workLog.save();
        const populatedWorkLog = await populateWorkLogHierarchy(
            WorkLog.findOne({ _id: workLog._id, companyId: req.companyId })
        ).lean();
        res.json(mapWorkLogToTimesheetEntry(populatedWorkLog));

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Delete Timesheet Entry (WorkLog)
// @route   DELETE /api/timesheet/entry/:entryId
// @access  Private
const deleteEntry = async (req, res) => {
    try {
        const workLog = await WorkLog.findOne({ _id: req.params.entryId, companyId: req.companyId }).populate('user');

        if (!workLog) {
            return res.status(404).json({ message: 'Entry (WorkLog) not found' });
        }

        const owner = workLog.user;
        const requestor = req.user;
        const ownerId = (owner && owner._id) ? owner._id.toString() : (owner ? owner.toString() : '');

        const isOwner = ownerId === requestor._id.toString();
        const isManager = Boolean(owner?.reportingManagers?.some(m => m.toString() === requestor._id.toString()));
        const isTrueAdmin = requestor.roles?.some(r => 
            (typeof r === 'string' && r === 'Admin') || 
            (typeof r === 'object' && r.name === 'Admin')
        ) || requestor.permissions?.includes('*') || 
          requestor.permissions?.includes('admin');
        const canUpdateOthers = isTrueAdmin || requestor.permissions?.includes('timesheet.update_others');

        if (!isOwner && !isManager && !canUpdateOthers) {
            return res.status(403).json({ message: 'Not authorized to delete this work log' });
        }

        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = getTimesheetPeriodIdForDate(workLog.date, cycle);
        const timesheet = await Timesheet.findOne({ user: ownerId, month: periodId, companyId: req.companyId });

        if (timesheet && (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED')) {
            return res.status(400).json({ message: 'Cannot delete entries for a submitted or approved timesheet' });
        }

        await workLog.softDelete(req.user._id);

        res.json({ message: 'Work log deleted successfully', entryId: req.params.entryId });
    } catch (error) {
        console.error('[TimesheetController] deleteEntry error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get Team / Bulk Timesheet Report for selected users or whole team
// @route   ALL /api/timesheet/team-report
// @access  Private
const getTeamTimesheetReport = async (req, res) => {
    try {
        const cycle = req.company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const requestedMonth = req.body?.month || req.query?.month || getTimesheetPeriodIdForDate(new Date(), cycle);
        const requestedUserIds = Array.isArray(req.body?.userIds)
            ? req.body.userIds
            : (req.query?.userIds ? req.query.userIds.split(',').map(s => s.trim()).filter(Boolean) : null);

        if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

        const isAdmin = req.user.roles?.some(r =>
            (typeof r === 'string' && r === 'Admin') ||
            (typeof r === 'object' && r.name === 'Admin')
        ) || req.user.permissions?.includes('*') ||
             req.user.permissions?.includes('timesheet.view') ||
             req.user.permissions?.includes('timesheet.update_others') ||
             req.user.permissions?.includes('attendance.view') ||
             req.user.permissions?.includes('attendance.view_all') ||
             req.user.permissions?.includes('user.read');

        let userFilter = { companyId: req.companyId, isDeleted: { $ne: true } };

        if (requestedUserIds && requestedUserIds.length > 0) {
            const validIds = requestedUserIds
                .map(id => (typeof id === 'object' && id?._id ? id._id : id))
                .filter(id => id && mongoose.Types.ObjectId.isValid(id))
                .map(id => new mongoose.Types.ObjectId(id));

            if (!isAdmin) {
                userFilter.$and = [
                    { _id: { $in: validIds } },
                    { $or: [{ reportingManagers: req.user._id }, { _id: req.user._id }] }
                ];
            } else {
                userFilter._id = { $in: validIds };
            }
        } else {
            if (!isAdmin) {
                userFilter.$or = [{ reportingManagers: req.user._id }, { _id: req.user._id }];
            }
        }

        const teamMembers = await User.find(userFilter)
            .select('_id firstName lastName email employeeCode department departmentRef designationRef joiningDate dateOfLeaving customFlexibleOffDays attendanceMode')
            .populate('reportingManagers', 'firstName lastName email')
            .populate('departmentRef', 'name code')
            .populate('designationRef', 'title level')
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        const memberIds = teamMembers.map(m => m._id);
        const fromDate = req.body?.fromDate || req.query?.fromDate;
        const toDate = req.body?.toDate || req.query?.toDate;
        const isDateRange = Boolean(fromDate && toDate);
        const isAllTime = !isDateRange && (requestedMonth === 'all' || requestedMonth === 'all_time' || req.body?.range === 'all' || req.query?.range === 'all');

        let start, end;
        if (isDateRange) {
            start = new Date(fromDate);
            start.setHours(0, 0, 0, 0);
            end = new Date(toDate);
            end.setHours(23, 59, 59, 999);
        } else if (isAllTime) {
            start = new Date(0);
            end = new Date();
        } else {
            const range = buildTimesheetPeriodRange(requestedMonth, cycle);
            start = range.start;
            end = range.end;
        }

        const timesheetQuery = {
            user: { $in: memberIds },
            companyId: req.companyId
        };
        if (!isAllTime && !isDateRange) {
            timesheetQuery.month = requestedMonth;
        }

        const [workLogs, timesheets, assignedTasks, allActiveProjects] = await Promise.all([
            populateWorkLogHierarchy(WorkLog.find({
                user: { $in: memberIds },
                companyId: req.companyId,
                date: { $gte: start, $lte: end }
            })).sort({ date: 1 }).lean(),
            Timesheet.find(timesheetQuery).sort({ createdAt: -1 }).lean(),
            Task.find({
                assignees: { $in: memberIds },
                companyId: req.companyId,
                isDeleted: { $ne: true }
            }).select('assignees module').lean(),
            Project.find({
                companyId: req.companyId,
                isActive: true,
                isDeleted: { $ne: true }
            }).select('_id name code manager members').lean()
        ]);

        const taskModuleIds = [...new Set(assignedTasks.map(t => t.module).filter(Boolean))];
        const taskModules = taskModuleIds.length > 0
            ? await Module.find({ _id: { $in: taskModuleIds }, companyId: req.companyId, isDeleted: { $ne: true } }).select('_id project').lean()
            : [];

        const moduleToProject = {};
        taskModules.forEach(m => {
            if (m.project) moduleToProject[m._id.toString()] = m.project.toString();
        });

        const userTaskProjectIds = {};
        assignedTasks.forEach(t => {
            const pId = moduleToProject[t.module?.toString()];
            if (pId && Array.isArray(t.assignees)) {
                t.assignees.forEach(u => {
                    const uStr = u.toString();
                    if (!userTaskProjectIds[uStr]) userTaskProjectIds[uStr] = new Set();
                    userTaskProjectIds[uStr].add(pId);
                });
            }
        });

        const assignedProjectsByUser = {};
        memberIds.forEach(id => {
            const idStr = id.toString();
            const userTaskSet = userTaskProjectIds[idStr] || new Set();
            const userProjs = allActiveProjects.filter(p => {
                const isMgr = p.manager && p.manager.toString() === idStr;
                const isMember = Array.isArray(p.members) && p.members.some(m => m.toString() === idStr);
                const hasTask = userTaskSet.has(p._id.toString());
                return isMgr || isMember || hasTask;
            }).map(p => ({
                _id: p._id,
                name: p.name,
                code: p.code
            }));
            assignedProjectsByUser[idStr] = userProjs;
        });

        const workLogsByUser = {};
        memberIds.forEach(id => {
            workLogsByUser[id.toString()] = [];
        });

        workLogs.forEach(log => {
            const uId = log.user ? log.user.toString() : '';
            if (workLogsByUser[uId]) {
                workLogsByUser[uId].push(mapWorkLogToTimesheetEntry(log));
            }
        });

        const timesheetMap = {};
        timesheets.forEach(ts => {
            const uId = ts.user ? ts.user.toString() : '';
            timesheetMap[uId] = ts;
        });

        res.json({
            month: isDateRange ? `${fromDate} to ${toDate}` : (isAllTime ? 'All Time' : requestedMonth),
            cycle,
            startDate: start,
            endDate: end,
            isAllTime,
            isDateRange,
            fromDate,
            toDate,
            teamMembers,
            timesheets: timesheetMap,
            workLogsByUser,
            assignedProjectsByUser
        });
    } catch (error) {
        console.error('getTeamTimesheetReport Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    populateWorkLogHierarchy,
    mapWorkLogToTimesheetEntry,
    getCurrentTimesheet,
    getUserTimesheet,
    getTeamTimesheetReport,
    addEntry,
    updateEntry,
    deleteEntry,
    submitTimesheet,
    getProjects,
    createProject,
    getPendingTimesheets,
    approveTimesheet
};
