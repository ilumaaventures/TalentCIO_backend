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

    // Use UTC boundaries so the full calendar month is included regardless of
    // how attendance dates are stored (UTC midnight vs IST midnight).
    // start = first millisecond of the month at UTC midnight.
    // end   = first millisecond of the *next* month (exclusive upper bound).
    const start = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
    const end   = new Date(Date.UTC(parsedYear, parsedMonth,     1));

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

const isDayWeeklyOff = (dayName, offDaysList) => {
    if (!Array.isArray(offDaysList) || offDaysList.length === 0) return false;
    const lowerDay = String(dayName || '').toLowerCase();
    const shortDay = lowerDay.slice(0, 3);

    const dayNumberMap = {
        sunday: '0',
        monday: '1',
        tuesday: '2',
        wednesday: '3',
        thursday: '4',
        friday: '5',
        saturday: '6'
    };
    const dayNum = dayNumberMap[lowerDay];

    return offDaysList.some((off) => {
        const str = String(off || '').trim().toLowerCase();
        return str === lowerDay || str === shortDay || (dayNum && str === dayNum);
    });
};

const getAttendanceSummary = async (req, res) => {
    try {
        const { month, year } = req.query;
        const monthRange = resolveMonthRange(month, year);

        if (!monthRange) {
            return res.status(400).json({ message: 'Valid month and year query parameters are required.' });
        }

        const { start, end } = monthRange;
        // Read weekly off days from company attendance settings.
        // Falls back to ['Sunday'] if not configured so the sync never breaks.
        const weeklyOffs = Array.isArray(req.company?.settings?.attendance?.weeklyOff)
            && req.company.settings.attendance.weeklyOff.length > 0
                ? req.company.settings.attendance.weeklyOff
                : ['Sunday'];

        // Bug 7 fix: used to assign working hours for present_only employees who have no clock times
        const companyWorkingHours = req.company?.settings?.attendance?.workingHours || 8;

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

        const holidayMap = new Map();
        holidays.forEach((holiday) => {
            const dateStr = format(toLocalTimezoneRep(holiday.date), 'yyyy-MM-dd');
            holidayMap.set(dateStr, holiday);
        });

        const leaveConfigMap = new Map(
            leaveConfigs.map((config) => [config.leaveType, config])
        );

        // Build attendance map: userId_dateStr -> attendanceRecord
        const attendanceMap = new Map();
        attendanceRecords.forEach((rec) => {
            const uid = String(rec.user?._id || rec.user || '');
            if (uid && rec.date) {
                const dateStr = format(toLocalTimezoneRep(rec.date), 'yyyy-MM-dd');
                attendanceMap.set(`${uid}_${dateStr}`, rec);
            }
        });

        const now = new Date();
        const parsedMonth = Number.parseInt(month, 10);
        const parsedYear = Number.parseInt(year, 10);
        const totalDaysInMonth = new Date(parsedYear, parsedMonth, 0).getDate();

        const isCurrentMonth = now.getFullYear() === parsedYear && (now.getMonth() + 1) === parsedMonth;
        // For the current month, clamp to today's IST day; otherwise use the full month.
        const elapsedDays = isCurrentMonth
            ? Math.min(Number.parseInt(toLocalTimezoneRep(now).getDate(), 10), totalDaysInMonth)
            : totalDaysInMonth;

        const evalEndPadded = String(elapsedDays).padStart(2, '0');
        const evalEndMonthPadded = String(parsedMonth).padStart(2, '0');
        const evalEnd = parseDateAsIST(`${parsedYear}-${evalEndMonthPadded}-${evalEndPadded}`);
        evalEnd.setSeconds(evalEnd.getSeconds() + (23 * 3600 + 59 * 60 + 59));

        const response = users
            .filter((user) => {
                if (!user.employeeCode) return false;
                return user.isActive
                    || attendanceRecords.some(r => String(r.user?._id || r.user) === String(user._id))
                    || approvedLeaves.some(l => String(l.user?._id || l.user) === String(user._id));
            })
            .map((user) => {
                const userIdStr = String(user._id);
                let workingDaysTillDate = 0;
                let weeklyOffDays = 0;
                let holidayDays = 0;
                let presentDays = 0;
                let absentDays = 0;
                let halfDays = 0;
                let paidLeaves = 0;
                let unpaidLeaves = 0;
                let workedOffDays = 0;
                let totalWorkingHours = 0;

                const userWeeklyOffs = Array.isArray(user.customFlexibleOffDays) && user.customFlexibleOffDays.length > 0
                    ? user.customFlexibleOffDays
                    : weeklyOffs;

                const joiningDateStr = user.joiningDate ? format(toLocalTimezoneRep(user.joiningDate), 'yyyy-MM-dd') : null;
                const dateOfLeavingStr = user.dateOfLeaving ? format(toLocalTimezoneRep(user.dateOfLeaving), 'yyyy-MM-dd') : null;

                const userApprovedLeaves = approvedLeaves.filter(l => String(l.user?._id || l.user || '') === userIdStr);

                const cursor = new Date(start);
                while (cursor <= evalEnd && cursor < end) {
                    const localCursor = toLocalTimezoneRep(cursor);
                    const dateStr = format(localCursor, 'yyyy-MM-dd');
                    const dayName = format(localCursor, 'EEEE');

                    const hasJoined = !joiningDateStr || dateStr >= joiningDateStr;
                    const hasLeft = dateOfLeavingStr && dateStr > dateOfLeavingStr;

                    if (hasJoined && !hasLeft) {
                        const isWeeklyOffDay = isDayWeeklyOff(dayName, userWeeklyOffs);
                        const holidayObj = holidayMap.get(dateStr);
                        const isHolidayDay = !!holidayObj;
                        const isOffDay = isWeeklyOffDay || isHolidayDay;

                        const attendanceRec = attendanceMap.get(`${userIdStr}_${dateStr}`);
                        const status = attendanceRec?.status;
                        const hasEntry = !!attendanceRec;

                        const matchingLeave = userApprovedLeaves.find(l => {
                            const lStartStr = format(toLocalTimezoneRep(l.startDate), 'yyyy-MM-dd');
                            const lEndStr = format(toLocalTimezoneRep(l.endDate), 'yyyy-MM-dd');
                            return dateStr >= lStartStr && dateStr <= lEndStr;
                        });

                        let workingHours = 0;

                        if (attendanceRec) {
                            if (attendanceRec.attendanceMode === 'present_only' && status === 'PRESENT') {
                                // Bug 7 fix: present_only mode has no clock times — assign company default
                                // working hours so totalWorkingHours is not always 0 for these employees.
                                workingHours = companyWorkingHours;
                            } else if (attendanceRec.clockIn && attendanceRec.clockOut) {
                                const diffMs = new Date(attendanceRec.clockOut).getTime() - new Date(attendanceRec.clockIn).getTime();
                                if (diffMs > 0) {
                                    workingHours = Number((diffMs / (1000 * 60 * 60)).toFixed(2));
                                }
                            }
                        }

                        let isPaidLeave = null;
                        if (matchingLeave) {
                            const leaveConfig = leaveConfigMap.get(matchingLeave.leaveType);
                            isPaidLeave = leaveConfig?.isPaid !== false;
                        }

                        if (isOffDay) {
                            if (isWeeklyOffDay) {
                                weeklyOffDays += 1;
                            } else if (isHolidayDay) {
                                holidayDays += 1;
                            }

                            if (hasEntry && (status === 'PRESENT' || status === 'HALF_DAY')) {
                                const credit = status === 'HALF_DAY' ? 0.5 : 1;
                                workedOffDays += credit;
                                totalWorkingHours += workingHours;
                            }

                            if (matchingLeave) {
                                const leaveConfig = leaveConfigMap.get(matchingLeave.leaveType);
                                if (leaveConfig?.sandwichRule) {
                                    const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
                                    if (isPaidLeave) paidLeaves += leaveDays;
                                    else unpaidLeaves += leaveDays;
                                }
                            }
                        } else {
                            workingDaysTillDate += 1;
                            totalWorkingHours += workingHours;

                            if (hasEntry) {
                                if (status === 'PRESENT') {
                                    presentDays += 1;
                                } else if (status === 'HALF_DAY') {
                                    presentDays += 0.5;
                                    halfDays += 1;
                                    if (matchingLeave) {
                                        if (isPaidLeave) paidLeaves += 0.5;
                                        else unpaidLeaves += 0.5;
                                    } else {
                                        absentDays += 0.5;
                                    }
                                } else if (status === 'LEAVE') {
                                    if (matchingLeave) {
                                        const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
                                        if (isPaidLeave) paidLeaves += leaveDays;
                                        else unpaidLeaves += leaveDays;
                                        if (matchingLeave.isHalfDay) absentDays += 0.5;
                                    } else {
                                        // Bug 3 fix: attendance record says LEAVE but no approved LeaveRequest
                                        // exists — treat as absent instead of giving a free paid leave day.
                                        absentDays += 1;
                                    }
                                } else if (status === 'ABSENT') {
                                    if (matchingLeave) {
                                        const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
                                        if (isPaidLeave) paidLeaves += leaveDays;
                                        else unpaidLeaves += leaveDays;
                                        if (matchingLeave.isHalfDay) absentDays += 0.5;
                                    } else {
                                        absentDays += 1;
                                    }
                                }
                            } else {
                                if (matchingLeave) {
                                    const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
                                    if (isPaidLeave) paidLeaves += leaveDays;
                                    else unpaidLeaves += leaveDays;
                                    if (matchingLeave.isHalfDay) absentDays += 0.5;
                                } else {
                                    absentDays += 1;
                                }
                            }
                        }

                    }

                    cursor.setDate(cursor.getDate() + 1);
                }

                // Bug 6 fix: paidDays must only count paid working days (present + paid leaves).
                // The old formula added weeklyOffDays + holidayDays + workedOffDays which inflated
                // paidDays to near-total-month values, causing salary over-payment if payroll uses
                // paidDays as the salary multiplier.
                const calculatedPaidDays = Math.min(
                    presentDays + paidLeaves,
                    totalDaysInMonth
                );

                if (workingDaysTillDate > elapsedDays) {
                    console.warn(`[Validation Warning] user ${user._id}: workingDaysTillDate (${workingDaysTillDate}) > elapsedDays (${elapsedDays})`);
                }
                const sumDays = presentDays + absentDays + paidLeaves + unpaidLeaves;
                if (Math.abs(sumDays - workingDaysTillDate) > 0.01) {
                    console.warn(`[Validation Warning] user ${user._id}: sum (${sumDays}) != workingDaysTillDate (${workingDaysTillDate})`);
                }

                return {
                    // employeeId removed: exposes internal MongoDB _id to an external system.
                    // employeeNumber (employeeCode) is the correct external identifier.
                    employeeNumber: user.employeeCode,
                    totalDaysInMonth,
                    elapsedDays,
                    workingDaysTillDate,
                    weeklyOffDays,
                    holidayDays,
                    presentDays,
                    absentDays,
                    halfDays,
                    paidLeaves,
                    unpaidLeaves,
                    workedOffDays,
                    paidDays: calculatedPaidDays,
                    totalWorkingHours: Number(totalWorkingHours.toFixed(2)),
                };
            })
            // Bug 8 fix: guard against null/undefined employeeCode to prevent TypeError crash
            // (even though the filter above should prevent it, defensive code avoids a full 500).
            .sort((left, right) => (left.employeeNumber || '').localeCompare(right.employeeNumber || ''));

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
        const tsHeader = req.headers['x-hrms-timestamp'];
        const hmacInput = tsHeader ? `${tsHeader}.${rawBody}` : rawBody;
        const computedSig = crypto.createHmac('sha256', webhookSecret).update(hmacInput).digest('hex');

        const provided = Buffer.from(signature, 'hex');
        const computed  = Buffer.from(computedSig, 'hex');
        let isValid = provided.length === computed.length && crypto.timingSafeEqual(provided, computed);

        if (!isValid && tsHeader) {
            const fallbackSig = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
            const fallbackBuf = Buffer.from(fallbackSig, 'hex');
            if (provided.length === fallbackBuf.length && crypto.timingSafeEqual(provided, fallbackBuf)) {
                isValid = true;
            }
        }

        if (!isValid) {
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
