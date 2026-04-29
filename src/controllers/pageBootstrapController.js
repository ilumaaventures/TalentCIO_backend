const { startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfDay, endOfDay, addWeeks, format } = require('date-fns');
const Attendance = require('../models/Attendance');
const Candidate = require('../models/Candidate');
const BusinessUnit = require('../models/BusinessUnit');
const Client = require('../models/Client');
const Company = require('../models/Company');
const Discussion = require('../models/Discussion');
const Holiday = require('../models/Holiday');
const HelpdeskQuery = require('../models/HelpdeskQuery');
const LeaveBalance = require('../models/LeaveBalance');
const LeaveConfig = require('../models/LeaveConfig');
const LeaveRequest = require('../models/LeaveRequest');
const Module = require('../models/Module');
const Notification = require('../models/Notification');
const OnboardingEmployee = require('../models/OnboardingEmployee');
const Permission = require('../models/Permission');
const Project = require('../models/Project');
const Role = require('../models/Role');
const Task = require('../models/Task');
const Timesheet = require('../models/Timesheet');
const User = require('../models/User');
const WorkLog = require('../models/WorkLog');
const { getStartOfDayIST } = require('../utils/attendancePolicy');

const setPrivateCache = (res, maxAgeSeconds = 30) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`);
};

const hasPermission = (user, permission) => (user?.permissions || []).includes(permission);
const hasAnyPermission = (user, permissions) => permissions.some((permission) => hasPermission(user, permission));

const isAdminUser = (user) =>
    (user?.roles || []).some(r =>
        (typeof r === 'string' && r === 'Admin') ||
        (typeof r === 'object' && r?.name === 'Admin')
    ) ||
    user?.permissions?.includes('*') ||
    user?.permissions?.includes('admin');

const canViewOtherAttendance = (user) =>
    isAdminUser(user) ||
    user?.permissions?.includes('attendance.view') ||
    user?.permissions?.includes('attendance.update_others');

const canViewOtherTimesheets = (user) =>
    isAdminUser(user) ||
    user?.permissions?.includes('timesheet.view') ||
    user?.permissions?.includes('timesheet.update_others') ||
    user?.permissions?.includes('attendance.view');

const canLoadUserList = (user) =>
    (user?.roles || []).some(r => {
        const roleName = typeof r === 'string' ? r : r?.name;
        return roleName === 'Admin' || roleName === 'Manager';
    }) ||
    user?.permissions?.includes('timesheet.view') ||
    user?.permissions?.includes('*') ||
    (user?.directReports && user.directReports.length > 0);

const canManageProjectDirectory = (user) =>
    isAdminUser(user) ||
    hasAnyPermission(user, ['project.create', 'project.update', 'task.create', 'task.update']);

const buildProjectVisibilityFilter = async ({ requestUser, companyId }) => {
    const filter = { companyId };
    const canViewAll = isAdminUser(requestUser) || hasPermission(requestUser, 'project.read');
    const canViewAssigned = hasPermission(requestUser, 'project.view_assigned');
    const canViewTeam = hasPermission(requestUser, 'project.view_team');

    if (canViewAll) {
        return filter;
    }

    if (!canViewAssigned && !canViewTeam) {
        return { ...filter, _id: null };
    }

    const orConditions = [];
    const assignedModuleIds = await Task.distinct('module', {
        assignees: requestUser._id,
        companyId
    });
    const taskProjectIds = assignedModuleIds.length > 0
        ? await Module.distinct('project', {
            _id: { $in: assignedModuleIds },
            companyId
        })
        : [];

    orConditions.push({ manager: requestUser._id });
    orConditions.push({ members: requestUser._id });

    if (taskProjectIds.length > 0) {
        orConditions.push({ _id: { $in: taskProjectIds } });
    }

    if (canViewTeam) {
        const directReports = await User.find({
            reportingManagers: requestUser._id,
            companyId
        }).select('_id').lean();
        const reportIds = directReports.map((user) => user._id);

        if (reportIds.length > 0) {
            orConditions.push({ manager: { $in: reportIds } });
            orConditions.push({ members: { $in: reportIds } });

            const teamAssignedModuleIds = await Task.distinct('module', {
                assignees: { $in: reportIds },
                companyId
            });
            const teamTaskProjectIds = teamAssignedModuleIds.length > 0
                ? await Module.distinct('project', {
                    _id: { $in: teamAssignedModuleIds },
                    companyId
                })
                : [];

            if (teamTaskProjectIds.length > 0) {
                orConditions.push({ _id: { $in: teamTaskProjectIds } });
            }
        }
    }

    return orConditions.length > 0
        ? { ...filter, $or: orConditions }
        : { ...filter, _id: null };
};

const getInitialAccruedBalance = (policy) => {
    if (policy.accrualType === 'Yearly') {
        return policy.accrualAmount || 0;
    }

    if (policy.accrualType === 'Monthly') {
        const currentMonth = new Date().getMonth() + 1;
        let initialAccrued = (policy.accrualAmount || 0) * currentMonth;
        if (policy.maxLimitPerYear > 0 && initialAccrued > policy.maxLimitPerYear) {
            initialAccrued = policy.maxLimitPerYear;
        }
        return initialAccrued;
    }

    if (policy.accrualType === 'Policy') {
        return policy.accrualAmount || 0;
    }

    return 0;
};

const getMonthRange = (year, month) => {
    const monthValue = parseInt(month, 10);
    const yearValue = parseInt(year, 10);
    const start = new Date(yearValue, monthValue - 1, 1);
    const end = new Date(yearValue, monthValue, 1);
    return { start, end };
};

const buildTimesheetPeriodRange = (periodId, cycle) => {
    if (cycle === 'Weekly') {
        if (periodId.includes('-W')) {
            const [year, weekStr] = periodId.split('-W');
            const weekNum = parseInt(weekStr, 10);
            const firstDayOfYear = new Date(parseInt(year, 10), 0, 1);
            const daysToFirstMonday = (8 - firstDayOfYear.getDay()) % 7;
            const firstMonday = new Date(parseInt(year, 10), 0, 1 + daysToFirstMonday);
            const start = startOfWeek(addWeeks(firstMonday, weekNum - 1));
            const end = endOfWeek(start);
            return { start, end };
        }

        const date = new Date(`${periodId}-01`);
        return { start: startOfWeek(date), end: endOfWeek(date) };
    }

    if (cycle === 'Daily') {
        const start = startOfDay(new Date(periodId));
        return { start, end: endOfDay(start) };
    }

    const [year, month] = periodId.split('-');
    const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
    return { start: startOfMonth(date), end: endOfMonth(date) };
};

const getTimesheetProjectsForUser = async ({ requestUser, companyId, targetUserId }) => {
    const isAdmin = isAdminUser(requestUser) || requestUser?.permissions?.includes('timesheet.view');

    if (isAdmin && !targetUserId) {
        return Project.find({ companyId, isActive: true }).lean();
    }

    const assignedTasks = await Task.find({ assignees: targetUserId, companyId }).select('module').lean();
    const moduleIds = [...new Set(assignedTasks.map(task => String(task.module)).filter(Boolean))];
    const modules = moduleIds.length > 0
        ? await Module.find({ _id: { $in: moduleIds } }).select('project').lean()
        : [];
    const taskProjectIds = [...new Set(modules.map(module => module.project).filter(Boolean))];

    return Project.find({
        companyId,
        isActive: true,
        $or: [
            { manager: targetUserId },
            { members: targetUserId },
            { _id: { $in: taskProjectIds } }
        ]
    }).lean();
};

const getTimesheetDocument = async ({ requestUser, companyId, targetUserId, periodId }) => {
    let timesheet = await Timesheet.findOne({
        user: targetUserId,
        month: periodId,
        companyId
    }).lean();

    if (!timesheet && String(targetUserId) === String(requestUser._id)) {
        timesheet = await Timesheet.create({
            user: targetUserId,
            month: periodId,
            companyId,
            status: 'DRAFT',
            rejectionReason: ''
        });
        timesheet = timesheet.toObject();
    }

    const fullUser = await User.findOne({ _id: targetUserId, companyId })
        .select('firstName lastName email employeeCode joiningDate reportingManagers')
        .populate('reportingManagers', 'firstName lastName email')
        .lean();

    const company = await Company.findById(companyId)
        .select('settings.attendance.weeklyOff settings.timesheet.approvalCycle')
        .lean();
    const cycle = company?.settings?.timesheet?.approvalCycle || 'Monthly';
    const { start, end } = buildTimesheetPeriodRange(periodId, cycle);

    const [workLogs, attendance] = await Promise.all([
        WorkLog.find({
            user: targetUserId,
            companyId,
            date: { $gte: start, $lte: end }
        })
            .populate({
                path: 'task',
                select: 'name module',
                populate: {
                    path: 'module',
                    select: 'name project',
                    populate: { path: 'project', select: 'name client' }
                }
            })
            .sort({ date: 1 })
            .lean(),
        Attendance.find({
            user: targetUserId,
            companyId,
            date: { $gte: start, $lte: end }
        })
            .select('date clockInIST clockOutIST duration clockIn clockOut status approvalStatus')
            .lean()
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

    return {
        ...(timesheet || {
            month: periodId,
            status: 'DRAFT',
            rejectionReason: '',
            user: targetUserId
        }),
        userDetails: fullUser,
        user: fullUser,
        entries,
        attendanceLog: attendance,
        weeklyOff: company?.settings?.attendance?.weeklyOff || ['Sunday']
    };
};

exports.getAttendanceBootstrap = async (req, res) => {
    try {
        setPrivateCache(res, 20);
        const targetUserId = req.query.userId || req.user._id;
        const year = parseInt(req.query.year, 10) || new Date().getFullYear();
        const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
        const { start, end } = getMonthRange(year, month);
        const viewingSelf = String(targetUserId) === String(req.user._id);
        const today = getStartOfDayIST();

        if (!viewingSelf) {
            const targetUser = await User.findOne({ _id: targetUserId, companyId: req.companyId })
                .select('reportingManagers')
                .lean();

            if (!targetUser) {
                return res.status(404).json({ message: 'User not found' });
            }

            const isManager = (targetUser.reportingManagers || []).some(managerId => String(managerId) === String(req.user._id));
            if (!canViewOtherAttendance(req.user) && !isManager) {
                return res.status(403).json({ message: 'Not authorized to view this user attendance' });
            }
        }

        const companyPromise = Company.findById(req.companyId).select('settings.attendance').lean();
        const historyPromise = Attendance.find({
            companyId: req.companyId,
            user: targetUserId,
            date: { $gte: start, $lt: end }
        })
            .select('date clockIn clockInIST clockOut clockOutIST duration status user attendanceMode shiftCode shiftName shiftType shiftStartTime shiftEndTime maxWorkingHours autoCheckoutAt autoCheckoutReason')
            .populate('user', 'firstName lastName')
            .sort({ date: -1 })
            .lean();
        const holidaysPromise = Holiday.find({
            companyId: req.companyId,
            date: { $gte: start, $lt: end }
        })
            .select('name date isOptional')
            .sort({ date: 1 })
            .lean();
        const leavesPromise = LeaveRequest.find({
            user: targetUserId,
            companyId: req.companyId,
            status: 'Approved'
        })
            .sort({ createdAt: -1 })
            .select('leaveType startDate endDate isHalfDay reason status createdAt daysCount')
            .lean();
        const statusPromise = viewingSelf
            ? Attendance.findOne({
                user: req.user._id,
                companyId: req.companyId,
                date: {
                    $gte: today,
                    $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            })
                .select('user clockIn clockInIST clockOut clockOutIST status attendanceMode shiftCode shiftName shiftType shiftStartTime shiftEndTime maxWorkingHours autoCheckoutAt autoCheckoutReason')
                .lean()
            : Promise.resolve(null);
        const recentLogsPromise = viewingSelf
            ? WorkLog.find({ user: req.user._id, companyId: req.companyId })
                .populate({ path: 'task', select: 'name' })
                .sort({ date: -1 })
                .limit(parseInt(req.query.logsLimit, 10) || 4)
                .lean()
            : Promise.resolve([]);

        const [company, history, holidays, approvedLeaves, status, recentLogs] = await Promise.all([
            companyPromise,
            historyPromise,
            holidaysPromise,
            leavesPromise,
            statusPromise,
            recentLogsPromise
        ]);

        res.json({
            status: viewingSelf ? (status || { status: 'Not Clocked In' }) : null,
            history,
            holidays,
            approvedLeaves,
            recentLogs,
            weeklyOff: company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'],
            attendanceSettings: company?.settings?.attendance || {}
        });
    } catch (error) {
        console.error('getAttendanceBootstrap error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.getLeavesBootstrap = async (req, res) => {
    try {
        // Leave data must always be fresh — never serve from HTTP cache
        res.set('Cache-Control', 'no-cache');
        const year = new Date().getFullYear();
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;
        const userEmploymentType = req.user.employmentType || 'Full Time';

        const [allPolicies, existingBalances, leaves, total, configs] = await Promise.all([
            LeaveConfig.find({ isActive: true, companyId: req.companyId }).lean(),
            LeaveBalance.find({ user: req.user._id, year, companyId: req.companyId }).lean(),
            LeaveRequest.find({ user: req.user._id, companyId: req.companyId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .select('leaveType startDate endDate isHalfDay reason status createdAt daysCount')
                .lean(),
            LeaveRequest.countDocuments({ user: req.user._id, companyId: req.companyId }),
            LeaveConfig.find({ companyId: req.companyId }).select('leaveType sandwichRule').lean()
        ]);

        const policies = allPolicies.filter(policy =>
            !policy.employeeTypes ||
            policy.employeeTypes.length === 0 ||
            policy.employeeTypes.includes(userEmploymentType)
        );

        const balanceMap = new Map(existingBalances.map(balance => [balance.leaveType, balance]));
        const balances = policies.map(policy => {
            const existing = balanceMap.get(policy.leaveType);
            const openingBalance = existing?.openingBalance || 0;
            const accrued = existing?.accrued ?? getInitialAccruedBalance(policy);
            const utilized = existing?.utilized || 0;
            const encashed = existing?.encashed || 0;

            return {
                ...(existing || {
                    user: req.user._id,
                    leaveType: policy.leaveType,
                    year,
                    openingBalance,
                    accrued,
                    utilized,
                    encashed,
                    closingBalance: openingBalance + accrued - utilized - encashed,
                    companyId: req.companyId
                }),
                closingBalance: openingBalance + accrued - utilized - encashed,
                policyName: policy.name,
                policyDescription: policy.description,
                policyAccrualAmount: policy.accrualAmount,
                proofRequiredAbove: policy.proofRequiredAbove
            };
        });

        const sandwichMap = configs.reduce((accumulator, config) => {
            accumulator[config.leaveType] = config.sandwichRule || false;
            return accumulator;
        }, {});

        res.json({
            balances,
            requests: leaves.map(leave => ({
                ...leave,
                sandwichRule: sandwichMap[leave.leaveType] || false
            })),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('getLeavesBootstrap error:', error);
        res.status(500).json({ message: 'Server Error', details: error.message });
    }
};

exports.getTimesheetBootstrap = async (req, res) => {
    try {
        setPrivateCache(res, 20);
        const targetUserId = req.query.userId || req.user._id;
        const periodId = req.query.month || format(new Date(), 'yyyy-MM');
        const year = parseInt(req.query.year, 10) || new Date().getFullYear();
        const month = parseInt(req.query.monthNumber, 10) || (new Date().getMonth() + 1);
        const viewingSelf = String(targetUserId) === String(req.user._id);

        if (!viewingSelf) {
            const targetUser = await User.findOne({ _id: targetUserId, companyId: req.companyId })
                .select('reportingManagers')
                .lean();

            if (!targetUser) {
                return res.status(404).json({ message: 'User not found' });
            }

            const isManager = (targetUser.reportingManagers || []).some(managerId => String(managerId) === String(req.user._id));
            if (!canViewOtherTimesheets(req.user) && !isManager) {
                return res.status(403).json({ message: 'Not authorized to view this timesheet' });
            }
        }

        const { start, end } = getMonthRange(year, month);
        const usersListPromise = canLoadUserList(req.user)
            ? isAdminUser(req.user) || req.user?.permissions?.includes('timesheet.view') || req.user?.permissions?.includes('*')
                ? User.find({ companyId: req.companyId }).select('firstName lastName email employeeCode').lean()
                : User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('firstName lastName email employeeCode').lean()
            : Promise.resolve([]);

        const [timesheet, projects, holidays, usersList] = await Promise.all([
            getTimesheetDocument({
                requestUser: req.user,
                companyId: req.companyId,
                targetUserId,
                periodId
            }),
            getTimesheetProjectsForUser({
                requestUser: req.user,
                companyId: req.companyId,
                targetUserId
            }),
            Holiday.find({
                companyId: req.companyId,
                date: { $gte: start, $lt: end }
            })
                .select('name date isOptional')
                .sort({ date: 1 })
                .lean(),
            usersListPromise
        ]);

        res.json({
            timesheet,
            attendanceLogs: timesheet.attendanceLog || [],
            projects,
            holidays,
            weeklyOff: timesheet.weeklyOff || ['Sunday'],
            usersList
        });
    } catch (error) {
        console.error('getTimesheetBootstrap error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

exports.getNotificationBootstrap = async (req, res) => {
    try {
        // Notifications are real-time data — never serve from cache.
        res.set('Cache-Control', 'no-store');
        const includeInterviews = req.query.includeInterviews === 'true';

        const notificationsPromise = Notification.find({
            user: req.user._id,
            $or: [
                { companyId: req.companyId },
                { companyId: { $exists: false } },
                { companyId: null }
            ]
        })
            .select('title message type isRead link metadata createdAt')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        const interviewsPromise = includeInterviews
            ? Candidate.find({
                companyId: req.companyId,
                interviewRounds: {
                    $elemMatch: {
                        assignedTo: req.user._id,
                        status: { $in: ['Pending', 'Scheduled'] }
                    }
                }
            })
                .populate('hiringRequestId', 'requestId roleDetails')
                .select('candidateName email mobile interviewRounds hiringRequestId')
                .lean()
            : Promise.resolve([]);

        const [notifications, candidates] = await Promise.all([
            notificationsPromise,
            interviewsPromise
        ]);

        const interviews = includeInterviews
            ? candidates.flatMap(candidate =>
                (candidate.interviewRounds || [])
                    .filter(round => {
                        const assigned = Array.isArray(round.assignedTo) && round.assignedTo.some(id => String(id) === String(req.user._id));
                        return assigned && ['Pending', 'Scheduled'].includes(round.status);
                    })
                    .map(round => ({
                        candidateId: candidate._id,
                        candidateName: candidate.candidateName,
                        candidateEmail: candidate.email,
                        candidateMobile: candidate.mobile,
                        role: candidate.hiringRequestId?.roleDetails?.title || 'Unknown Role',
                        hiringRequestId: candidate.hiringRequestId?._id,
                        roundId: round._id,
                        phase: round.phase || 1,
                        levelName: round.levelName,
                        scheduledDate: round.scheduledDate,
                        status: round.status
                    }))
            ).sort((a, b) => {
                if (!a.scheduledDate) return 1;
                if (!b.scheduledDate) return -1;
                return new Date(a.scheduledDate) - new Date(b.scheduledDate);
            })
            : [];

        res.json({ notifications, interviews });
    } catch (error) {
        console.error('getNotificationBootstrap error:', error);
        res.status(500).json({ message: 'Server error fetching notification bootstrap' });
    }
};

exports.getDiscussionsBootstrap = async (req, res) => {
    try {
        setPrivateCache(res, 30);
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;

        const totalPromise = Discussion.countDocuments({ companyId: req.companyId });
        const discussionsPromise = Discussion.aggregate([
            { $match: { companyId: new (require('mongoose')).Types.ObjectId(req.companyId) } },
            {
                $addFields: {
                    isCompleted: { $cond: { if: { $eq: ['$status', 'mark as complete'] }, then: 1, else: 0 } }
                }
            },
            { $sort: { isCompleted: 1, createdAt: -1 } },
            { $skip: skip },
            { $limit: limit }
        ]);
        const supervisorsPromise = User.find({ companyId: req.companyId, isActive: true })
            .select('firstName lastName email profilePicture')
            .sort({ firstName: 1 })
            .lean();

        const [total, discussionRows, supervisors] = await Promise.all([
            totalPromise,
            discussionsPromise,
            supervisorsPromise
        ]);

        const discussions = await Discussion.populate(discussionRows, [
            { path: 'createdBy', select: 'firstName lastName email profilePicture' },
            { path: 'supervisor', select: 'firstName lastName email profilePicture' }
        ]);

        res.status(200).json({
            discussions,
            supervisors,
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            total
        });
    } catch (error) {
        console.error('getDiscussionsBootstrap error:', error);
        res.status(500).json({ message: 'Error fetching discussions bootstrap', error: error.message });
    }
};

exports.getHelpdeskBootstrap = async (req, res) => {
    try {
        // Caching disabled for real-time visibility consistency
        // setPrivateCache(res, 20);
        const isAdmin = req.user.roles.some(r => ['Admin', 'System'].includes(r.name || r) || r.isSystem === true);
        const isResolverRole = req.user.roles.some(r => ['HR', 'Supervisor', 'Admin', 'System'].includes(r.name || r));

        const myQueriesPromise = HelpdeskQuery.find({ raisedBy: req.user._id, companyId: req.companyId })
            .populate('queryType', 'name')
            .populate('assignedTo', 'firstName lastName email')
            .sort({ createdAt: -1 })
            .lean();
        const assignedQueriesPromise = HelpdeskQuery.find({ assignedTo: req.user._id, companyId: req.companyId })
                .populate('raisedBy', 'firstName lastName email')
                .populate('queryType', 'name')
                .sort({ priority: -1, createdAt: 1 })
                .lean();
        const allQueriesPromise = isAdmin
            ? HelpdeskQuery.find({ companyId: req.companyId })
                .populate('raisedBy', 'firstName lastName email')
                .populate('assignedTo', 'firstName lastName email')
                .populate('queryType', 'name')
                .sort({ priority: -1, createdAt: -1 })
                .lean()
            : Promise.resolve([]);
        const escalatedQueriesPromise = isAdmin
            ? HelpdeskQuery.find({ status: 'Escalated', companyId: req.companyId })
                .populate('raisedBy', 'firstName lastName email')
                .populate('assignedTo', 'firstName lastName email')
                .populate('queryType', 'name')
                .sort({ escalatedAt: -1 })
                .lean()
            : Promise.resolve([]);

        const [myQueries, assignedQueries, allQueries, escalatedQueries] = await Promise.all([
            myQueriesPromise,
            assignedQueriesPromise,
            allQueriesPromise,
            escalatedQueriesPromise
        ]);

        res.status(200).json({
            myQueries,
            assignedQueries,
            allQueries,
            escalatedQueries,
            isAdmin,
            isResolverRole
        });
    } catch (error) {
        console.error('getHelpdeskBootstrap error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

exports.getProjectBootstrap = async (req, res) => {
    try {
        setPrivateCache(res, 30);
        const canManageProjects = canManageProjectDirectory(req.user);
        const projectFilter = await buildProjectVisibilityFilter({
            requestUser: req.user,
            companyId: req.companyId
        });

        const [projects, clients, businessUnits, employees] = await Promise.all([
            Project.find(projectFilter)
                .populate('client', 'name')
                .populate('members', '_id')
                .sort({ createdAt: -1 })
                .lean(),
            canManageProjects
                ? Client.find({ companyId: req.companyId })
                    .populate('businessUnit', 'name')
                    .sort({ name: 1 })
                    .lean()
                : Promise.resolve([]),
            canManageProjects
                ? BusinessUnit.find({ companyId: req.companyId })
                    .populate('headOfUnit', 'firstName lastName')
                    .sort({ createdAt: -1 })
                    .lean()
                : Promise.resolve([]),
            canManageProjects
                ? User.find({ companyId: req.companyId })
                    .select('firstName lastName email')
                    .sort({ firstName: 1, lastName: 1 })
                    .lean()
                : Promise.resolve([])
        ]);

        res.json({ projects, clients, businessUnits, employees });
    } catch (error) {
        console.error('getProjectBootstrap error:', error);
        res.status(500).json({ message: 'Failed to fetch project bootstrap' });
    }
};

exports.getRoleBootstrap = async (req, res) => {
    try {
        // Role data must always be fresh — never serve from HTTP cache
        res.set('Cache-Control', 'no-cache');
        const [roles, permissions] = await Promise.all([
            Role.find({ companyId: req.companyId }).populate('permissions').lean(),
            Permission.find({}).lean()
        ]);

        const groupedPermissions = permissions
            .filter(permission => permission.key !== '*')
            .reduce((acc, curr) => {
                let groupName = curr.module || 'OTHER';

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

        res.json({ roles, permissions: groupedPermissions });
    } catch (error) {
        console.error('getRoleBootstrap error:', error);
        res.status(500).json({ message: 'Failed to fetch role bootstrap' });
    }
};

exports.getOnboardingBootstrap = async (req, res) => {
    try {
        setPrivateCache(res, 30);
        const tab = req.query.tab === 'settings' ? 'settings' : 'employees';

        if (tab === 'settings') {
            const company = await Company.findById(req.companyId).select('settings.onboarding').lean();
            return res.json({
                settings: company?.settings?.onboarding || {
                    offerLetterTemplateUrl: '',
                    declarationTemplateUrl: '',
                    policies: [],
                    dynamicTemplates: []
                }
            });
        }

        const { status, page = 1, limit = 15, search } = req.query;
        let query = { companyId: req.companyId };
        if (status && status !== 'All') query.status = status;
        if (search) {
            query.$or = [
                { firstName: { $regex: search, $options: 'i' } },
                { lastName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { tempEmployeeId: { $regex: search, $options: 'i' } }
            ];
        }

        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        const skip = (pageNum - 1) * limitNum;

        const [employees, total, stats] = await Promise.all([
            OnboardingEmployee.find(query)
                .select('-tempPassword -auditLog')
                .populate('createdBy', 'firstName lastName')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            OnboardingEmployee.countDocuments(query),
            OnboardingEmployee.aggregate([
                { $match: { companyId: new (require('mongoose')).Types.ObjectId(req.companyId) } },
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ])
        ]);

        const statsMap = { Pending: 0, 'In Progress': 0, Submitted: 0, Reviewed: 0 };
        stats.forEach(item => {
            if (item?._id) statsMap[item._id] = item.count;
        });

        res.json({
            employees,
            stats: statsMap,
            page: pageNum,
            totalPages: Math.ceil(total / limitNum),
            total
        });
    } catch (error) {
        console.error('getOnboardingBootstrap error:', error);
        res.status(500).json({ message: 'Failed to fetch onboarding bootstrap' });
    }
};
