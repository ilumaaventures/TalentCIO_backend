const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Project = require('../models/Project');
const Company = require('../models/Company');

// @desc    Get Dashboard Statistics
// @route   GET /api/dashboard
// @access  Private
const getDashboardStats = async (req, res) => {
    try {
        const Role = require('../models/Role'); // Import Role model
        const now = new Date();
        const istString = now.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
        const today = new Date(istString);
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

        // 1. Get system roles
        const systemRoles = await Role.find({ isSystem: true, isActive: true }).select('_id');
        const systemRoleIds = systemRoles.map(r => r._id);

        // 2. Identify all active users for the company
        const allActiveUsers = await User.find({
            isActive: true,
            companyId: req.companyId
        })
            .populate('roles', 'name isSystem')
            .lean();

        // 3. Fetch company to identify primary admin
        const company = await Company.findById(req.companyId).select('email').lean();
        const primaryAdminEmail = company?.email?.toLowerCase();

        // 4. Identify the Primary Admin based on email match OR being the earliest created system user
        const systemUsers = allActiveUsers.filter(u => u.roles?.some(r => r.isSystem === true));
        const oldestSystemUser = systemUsers.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
        const oldestSystemUserId = oldestSystemUser?._id?.toString();

        // 5. Filter for dashboard metrics
        const filteredUsers = allActiveUsers.filter(u => {
            const hasSystemRole = u.roles?.some(r => r.isSystem === true);
            const isMatchByEmail = u.email?.toLowerCase() === primaryAdminEmail;
            const isMatchByOldest = u._id?.toString() === oldestSystemUserId;

            // Targeted exclusion: Only exclude the original account (Primary Admin)
            const isPrimaryAccount = isMatchByEmail || isMatchByOldest;

            return !(hasSystemRole && isPrimaryAccount);
        });

        const nonSystemUserIds = filteredUsers.map(u => u._id);
        const totalEmployees = nonSystemUserIds.length;

        // 6. Run calculations based on filtered user list
        const [
            presentTodayCount,
            pendingRequests,
            todaysAttendance,
            allProjects
        ] = await Promise.all([
            Attendance.countDocuments({
                companyId: req.companyId,
                user: { $in: nonSystemUserIds },
                date: { $gte: today, $lt: tomorrow },
                status: { $in: ['PRESENT', 'HALF_DAY'] }
            }),
            Attendance.countDocuments({
                approvalStatus: 'PENDING',
                companyId: req.companyId,
                user: { $in: nonSystemUserIds } // Only count pending requests from non-system users
            }),
            Attendance.find({
                companyId: req.companyId,
                user: { $in: nonSystemUserIds },
                date: { $gte: today, $lt: tomorrow }
            })
                .select('user status clockIn clockOut location clockOutLocation')
                .lean(),
            Project.find({ companyId: req.companyId })
                .sort({ updatedAt: -1 })
                .limit(10)
                .select('name isActive status dueDate')
                .lean()
        ]);

        const presentToday = presentTodayCount;
        const absentToday = Math.max(0, totalEmployees - presentToday);

        const attendanceByUserId = new Map(
            todaysAttendance.map(record => [record.user.toString(), record])
        );

        // Map users to their today's attendance status (only filtered non-system users)
        const dailyStatusList = filteredUsers.map(user => {
            const record = attendanceByUserId.get(user._id.toString());
            const roleName = user.roles?.length > 0 ? user.roles[0].name : 'Employee';

            return {
                id: user._id,
                user: {
                    name: `${user.firstName} ${user.lastName}`,
                    role: roleName,
                    employmentType: user.employmentType || 'Employee',
                    avatar: null
                },
                time: record ? record.clockIn : null,
                clockOut: record ? record.clockOut : null,
                status: record ? (record.status || 'PRESENT') : 'ABSENT',
                location: record ? record.location : null,
                clockOutLocation: record ? record.clockOutLocation : null
            };
        });

        // Map projects to safe structure
        const projectsFormatted = allProjects.map(p => ({
            _id: p._id,
            name: p.name,
            status: p.status || (p.isActive ? 'Active' : 'Inactive'),
            deadline: p.dueDate
        }));

        res.json({
            stats: { totalEmployees, presentToday, absentToday, pendingRequests },
            recentActivity: dailyStatusList,
            projects: projectsFormatted
        });

    } catch (error) {
        console.error('Dashboard Stats Error:', error);
        res.status(500).json({ message: 'Server Error fetching dashboard data' });
    }
};

module.exports = { getDashboardStats };
