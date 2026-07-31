const { startOfMonth, endOfMonth, format } = require('date-fns');
const { Types: { ObjectId: MongooseObjectId } } = require('mongoose'); // MED-6: moved from inside aggregation
const Attendance = require('../models/Attendance');
const Candidate = require('../models/Candidate');
const BusinessUnit = require('../models/BusinessUnit');
const Client = require('../models/Client');
const Company = require('../models/Company');
const Discussion = require('../models/Discussion');
const { attachDiscussionPermissions, buildAccessibleDiscussionMatch } = require('../utils/discussionAccess');
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
const { filterPermissionsByEnabledModules } = require('../utils/enabledModules');
const Timesheet = require('../models/Timesheet');
const User = require('../models/User');
const WorkLog = require('../models/WorkLog');
const { getStartOfDayIST } = require('../utils/attendancePolicy');
const { buildTimesheetPeriodRange, getTimesheetPeriodIdForDate } = require('../utils/timesheetPeriod');
const { populateWorkLogHierarchy, mapWorkLogToTimesheetEntry } = require('./timesheetController');

// HIGH-1: Global permission cache — permissions rarely change, 10-minute TTL is safe
const PERMISSION_CACHE_TTL_MS = 10 * 60 * 1000;
let _permissionCache = null;
let _permissionCachedAt = 0;
const getCachedPermissions = async () => {
    if (_permissionCache && (Date.now() - _permissionCachedAt) < PERMISSION_CACHE_TTL_MS) {
        return _permissionCache;
    }
    _permissionCache = await Permission.find({}).lean();
    _permissionCachedAt = Date.now();
    return _permissionCache;
};

const LEGACY_HIDDEN_PERMISSION_KEYS = new Set([
    'ta.analytics.requisition',
    'ta.client.confidential.view',
    'ta.offer.create',
    'ta.offer.view',
    'ta.offer.approve',
    'ta.offer.revoke'
]);

const isVisiblePermission = (permission) =>
    permission &&
    permission.key !== '*' &&
    permission.isDeprecated !== true &&
    !LEGACY_HIDDEN_PERMISSION_KEYS.has(permission.key);

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

