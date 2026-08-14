const User = require('../user/user.model');
const Attendance = require('../attendance/model/attendance.model');
const Project = require('../project/project.model');
const Company = require('../company/company.model');
const LeaveRequest = require('../leave/model/leaveRequest.model');

const DEFAULT_ATTENDANCE_LIMIT = 10;
const IST_TIME_ZONE = 'Asia/Kolkata';

const getCurrentIstDateString = () => new Date().toLocaleDateString('en-CA', { timeZone: IST_TIME_ZONE });

const getIstDayRange = (attendanceDateParam) => {
    const todayLabel = getCurrentIstDateString();

    if (attendanceDateParam) {
        const trimmed = String(attendanceDateParam).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            const safeLabel = trimmed > todayLabel ? todayLabel : trimmed;
            const start = new Date(`${safeLabel}T00:00:00.000+05:30`);
            if (!Number.isNaN(start.getTime())) {
                const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
                return { start, end, label: safeLabel };
            }
        }
    }

    const istString = todayLabel;
    const start = new Date(`${istString}T00:00:00.000+05:30`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end, label: istString };
};

// @desc    Get Dashboard Statistics
// @route   GET /api/dashboard
// @access  Private
const getDashboardStats = async (req, res) => {
    try {
        const attendanceLimitParam = String(req.query.attendanceLimit || DEFAULT_ATTENDANCE_LIMIT).trim().toLowerCase();
        const fetchAllAttendance = attendanceLimitParam === 'all';
        const parsedAttendanceLimit = Number.parseInt(attendanceLimitParam, 10);
        const attendanceLimit = fetchAllAttendance
            ? null
            : Number.isFinite(parsedAttendanceLimit) && parsedAttendanceLimit > 0
                ? parsedAttendanceLimit
                : DEFAULT_ATTENDANCE_LIMIT;

        const attendanceDay = getIstDayRange(req.query.attendanceDate);
        const today = attendanceDay.start;
        const tomorrow = attendanceDay.end;

        // CRIT-1 Fix: Use aggregation instead of loading ALL users into Node.js memory.
        // Single pipeline: matches active users, joins roles, identifies system/primary users,
        // and groups to produce the user ID list — all on the DB side.
        const [activeUsersResult, company] = await Promise.all([
            User.aggregate([
                {
                    $match: {
                        companyId: req.companyId,
                        isActive: true,
                        isDeleted: { $ne: true }
                    }
                },
                {
                    // Lookup only needed role fields
                    $lookup: {
                        from: 'roles',
                        localField: 'roles',
                        foreignField: '_id',
                        as: 'rolesResolved',
                        pipeline: [{ $project: { name: 1, isSystem: 1 } }]
                    }
                },
                {
                    $project: {
                        _id: 1,
                        email: 1,
                        createdAt: 1,
                        firstName: 1,
                        lastName: 1,
                        employmentType: 1,
                        workLocation: 1,
                        isTotalWorkforce: 1,
                        roles: '$rolesResolved',
                        isSystemUser: {
                            $gt: [
                                { $size: { $filter: { input: '$rolesResolved', as: 'r', cond: { $eq: ['$$r.isSystem', true] } } } },
                                0
                            ]
                        }
                    }
                }
            ]),
            Company.findById(req.companyId).select('email').lean()
        ]);

        const primaryAdminEmail = company?.email?.toLowerCase();

        // Identify primary admin (same logic as before, but data came from aggregation)
        const systemUsers = activeUsersResult.filter(u => u.isSystemUser);
        const oldestSystemUser = systemUsers.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
        const oldestSystemUserId = oldestSystemUser?._id?.toString();

        const filteredUsers = activeUsersResult.filter(u => {
            const isMatchByEmail   = u.email?.toLowerCase() === primaryAdminEmail;
            const isMatchByOldest  = u._id?.toString() === oldestSystemUserId;
            const isPrimaryAccount = isMatchByEmail || isMatchByOldest;
            return !(u.isSystemUser && isPrimaryAccount);
        });

        // Exclude users configured as not part of Total Workforce (isTotalWorkforce === false)
        const totalWorkforceUsers = filteredUsers.filter(u => u.isTotalWorkforce !== false);
        const nonSystemUserIds = totalWorkforceUsers.map(u => u._id);
        const allActiveUserIds = filteredUsers.map(u => u._id);
        const totalEmployees = nonSystemUserIds.length;

        const attendanceQuery = {
            companyId: req.companyId,
            user: { $in: nonSystemUserIds },
            date: { $gte: today, $lt: tomorrow },
            status: { $in: ['PRESENT', 'HALF_DAY'] }
        };

        const recentAttendanceQuery = {
            companyId: req.companyId,
            user: { $in: allActiveUserIds },
            date: { $gte: today, $lt: tomorrow },
            status: { $in: ['PRESENT', 'HALF_DAY'] }
        };

        // HIGH-5 Fix: Replace nested populate (N+1) with $lookup aggregation for leaves
        const [
            presentTodayCount,
            pendingRequests,
            todaysAttendance,
            allProjects,
            approvedLeavesToday,
            pendingLeaveRequests
        ] = await Promise.all([
            Attendance.countDocuments(attendanceQuery),
            Attendance.countDocuments({
                approvalStatus: 'PENDING',
                companyId: req.companyId,
                user: { $in: nonSystemUserIds }
            }),
            Attendance.find(recentAttendanceQuery)
                .sort({ clockIn: -1, createdAt: -1 })
                .limit(attendanceLimit || 0)
                .select('user status clockIn clockOut location clockOutLocation attendanceMode')
                .lean(),
            Project.find({ companyId: req.companyId })
                .sort({ updatedAt: -1 })
                .limit(10)
                .select('name isActive status dueDate')
                .lean(),
            // HIGH-5: $lookup replaces nested populate — 1 query instead of 1 + N*2
            LeaveRequest.aggregate([
                {
                    $match: {
                        companyId: req.companyId,
                        user: { $in: nonSystemUserIds },
                        status: 'Approved',
                        startDate: { $lt: tomorrow },
                        endDate: { $gte: today }
                    }
                },
                { $sort: { startDate: 1, createdAt: -1 } },
                {
                    $lookup: {
                        from: 'users',
                        localField: 'user',
                        foreignField: '_id',
                        as: 'userDoc',
                        pipeline: [{ $project: { firstName: 1, lastName: 1, employmentType: 1, roles: 1 } }]
                    }
                },
                { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
                {
                    $lookup: {
                        from: 'roles',
                        localField: 'userDoc.roles',
                        foreignField: '_id',
                        as: 'userDoc.rolesResolved',
                        pipeline: [{ $project: { name: 1 } }]
                    }
                },
                {
                    $project: {
                        _id: 1,
                        leaveType: 1,
                        startDate: 1,
                        endDate: 1,
                        daysCount: 1,
                        isHalfDay: 1,
                        halfDaySession: 1,
                        status: 1,
                        'userDoc.firstName': 1,
                        'userDoc.lastName': 1,
                        'userDoc.employmentType': 1,
                        'userDoc.rolesResolved': 1
                    }
                }
            ]),
            LeaveRequest.countDocuments({
                companyId: req.companyId,
                user: { $in: nonSystemUserIds },
                status: 'Pending'
            })
        ]);

        const presentToday = presentTodayCount;
        const absentToday  = Math.max(0, totalEmployees - presentToday);

        const usersById = new Map(filteredUsers.map(user => [user._id.toString(), user]));

        const dailyStatusList = todaysAttendance.reduce((acc, record) => {
            const user = usersById.get(record.user.toString());
            if (!user) return acc;
            const roleName = user.roles?.length > 0 ? user.roles[0].name : 'Employee';

            acc.push({
                id: user._id,
                user: {
                    name: `${user.firstName} ${user.lastName}`,
                    role: roleName,
                    employmentType: user.employmentType || 'Employee',
                    avatar: null,
                    isTotalWorkforce: user.isTotalWorkforce !== false
                },
                time: record.clockIn,
                clockOut: record.clockOut,
                attendanceMode: record.attendanceMode || 'clock_in_out',
                status: record.status || 'PRESENT',
                location: record.location || record.clockOutLocation || (user.workLocation ? { name: user.workLocation } : null),
                clockOutLocation: record.clockOutLocation || null
            });
            return acc;
        }, []);

        const projectsFormatted = allProjects.map(p => ({
            _id: p._id,
            name: p.name,
            status: p.status || (p.isActive ? 'Active' : 'Inactive'),
            deadline: p.dueDate
        }));

        const leavesToday = approvedLeavesToday.map(leave => {
            const rolesArr = leave.userDoc?.rolesResolved || [];
            const roleName = rolesArr.length > 0 ? rolesArr[0].name : 'Employee';

            return {
                _id: leave._id,
                user: {
                    name: `${leave.userDoc?.firstName || ''} ${leave.userDoc?.lastName || ''}`.trim() || 'Employee',
                    role: roleName,
                    employmentType: leave.userDoc?.employmentType || 'Employee'
                },
                leaveType: leave.leaveType,
                startDate: leave.startDate,
                endDate: leave.endDate,
                daysCount: leave.daysCount,
                isHalfDay: leave.isHalfDay,
                halfDaySession: leave.halfDaySession,
                status: leave.status
            };
        });

        res.json({
            stats: {
                totalEmployees,
                presentToday,
                absentToday,
                pendingRequests,
                leaveToday: leavesToday.length,
                pendingLeaveRequests
            },
            recentActivity: dailyStatusList,
            recentActivityMeta: {
                total: presentTodayCount,
                limit: attendanceLimit,
                hasMore: !fetchAllAttendance && presentTodayCount > dailyStatusList.length,
                date: attendanceDay.label
            },
            projects: projectsFormatted,
            leavesToday
        });

    } catch (error) {
        console.error('Dashboard Stats Error:', error);
        res.status(500).json({ message: 'Server Error fetching dashboard data' });
    }
};

module.exports = { getDashboardStats };
