const { eachDayOfInterval, format } = require('date-fns');
const Attendance = require('../models/Attendance');
const Holiday = require('../models/Holiday');
const LeaveRequest = require('../models/LeaveRequest');
const LeaveConfig = require('../models/LeaveConfig');
const User = require('../models/User');
const {
    listActiveEmployeesForPayroll
} = require('../services/payrollIntegrationService');
const { encryptPayload } = require('../utils/payrollCrypto');
const { parseDateAsIST } = require('../utils/attendancePolicy');

const buildEncryptedResponseIfNeeded = (payload, payrollIntegration) => {
    if (!payrollIntegration?.encryptPayloads) {
        return payload;
    }

    if (!payrollIntegration.encryptionSecret) {
        throw new Error('Payload encryption is enabled but no encryptionSecret is configured.');
    }

    return encryptPayload(payload, payrollIntegration.encryptionSecret);
};

const countLeaveDaysInRange = ({
    startDate,
    endDate,
    isHalfDay = false,
    sandwichRule = false,
    weeklyOffs = ['Saturday', 'Sunday'],
    holidayDateSet = new Set()
}) => {
    if (!startDate || !endDate) {
        return 0;
    }

    if (isHalfDay) {
        const dayName = format(startDate, 'EEEE');
        const isOffDay = weeklyOffs.includes(dayName) || holidayDateSet.has(startDate.toDateString());
        return isOffDay && !sandwichRule ? 0 : 0.5;
    }

    return eachDayOfInterval({ start: startDate, end: endDate }).reduce((total, currentDate) => {
        const dayName = format(currentDate, 'EEEE');
        const isOffDay = weeklyOffs.includes(dayName) || holidayDateSet.has(currentDate.toDateString());
        if (isOffDay && !sandwichRule) {
            return total;
        }

        return total + 1;
    }, 0);
};

const resolveMonthRange = (month, year) => {
    const parsedMonth = Number.parseInt(month, 10);
    const parsedYear = Number.parseInt(year, 10);

    if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
        return null;
    }

    if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 3000) {
        return null;
    }

    const start = parseDateAsIST(`${parsedYear}-${String(parsedMonth).padStart(2, '0')}-01`);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);

    return { start, end };
};

const getEmployees = async (req, res) => {
    try {
        const employees = await listActiveEmployeesForPayroll(req.companyId);
        const responsePayload = buildEncryptedResponseIfNeeded(employees, req.payrollIntegration);
        res.json(responsePayload);
    } catch (error) {
        console.error('[PayrollIntegration] employees sync error:', error);
        res.status(500).json({ message: 'Failed to fetch employee directory for payroll sync.' });
    }
};

const getAttendanceSummary = async (req, res) => {
    try {
        const { month, year } = req.query;
        const monthRange = resolveMonthRange(month, year);

        if (!monthRange) {
            return res.status(400).json({ message: 'Valid month and year query parameters are required.' });
        }

        const { start, end } = monthRange;
        const company = req.company?.toObject ? req.company.toObject() : req.company;
        const weeklyOffs = company?.settings?.attendance?.weeklyOff || ['Saturday', 'Sunday'];

        const [attendanceSummary, approvedLeaves, leaveConfigs, holidays, users] = await Promise.all([
            Attendance.aggregate([
                {
                    $match: {
                        companyId: req.companyId,
                        date: { $gte: start, $lt: end }
                    }
                },
                {
                    $group: {
                        _id: '$user',
                        workingDays: {
                            $sum: {
                                $switch: {
                                    branches: [
                                        { case: { $eq: ['$status', 'PRESENT'] }, then: 1 },
                                        { case: { $eq: ['$status', 'HALF_DAY'] }, then: 0.5 }
                                    ],
                                    default: 0
                                }
                            }
                        }
                    }
                }
            ]),
            LeaveRequest.find({
                companyId: req.companyId,
                status: 'Approved',
                startDate: { $lt: end },
                endDate: { $gte: start }
            })
                .select('user leaveType startDate endDate isHalfDay')
                .lean(),
            LeaveConfig.find({ companyId: req.companyId, isActive: true })
                .select('leaveType isPaid sandwichRule')
                .lean(),
            Holiday.find({
                companyId: req.companyId,
                date: { $gte: start, $lt: end }
            })
                .select('date')
                .lean(),
            User.find({ companyId: req.companyId }, null, { includeDeleted: true })
                .select('_id employeeCode isActive')
                .lean()
        ]);

        const holidayDateSet = new Set(
            holidays.map((holiday) => new Date(holiday.date).toDateString())
        );
        const leaveConfigMap = new Map(
            leaveConfigs.map((config) => [config.leaveType, config])
        );
        const summaryMap = new Map();

        attendanceSummary.forEach((entry) => {
            summaryMap.set(String(entry._id), {
                employeeId: '',
                workingDays: Number(entry.workingDays || 0),
                unpaidLeaves: 0,
                paidLeaves: 0
            });
        });

        approvedLeaves.forEach((leave) => {
            const leaveConfig = leaveConfigMap.get(leave.leaveType);
            if (!leaveConfig) {
                return;
            }

            const overlapStart = new Date(Math.max(new Date(leave.startDate).getTime(), start.getTime()));
            const overlapEndInclusive = new Date(
                Math.min(new Date(leave.endDate).getTime(), end.getTime() - 1)
            );

            if (overlapStart > overlapEndInclusive) {
                return;
            }

            const leaveDays = countLeaveDaysInRange({
                startDate: overlapStart,
                endDate: overlapEndInclusive,
                isHalfDay: leave.isHalfDay,
                sandwichRule: leaveConfig.sandwichRule === true,
                weeklyOffs,
                holidayDateSet
            });

            if (leaveDays <= 0) {
                return;
            }

            const userKey = String(leave.user);
            const summary = summaryMap.get(userKey) || {
                employeeId: '',
                workingDays: 0,
                unpaidLeaves: 0,
                paidLeaves: 0
            };

            if (leaveConfig.isPaid === false) {
                summary.unpaidLeaves += leaveDays;
            } else {
                summary.paidLeaves += leaveDays;
            }

            summaryMap.set(userKey, summary);
        });

        const response = users
            .filter((user) => user.isActive || summaryMap.has(String(user._id)))
            .map((user) => {
                const summary = summaryMap.get(String(user._id)) || {
                    workingDays: 0,
                    unpaidLeaves: 0,
                    paidLeaves: 0
                };

                return {
                    employeeId: user.employeeCode || String(user._id),
                    workingDays: Number(summary.workingDays || 0),
                    unpaidLeaves: Number(summary.unpaidLeaves || 0),
                    paidLeaves: Number(summary.paidLeaves || 0)
                };
            })
            .sort((left, right) => left.employeeId.localeCompare(right.employeeId));

        const responsePayload = buildEncryptedResponseIfNeeded(response, req.payrollIntegration);
        res.json(responsePayload);
    } catch (error) {
        console.error('[PayrollIntegration] attendance sync error:', error);
        res.status(500).json({ message: 'Failed to fetch monthly attendance summary for payroll sync.' });
    }
};

module.exports = {
    getEmployees,
    getAttendanceSummary
};