// MED-9: Parallelized into two tiers instead of 5 sequential awaits
const buildProjectVisibilityFilter = async ({ requestUser, companyId }) => {
    const filter = { companyId };
    const canViewAll      = isAdminUser(requestUser) || hasPermission(requestUser, 'project.read');
    const canViewAssigned = hasPermission(requestUser, 'project.view_assigned');
    const canViewTeam     = hasPermission(requestUser, 'project.view_team');

    if (canViewAll) return filter;
    if (!canViewAssigned && !canViewTeam) return { ...filter, _id: null };

    // ── Tier 1: Parallel — user's own assigned tasks + direct reports ────────
    const [assignedModuleIds, directReports] = await Promise.all([
        Task.distinct('module', { assignees: requestUser._id, companyId }),
        canViewTeam
            ? User.find({ reportingManagers: requestUser._id, companyId }).select('_id').lean()
            : Promise.resolve([])
    ]);

    const reportIds = directReports.map(u => u._id);

    // ── Tier 2: Parallel — resolve module IDs → project IDs ─────────────────
    const [taskProjectIds, teamAssignedModuleIds] = await Promise.all([
        assignedModuleIds.length > 0
            ? Module.distinct('project', { _id: { $in: assignedModuleIds }, companyId })
            : Promise.resolve([]),
        reportIds.length > 0
            ? Task.distinct('module', { assignees: { $in: reportIds }, companyId })
            : Promise.resolve([])
    ]);

    // ── Tier 3: Resolve team module IDs → project IDs ───────────────────────
    const teamTaskProjectIds = teamAssignedModuleIds.length > 0
        ? await Module.distinct('project', { _id: { $in: teamAssignedModuleIds }, companyId })
        : [];

    const orConditions = [
        { manager: requestUser._id },
        { members: requestUser._id },
        ...(taskProjectIds.length > 0     ? [{ _id: { $in: taskProjectIds } }] : []),
        ...(reportIds.length > 0          ? [{ manager: { $in: reportIds } }, { members: { $in: reportIds } }] : []),
        ...(teamTaskProjectIds.length > 0 ? [{ _id: { $in: teamTaskProjectIds } }] : [])
    ];

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
    const start = new Date(`${yearValue}-${String(monthValue).padStart(2, '0')}-01T00:00:00.000+05:30`);
    let nextMonth = monthValue + 1;
    let nextYear = yearValue;
    if (nextMonth > 12) {
        nextMonth = 1;
        nextYear += 1;
    }
    const end = new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00.000+05:30`);
    return { start, end };
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

// HIGH-3: Parallelized timesheet + user + company queries (were 3 sequential awaits)
const getTimesheetDocument = async ({ requestUser, companyId, targetUserId, periodId }) => {
    // First get the company to determine cycle (needed for period range calculation)
    // Run timesheet + user + company fetches simultaneously
    const [timesheetRaw, fullUser, company] = await Promise.all([
        Timesheet.findOne({ user: targetUserId, month: periodId, companyId }).lean(),
        User.findOne({ _id: targetUserId, companyId })
            .select('firstName lastName email employeeCode joiningDate reportingManagers attendanceMode')
            .populate('reportingManagers', 'firstName lastName email')
            .lean(),
        Company.findById(companyId)
            .select('settings.attendance.weeklyOff settings.timesheet.approvalCycle')
            .lean()
    ]);

    let timesheet = timesheetRaw;
    if (!timesheet && String(targetUserId) === String(requestUser._id)) {
        const created = await Timesheet.create({
            user: targetUserId,
            month: periodId,
            companyId,
            status: 'DRAFT',
            rejectionReason: ''
        });
        timesheet = created.toObject();
    }

    const cycle = company?.settings?.timesheet?.approvalCycle || 'Monthly';
    const { start, end } = buildTimesheetPeriodRange(periodId, cycle);

    const [workLogs, attendance] = await Promise.all([
        populateWorkLogHierarchy(WorkLog.find({
            user: targetUserId,
            companyId,
            date: { $gte: start, $lte: end }
        })).sort({ date: 1 }).lean(),
        Attendance.find({
            user: targetUserId,
            companyId,
            date: { $gte: start, $lte: end }
        })
            .select('date clockInIST clockOutIST duration clockIn clockOut status approvalStatus attendanceMode maxWorkingHours')
            .lean()
    ]);

    const entries = workLogs.map(mapWorkLogToTimesheetEntry);

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
        res.set('Cache-Control', 'no-store');
        const targetUserId = req.query.userId || req.user._id;
        const year = parseInt(req.query.year, 10) || new Date().getFullYear();
        const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
        const { start, end } = getMonthRange(year, month);
        const viewingSelf = String(targetUserId) === String(req.user._id);
        const today = getStartOfDayIST();

        const targetUserPromise = User.findOne({ _id: targetUserId, companyId: req.companyId })
            .select('firstName lastName email roles employmentType flexWeeklyOffCount customFlexibleOffDays joiningDate reportingManagers attendanceMode attendanceShiftCode')
            .populate('roles', 'name')
            .lean();

        const targetUser = await targetUserPromise;
        if (!targetUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (!viewingSelf) {
            const isManager = (targetUser.reportingManagers || []).some(managerId => String(managerId) === String(req.user._id));
            if (!canViewOtherAttendance(req.user) && !isManager) {
                return res.status(403).json({ message: 'Not authorized to view this user attendance' });
            }
        }

        const companyPromise = Company.findById(req.companyId).select('settings.attendance settings.timesheet.approvalCycle').lean();
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
        // MED-4: Add year date-range so we don't load years of leave history
        const yearStart = new Date(`${year}-01-01T00:00:00.000+05:30`);
        const yearEnd   = new Date(`${year + 1}-01-01T00:00:00.000+05:30`);
        const leavesPromise = LeaveRequest.find({
            user: targetUserId,
            companyId: req.companyId,
            status: 'Approved',
            startDate: { $gte: yearStart, $lt: yearEnd }
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

        const approvalCycle = company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = getTimesheetPeriodIdForDate(start, approvalCycle);
        const timesheetSummary = await Timesheet.findOne({
            user: targetUserId,
            companyId: req.companyId,
            month: periodId
        })
            .select('month status submittedAt updatedAt rejectionReason')
            .lean();

        const rawAttendanceSettings = company?.settings?.attendance || {};
        const isAdmin = isAdminUser(req.user);

        const attendanceSettings = {
            weeklyOff: rawAttendanceSettings.weeklyOff || ['Saturday', 'Sunday'],
            workingHours: rawAttendanceSettings.workingHours || 8,
            defaultShiftCode: rawAttendanceSettings.defaultShiftCode || 'general',
            defaultAttendanceMode: rawAttendanceSettings.defaultAttendanceMode || 'clock_in_out',
            attendanceShifts: rawAttendanceSettings.attendanceShifts || [],
            flexWeeklyOff: rawAttendanceSettings.flexWeeklyOff || {},
            halfDayAllowed: rawAttendanceSettings.halfDayAllowed ?? true,
            requireLocationCheckIn: rawAttendanceSettings.requireLocationCheckIn ?? false,
            requireLocationCheckOut: rawAttendanceSettings.requireLocationCheckOut ?? false,
            requireLocationTimesheet: rawAttendanceSettings.requireLocationTimesheet ?? false,
            locationCheck: rawAttendanceSettings.locationCheck ?? false,
            ipCheck: rawAttendanceSettings.ipCheck ?? false,
            selfService: rawAttendanceSettings.selfService || {},
            exportFormat: rawAttendanceSettings.exportFormat || 'Standard',
            ...(isAdmin ? {
                allowedIps: rawAttendanceSettings.allowedIps || [],
                allowedRadius: rawAttendanceSettings.allowedRadius || 200,
                coordinates: rawAttendanceSettings.coordinates || { lat: 0, lng: 0 }
            } : {})
        };

        res.json({
            status: viewingSelf ? (status || { status: 'Not Clocked In' }) : null,
            history,
            holidays,
            approvedLeaves,
            recentLogs,
            targetUser,
            customFlexibleOffDays: targetUser?.customFlexibleOffDays || [],
            weeklyOff: rawAttendanceSettings.weeklyOff || ['Saturday', 'Sunday'],
            attendanceSettings,
            timesheetSummary: timesheetSummary || {
                month: periodId,
                status: 'DRAFT',
                submittedAt: null,
                updatedAt: null,
                rejectionReason: ''
            }
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

        // MED-5: Merged two LeaveConfig.find() calls into one; derive both in memory
        const [allLeaveConfigs, existingBalances, leaves, total] = await Promise.all([
            LeaveConfig.find({ companyId: req.companyId }).lean(),
            LeaveBalance.find({ user: req.user._id, year, companyId: req.companyId }).lean(),
            LeaveRequest.find({ user: req.user._id, companyId: req.companyId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .select('leaveType startDate endDate isHalfDay reason status createdAt daysCount')
                .lean(),
            LeaveRequest.countDocuments({ user: req.user._id, companyId: req.companyId })
        ]);

        // Derive both active policies and sandwichMap from the single query result
        const allPolicies = allLeaveConfigs.filter(c => c.isActive);
        const sandwichMap = Object.fromEntries(allLeaveConfigs.map(c => [c.leaveType, c.sandwichRule || false]));

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
        res.set('Cache-Control', 'no-store');
        const targetUserId = req.query.userId || req.user._id;
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

        const company = await Company.findById(req.companyId)
            .select('settings.attendance.weeklyOff settings.timesheet.approvalCycle')
            .lean();
        const cycle = company?.settings?.timesheet?.approvalCycle || 'Monthly';
        const periodId = req.query.month || getTimesheetPeriodIdForDate(new Date(), cycle);
        const { start, end } = buildTimesheetPeriodRange(periodId, cycle);
        const usersListPromise = canLoadUserList(req.user)
            ? isAdminUser(req.user) || req.user?.permissions?.includes('timesheet.view') || req.user?.permissions?.includes('*')
                ? User.find({ companyId: req.companyId }).select('firstName lastName email employeeCode').lean()
                : User.find({ reportingManagers: req.user._id, companyId: req.companyId }).select('firstName lastName email employeeCode').lean()
            : Promise.resolve([]);

        const [timesheet, projects, holidays, approvedLeaves, usersList] = await Promise.all([
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
            LeaveRequest.find({
                user: targetUserId,
                companyId: req.companyId,
                status: 'Approved',
                startDate: { $lte: end },
                endDate: { $gte: start }
            })
                .select('leaveType startDate endDate isHalfDay halfDaySession reason status createdAt daysCount')
                .sort({ startDate: 1, createdAt: -1 })
                .lean(),
            usersListPromise
        ]);

        res.json({
            timesheet,
            attendanceLogs: timesheet.attendanceLog || [],
            projects,
            holidays,
            approvedLeaves,
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

        const interviewRoundMap = new Map(
            interviews.map((interview) => [
                String(interview.roundId),
                interview
            ])
        );

        const hydratedNotifications = notifications.map((notification) => {
            if (notification.type !== 'Interview') {
                return notification;
            }

            const linkedInterview = interviewRoundMap.get(String(notification.metadata?.roundId || ''));
            if (!linkedInterview) {
                return notification;
            }

            return {
                ...notification,
                link: `/ta/hiring-request/${linkedInterview.hiringRequestId}/candidate/${linkedInterview.candidateId}/view?phase=${linkedInterview.phase || 1}`,
                metadata: {
                    ...notification.metadata,
                    hiringRequestId: linkedInterview.hiringRequestId,
                    candidateId: linkedInterview.candidateId,
                    phase: linkedInterview.phase || 1
                }
            };
        });

        res.json({ notifications: hydratedNotifications, interviews });
    } catch (error) {
        console.error('getNotificationBootstrap error:', error);
        res.status(500).json({ message: 'Server error fetching notification bootstrap' });
    }
};

exports.getDiscussionsBootstrap = async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 100;
        const skip = (page - 1) * limit;

        const accessMatch = buildAccessibleDiscussionMatch(req.companyId, req.user);
        if (req.query.status) {
            accessMatch.status = req.query.status;
        }
        if (req.query.project) {
            accessMatch.project = req.query.project === 'null' ? null : new MongooseObjectId(String(req.query.project));
        }
        if (req.query.priority) {
            if (req.query.priority === 'Medium') {
                accessMatch.$and = accessMatch.$and || [];
                accessMatch.$and.push({
                    $or: [
                        { priority: 'Medium' },
                        { priority: { $exists: false } }
                    ]
                });
            } else {
                accessMatch.priority = req.query.priority;
            }
        }
        const totalPromise = Discussion.countDocuments(accessMatch);
        const discussionsPromise = Discussion.aggregate([
            { $match: accessMatch },
            {
                $addFields: {
                    isCompleted: { $cond: { if: { $eq: ['$status', 'mark as complete'] }, then: 1, else: 0 } }
                }
            },
            { $sort: { isCompleted: 1, createdAt: -1 } },
            { $skip: skip },
            { $limit: limit }
        ]);
        // HIGH-7: limit supervisors list — loading ALL users is O(N) with no benefit
        const supervisorsPromise = User.find({ companyId: req.companyId, isActive: true })
            .select('firstName lastName email profilePicture')
            .sort({ firstName: 1 })
            .limit(300)
            .lean();

        const [total, discussionRows, supervisors] = await Promise.all([
            totalPromise,
            discussionsPromise,
            supervisorsPromise
        ]);

        let discussions = await Discussion.populate(discussionRows, [
            { path: 'createdBy', select: 'firstName lastName email profilePicture' },
            { path: 'supervisor', select: 'firstName lastName email profilePicture' },
            { path: 'visibleToUsers', select: 'firstName lastName email profilePicture' },
            { path: 'project', select: 'name' }
        ]);

        if (discussions && discussions.length > 0) {
            const objectIds = [];
            const stringIds = [];
            discussions.forEach(d => {
                if (d && d._id) {
                    const strId = String(d._id);
                    stringIds.push(strId);
                    if (MongooseObjectId.isValid(strId)) {
                        objectIds.push(new MongooseObjectId(strId));
                    }
                }
            });
            const totals = await WorkLog.aggregate([
                {
                    $match: {
                        discussion: { $in: [...objectIds, ...stringIds] },
                        isDeleted: { $ne: true }
                    }
                },
                { $group: { _id: '$discussion', total: { $sum: '$hours' } } }
            ]);
            const totalsMap = new Map(totals.map(t => [String(t._id), t.total]));
            discussions = discussions.map(d => ({
                ...d,
                totalLoggedHours: totalsMap.get(String(d._id)) || 0
            }));
        }

        res.status(200).json({
            discussions: discussions.map((discussion) => attachDiscussionPermissions(discussion, req.user)),
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

        // CRIT-4: Added limits to all queries — previously loaded unlimited documents
        const { page: qPage = 1, limit: qLimit = 25 } = req.query;
        const qPageNum  = Math.max(parseInt(qPage, 10)  || 1, 1);
        const qLimitNum = Math.min(parseInt(qLimit, 10) || 25, 100);
        const qSkip     = (qPageNum - 1) * qLimitNum;

        const myQueriesPromise = HelpdeskQuery.find({ raisedBy: req.user._id, companyId: req.companyId })
            .populate('queryType', 'name')
            .populate('assignedTo', 'firstName lastName email')
            .sort({ createdAt: -1 })
            .limit(50) // personal queries capped at 50
            .lean();
        const assignedQueriesPromise = HelpdeskQuery.find({
            companyId: req.companyId,
            $or: [
                { assignedTo: req.user._id },
                { originalAssignee: req.user._id }
            ]
        })
            .populate('raisedBy', 'firstName lastName email')
            .populate('queryType', 'name')
            .sort({ createdAt: -1 })
            .limit(50) // assigned queries capped at 50
            .lean();
        const allQueriesPromise = isAdmin
            ? HelpdeskQuery.find({ companyId: req.companyId })
                .populate('raisedBy', 'firstName lastName email')
                .populate('assignedTo', 'firstName lastName email')
                .populate('queryType', 'name')
                .sort({ createdAt: -1 })
                .skip(qSkip).limit(qLimitNum) // paginated for admins
                .lean()
            : Promise.resolve([]);
        const escalatedQueriesPromise = isAdmin
            ? HelpdeskQuery.find({ status: 'Escalated', companyId: req.companyId })
                .populate('raisedBy', 'firstName lastName email')
                .populate('assignedTo', 'firstName lastName email')
                .populate('queryType', 'name')
                .sort({ escalatedAt: -1 })
                .limit(50) // escalated also capped
                .lean()
            : Promise.resolve([]);
        const allQueriesTotalPromise = isAdmin
            ? HelpdeskQuery.countDocuments({ companyId: req.companyId })
            : Promise.resolve(0);

        const [myQueries, assignedQueries, allQueries, escalatedQueries, allQueriesTotal] = await Promise.all([
            myQueriesPromise,
            assignedQueriesPromise,
            allQueriesPromise,
            escalatedQueriesPromise,
            allQueriesTotalPromise
        ]);

        res.status(200).json({
            myQueries,
            assignedQueries,
            allQueries,
            escalatedQueries,
            isAdmin,
            isResolverRole,
            pagination: isAdmin ? { page: qPageNum, limit: qLimitNum, total: allQueriesTotal, totalPages: Math.ceil(allQueriesTotal / qLimitNum) } : null
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
        const [rawRoles, permissions, company] = await Promise.all([
            Role.find({ companyId: req.companyId }).populate('permissions').lean(),
            getCachedPermissions(), // HIGH-1: use cache instead of Permission.find({}) every time
            Company.findById(req.companyId).select('enabledModules').lean()
        ]);
        const enabledModules = company?.enabledModules || [];

        const roles = rawRoles.map(role => ({
            ...role,
            permissions: filterPermissionsByEnabledModules((role.permissions || []).filter(isVisiblePermission), enabledModules)
        }));

        const filteredPermissions = filterPermissionsByEnabledModules(permissions.filter(isVisiblePermission), enabledModules);

        const groupedPermissions = filteredPermissions
            .reduce((acc, curr) => {
                let groupName = curr.module || 'OTHER';

                if (!curr.key) {
                    groupName = 'OTHER';
                } else if (curr.key.startsWith('business_unit.')) groupName = 'BUSINESS UNITS';
                else if (curr.key.startsWith('client.')) groupName = 'CLIENTS';
                else if (curr.key.startsWith('task.')) groupName = 'TASKS';
                else if (curr.key.startsWith('project.') || curr.key.startsWith('module.') || groupName === 'PROJECT') groupName = 'PROJECTS';
                else if (curr.key.startsWith('user.')) groupName = 'USER MANAGEMENT';
                else if (curr.key.startsWith('role.')) groupName = 'ROLE MANAGEMENT';
                else if (curr.key.startsWith('timesheet.')) groupName = 'TIMESHEETS';
                else if (curr.key.startsWith('attendance.')) groupName = 'ATTENDANCE';
                else if (curr.key.startsWith('ta.')) groupName = 'TALENT ACQUISITION';
                else if (curr.key.startsWith('announcement.')) groupName = 'ANNOUNCEMENTS';
                else if (curr.key.startsWith('onboarding.')) groupName = 'ONBOARDING';
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
        const tab = req.query.tab === 'settings' ? 'settings' : 'employees';

        if (tab === 'settings') {
            const company = await Company.findById(req.companyId).select('settings.onboarding').lean();
            const settings = company?.settings?.onboarding || {
                offerLetterTemplateUrl: '',
                declarationTemplateUrl: '',
                policies: [],
                dynamicTemplates: []
            };
            if (settings.dynamicTemplates) {
                settings.dynamicTemplates = settings.dynamicTemplates.filter(t => t.isDeleted !== true);
            }
            if (settings.policies) {
                settings.policies = settings.policies.filter(p => p.isDeleted !== true);
            }
            return res.json({ settings });
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
                { $match: { companyId: new MongooseObjectId(req.companyId) } }, // MED-6: uses top-level import
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
