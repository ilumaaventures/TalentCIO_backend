const { format } = require('date-fns');
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
const { toLocalTimezoneRep } = require('../utils/timesheetPeriod');

const buildEncryptedResponseIfNeeded = (payload, payrollIntegration) => {
    if (!payrollIntegration?.encryptPayloads) return payload;
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
    if (!startDate || !endDate) return 0;

    const localStart = toLocalTimezoneRep(startDate);
    const localEnd = toLocalTimezoneRep(endDate);

    if (isHalfDay) {
        const isOffDay = weeklyOffs.includes(format(localStart, 'EEEE')) || holidayDateSet.has(localStart.toDateString());
        return isOffDay && !sandwichRule ? 0 : 0.5;
    }

    let count = 0;
    for (let d = new Date(localStart); d <= localEnd; d.setDate(d.getDate() + 1)) {
        const isOffDay = weeklyOffs.includes(format(d, 'EEEE')) || holidayDateSet.has(d.toDateString());
        if (!isOffDay || sandwichRule) count++;
    }
    return count;
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
        // As requested: "only sundays are marked as weekly off / OFF. Rest all days checked."
        const weeklyOffs = ['Sunday'];

        const [attendanceRecords, approvedLeaves, leaveConfigs, holidays, users] = await Promise.all([
            Attendance.find({
                companyId: req.companyId,
                date: { $gte: start, $lt: end }
            }).lean(),
            LeaveRequest.find({
                companyId: req.companyId,
                status: 'Approved',
                startDate: { $lt: end },
                endDate: { $gte: start }
            }).lean(),
            LeaveConfig.find({ companyId: req.companyId, isActive: true }).lean(),
            Holiday.find({
                companyId: req.companyId,
                date: { $gte: start, $lt: end }
            }).lean(),
            User.find({ companyId: req.companyId }, null, { includeDeleted: true }).lean()
        ]);

        const holidayDateSet = new Set(
            holidays.map((holiday) => toLocalTimezoneRep(holiday.date).toDateString())
        );
        const leaveConfigMap = new Map(
            leaveConfigs.map((config) => [config.leaveType, config])
        );

        // Build attendance map: userId_dateStr -> status
        const attendanceMap = new Map();
        attendanceRecords.forEach((rec) => {
            const dateStr = toLocalTimezoneRep(rec.date).toDateString();
            const key = `${String(rec.user)}_${dateStr}`;
            attendanceMap.set(key, rec.status || 'PRESENT');
        });

        const now = new Date();
        const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

        const response = users
            .filter((user) => user.isActive || attendanceRecords.some(r => String(r.user) === String(user._id)) || approvedLeaves.some(l => String(l.user) === String(user._id)))
            .map((user) => {
                const userIdStr = String(user._id);
                let workingDays = 0;
                let presentDays = 0;
                let absentDays = 0;
                let paidLeaves = 0;
                let unpaidLeaves = 0;

                const joiningTime = user.joiningDate ? new Date(user.joiningDate).getTime() : 0;
                const leavingTime = user.dateOfLeaving ? new Date(user.dateOfLeaving).getTime() : Infinity;

                // Loop through every day of the month
                const cursor = new Date(start);
                while (cursor < end) {
                    const cursorTime = cursor.getTime();
                    const isFutureDay = cursorTime > todayEnd;
                    
                    // Check if employee had joined and not left by this day
                    const hasJoined = cursorTime >= joiningTime;
                    const hasLeft = cursorTime > leavingTime;

                    if (hasJoined && !hasLeft) {
                        const dateStr = cursor.toDateString();
                        const dayName = format(cursor, 'EEEE');
                        const isWeeklyOff = weeklyOffs.includes(dayName);
                        const isHoliday = holidayDateSet.has(dateStr);
                        const isOffDay = isWeeklyOff || isHoliday;

                        const attendanceKey = `${userIdStr}_${dateStr}`;
                        const status = attendanceMap.get(attendanceKey);
                        const hasEntry = attendanceMap.has(attendanceKey);

                        // Find matching approved leave for this day
                        const matchingLeave = approvedLeaves.find(l => {
                            if (String(l.user) !== userIdStr) return false;
                            const start = new Date(l.startDate).setHours(0,0,0,0);
                            const end = new Date(l.endDate).setHours(23,59,59,999);
                            return cursorTime >= start && cursorTime <= end;
                        });

                        if (isOffDay) {
                            // Off days/holidays do not count towards working days
                            if (hasEntry) {
                                if (status === 'PRESENT') presentDays += 1;
                                else if (status === 'HALF_DAY') presentDays += 0.5;
                            }
                            
                            // Check if sandwich rule applies for leaves on off-days
                            if (matchingLeave) {
                                const leaveConfig = leaveConfigMap.get(matchingLeave.leaveType);
                                if (leaveConfig?.sandwichRule) {
                                    const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
                                    if (leaveConfig.isPaid === false) {
                                        unpaidLeaves += leaveDays;
                                    } else {
                                        paidLeaves += leaveDays;
                                    }
                                }
                            }
                        } else {
                            // Scheduled working day
                            workingDays += 1;

                            if (hasEntry) {
                                if (status === 'PRESENT') {
                                    presentDays += 1;
                                } else if (status === 'HALF_DAY') {
                                    presentDays += 0.5;
                                    if (matchingLeave) {
                                        const leaveConfig = leaveConfigMap.get(matchingLeave.leaveType);
                                        if (leaveConfig) {
                                            if (leaveConfig.isPaid === false) unpaidLeaves += 0.5;
                                            else paidLeaves += 0.5;
                                        }
                                    } else {
                                        absentDays += 0.5;
                                    }
                                } else if (status === 'ABSENT') {
                                    absentDays += 1;
                                } else if (status === 'LEAVE') {
                                    if (matchingLeave) {
                                        const leaveConfig = leaveConfigMap.get(matchingLeave.leaveType);
                                        const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
                                        if (leaveConfig?.isPaid === false) unpaidLeaves += leaveDays;
                                        else paidLeaves += leaveDays;
                                        if (matchingLeave.isHalfDay) absentDays += 0.5;
                                    } else {
                                        absentDays += 1;
                                    }
                                }
                            } else {
                                // No attendance entry
                                if (matchingLeave) {
                                    const leaveConfig = leaveConfigMap.get(matchingLeave.leaveType);
                                    const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
                                    if (leaveConfig) {
                                        if (leaveConfig.isPaid === false) {
                                            unpaidLeaves += leaveDays;
                                        } else {
                                            paidLeaves += leaveDays;
                                        }
                                    } else {
                                        unpaidLeaves += leaveDays;
                                    }
                                    if (matchingLeave.isHalfDay) {
                                        absentDays += 0.5;
                                    }
                                } else if (!isFutureDay) {
                                    // Only count unexcused absence for past or today's working days
                                    absentDays += 1;
                                }
                            }
                        }
                    }
                    
                    cursor.setDate(cursor.getDate() + 1);
                }

                return {
                    employeeId: user.employeeCode || String(user._id),
                    workingDays,
                    presentDays,
                    absentDays,
                    unpaidLeaves,
                    paidLeaves
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

const PayrollConfig = require('../models/PayrollConfig');

const getPayrollConfig = async (req, res) => {
    try {
        const config = await PayrollConfig.findOne({ companyId: req.companyId }).lean();
        const responsePayload = buildEncryptedResponseIfNeeded(config || {}, req.payrollIntegration);
        res.json(responsePayload);
    } catch (error) {
        console.error('[PayrollIntegration] config sync error:', error);
        res.status(500).json({ message: 'Failed to fetch payroll configuration for sync.' });
    }
};

const crypto = require('crypto');
const PayrollResult = require('../models/PayrollResult');

const receivePayrollResult = async (req, res) => {
    try {
        // Verify HMAC signature from MyBills
        const signature = req.headers['x-mybills-signature'];
        if (!signature) {
            return res.status(401).json({ message: 'x-mybills-signature header is required.' });
        }

        const { webhookSecret } = req.payrollIntegration;
        if (!webhookSecret) {
            return res.status(401).json({ message: 'Payroll integration webhook secret is not configured.' });
        }

        const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        const computedSig = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

        const provided = Buffer.from(signature,   'hex');
        const computed  = Buffer.from(computedSig, 'hex');
        if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
            return res.status(401).json({ message: 'Signature mismatch: HMAC verification failed.' });
        }

        const { payrollResult } = req.body;
        if (
            !payrollResult ||
            !payrollResult.employeeCode ||
            !Number.isInteger(payrollResult.month) ||
            !Number.isInteger(payrollResult.year)
        ) {
            return res.status(400).json({
                message: 'Invalid payroll result payload: employeeCode, month, and year are required.'
            });
        }

        await PayrollResult.findOneAndUpdate(
            {
                companyId:    req.companyId,
                employeeCode: payrollResult.employeeCode,
                month:        payrollResult.month,
                year:         payrollResult.year,
            },
            {
                $set: {
                    status:          payrollResult.status          || 'paid',
                    netSalary:       payrollResult.netSalary       || 0,
                    grossSalary:     payrollResult.grossSalary     || 0,
                    totalDeductions: payrollResult.totalDeductions || 0,
                    paidDate:        payrollResult.paidDate ? new Date(payrollResult.paidDate) : new Date(),
                    breakdown:       payrollResult.breakdown       || {},
                    receivedAt:      new Date(),
                },
            },
            { upsert: true, new: true }
        );

        res.json({ message: 'Payroll result received and stored.' });
    } catch (error) {
        console.error('[PayrollIntegration] receivePayrollResult error:', error);
        res.status(500).json({ message: 'Failed to process payroll result.' });
    }
};

module.exports = {
    getEmployees,
    getAttendanceSummary,
    getPayrollConfig,
    receivePayrollResult,
};
