const { format } = require('date-fns');
const Attendance = require('../../modules/attendance/model/attendance.model');
const Holiday = require('../holiday/holiday.model');
const LeaveRequest = require('../leave/model/leaveRequest.model');
const LeaveConfig = require('../leave/model/leaveConfig.model');
const User = require('../../modules/user/user.model');
const {
    listActiveEmployeesForPayroll
} = require('./payrollIntegration.service');
const { encryptPayload } = require('./payrollCrypto');
const { parseDateAsIST } = require('../../modules/attendance/attendancePolicy');
const { toLocalTimezoneRep } = require('../timesheet/timesheetPeriod');

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

    // Attendance dates are stored at IST midnight (e.g. 2026-07-01T00:00:00+05:30
    // which is 2026-06-30T18:30:00.000Z in UTC).  The query boundaries must use
    // the same IST-midnight representation so the $gte/$lt range captures the
    // first day of the month.  Using UTC midnight would miss day-1 records whose
    // UTC value falls before the boundary.
    const paddedMonth = String(parsedMonth).padStart(2, '0');
    const nextMonth = parsedMonth === 12 ? 1 : parsedMonth + 1;
    const nextYear = parsedMonth === 12 ? parsedYear + 1 : parsedYear;
    const paddedNextMonth = String(nextMonth).padStart(2, '0');

    const start = parseDateAsIST(`${parsedYear}-${paddedMonth}-01`);
    const end = parseDateAsIST(`${nextYear}-${paddedNextMonth}-01`);

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

const isDayWeeklyOff = (dayName, dateStr, offDaysList) => {
    if (!Array.isArray(offDaysList) || offDaysList.length === 0) return false;
    const lowerDay = String(dayName || '').toLowerCase();
    const shortDay = lowerDay.slice(0, 3);
    const targetDateStr = String(dateStr || '').trim().toLowerCase();

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
        if (targetDateStr && str === targetDateStr) return true;
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
            User.find(
                req.payrollIntegration?.syncMode === 'selected'
                    ? { companyId: req.companyId, _id: { $in: req.payrollIntegration.allowedEmployeeIds || [] } }
                    : { companyId: req.companyId },
                null,
                { includeDeleted: true }
            ).lean()
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

        // Evaluate the full calendar month (e.g. 31 days) so all recorded attendance
        // entries in the database for days 1..31 are evaluated for payroll sync.
        const elapsedDays = totalDaysInMonth;

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

                const userWeeklyOffs = [
                    ...(Array.isArray(weeklyOffs) ? weeklyOffs : []),
                    ...(Array.isArray(user.customFlexibleOffDays) ? user.customFlexibleOffDays : [])
                ];

                const joiningDateStr = user.joiningDate ? format(toLocalTimezoneRep(user.joiningDate), 'yyyy-MM-dd') : null;
                const dateOfLeavingStr = user.dateOfLeaving ? format(toLocalTimezoneRep(user.dateOfLeaving), 'yyyy-MM-dd') : null;

                const userApprovedLeaves = approvedLeaves.filter(l => String(l.user?._id || l.user || '') === userIdStr);

                const dailyDetails = [];
                const cursor = new Date(start);
                while (cursor <= evalEnd && cursor < end) {
                    const localCursor = toLocalTimezoneRep(cursor);
                    const dateStr = format(localCursor, 'yyyy-MM-dd');
                    const dayName = format(localCursor, 'EEEE');

                    const hasJoined = !joiningDateStr || dateStr >= joiningDateStr;
                    const hasLeft = dateOfLeavingStr && dateStr > dateOfLeavingStr;

                    if (hasJoined && !hasLeft) {
                        const isWeeklyOffDay = isDayWeeklyOff(dayName, dateStr, userWeeklyOffs);
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

                        let dayStatus = 'ABSENT';
                        if (isWeeklyOffDay) {
                            dayStatus = 'WEEKLY_OFF';
                        } else if (isHolidayDay) {
                            dayStatus = 'HOLIDAY';
                        } else if (status) {
                            dayStatus = status;
                        } else if (matchingLeave) {
                            dayStatus = 'LEAVE';
                        }

                        dailyDetails.push({
                            date: dateStr,
                            dayName,
                            status: dayStatus,
                            clockIn: attendanceRec?.clockIn || null,
                            clockOut: attendanceRec?.clockOut || null,
                            workingHours,
                            isOffDay,
                            leaveType: matchingLeave?.leaveType || null,
                            isPaidLeave: isPaidLeave !== null ? isPaidLeave : false
                        });

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

                const calculatedPaidDays = presentDays + paidLeaves + weeklyOffDays + holidayDays;

                if (workingDaysTillDate > elapsedDays) {
                    console.warn(`[Validation Warning] user ${user._id}: workingDaysTillDate (${workingDaysTillDate}) > elapsedDays (${elapsedDays})`);
                }
                const sumDays = presentDays + absentDays + paidLeaves + unpaidLeaves;
                if (Math.abs(sumDays - workingDaysTillDate) > 0.01) {
                    console.warn(`[Validation Warning] user ${user._id}: sum (${sumDays}) != workingDaysTillDate (${workingDaysTillDate})`);
                }

                return {
                    employeeNumber: user.employeeCode,
                    totalDaysInMonth,
                    elapsedDays,
                    workingDays: elapsedDays,
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
                    dailyDetails
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

const PayrollConfig = require('./payrollConfig.model');

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
const fs = require('fs');
const path = require('path');
const PayrollResult = require('./payrollResult.model');
const EmployeeProfile = require('../dossier/employeeProfile.model');
const { uploadBufferToCloudinary } = require('../../config/cloudinary');

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

async function storePayslipFile(item, companyId) {
    if (!item.payslipPdfBase64) {
        return item.payslipUrl || '';
    }

    try {
        const buffer = Buffer.from(item.payslipPdfBase64, 'base64');
        const monthStr = MONTH_NAMES[item.month - 1] || `M${item.month}`;
        const fileName = `payslip_${item.employeeCode}_${monthStr}_${item.year}.pdf`;

        // Try Cloudinary first if configured
        if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY) {
            try {
                const cloudUrl = await uploadBufferToCloudinary(buffer, fileName, 'payslips');
                if (cloudUrl) return cloudUrl;
            } catch (cErr) {
                console.warn('[storePayslipFile] Cloudinary upload failed, using local file:', cErr.message);
            }
        }

        // Local storage fallback in /uploads/payslips/
        const uploadDir = path.join(__dirname, '../../../uploads/payslips');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, buffer);
        return `/uploads/payslips/${fileName}`;
    } catch (err) {
        console.error('[storePayslipFile] Error storing payslip:', err.message);
        return item.payslipUrl || '';
    }
}

async function saveSinglePayrollResult(companyId, payrollResult) {
    if (!payrollResult || !payrollResult.employeeCode || !Number.isInteger(payrollResult.month) || !Number.isInteger(payrollResult.year)) {
        return null;
    }

    const payslipUrl = await storePayslipFile(payrollResult, companyId);
    const monthStr = MONTH_NAMES[payrollResult.month - 1] || `Month ${payrollResult.month}`;
    const period = `${monthStr} ${payrollResult.year}`;

    // 1. Upsert into PayrollResult
    const updatedResult = await PayrollResult.findOneAndUpdate(
        {
            companyId,
            employeeCode: payrollResult.employeeCode,
            month: payrollResult.month,
            year: payrollResult.year,
        },
        {
            $set: {
                status: payrollResult.status || 'paid',
                payslipUrl: payslipUrl || '',
                netSalary: payrollResult.netSalary || 0,
                grossSalary: payrollResult.grossSalary || 0,
                totalDeductions: payrollResult.totalDeductions || 0,
                paidDate: payrollResult.paidDate ? new Date(payrollResult.paidDate) : new Date(),
                breakdown: payrollResult.breakdown || {},
                receivedAt: new Date(),
            },
        },
        { upsert: true, new: true }
    );

    // 2. Sync into EmployeeProfile (for ESS MyPayslips and Dossier documents)
    try {
        const query = {
            companyId,
            $or: [
                { employeeCode: String(payrollResult.employeeCode).trim() },
                ...(payrollResult.email ? [{ email: String(payrollResult.email).trim().toLowerCase() }] : [])
            ]
        };
        const user = await User.findOne(query).select('_id companyId');
        if (user) {
            const profile = await EmployeeProfile.findOne({ user: user._id });
            if (profile) {
                // Upsert payrollHistory
                if (!profile.compensation) profile.compensation = {};
                if (!Array.isArray(profile.compensation.payrollHistory)) profile.compensation.payrollHistory = [];

                const historyIdx = profile.compensation.payrollHistory.findIndex(h => h.period === period);
                const historyEntry = {
                    period,
                    netSalary: payrollResult.netSalary || 0,
                    grossSalary: payrollResult.grossSalary || 0,
                    totalDeductions: payrollResult.totalDeductions || 0,
                    status: payrollResult.status === 'draft' ? 'Draft' : 'Paid',
                    payslipUrl: payslipUrl || '',
                    workingDays: payrollResult.workingDays !== undefined ? payrollResult.workingDays : 31,
                    paidDays: payrollResult.paidDays !== undefined ? payrollResult.paidDays : 31,
                    companyName: payrollResult.companyName || '',
                    companyAddress: payrollResult.companyAddress || '',
                    companyLogo: payrollResult.companyLogo || '',
                    taxRegime: payrollResult.taxRegime || '',
                    earningsLineItems: Array.isArray(payrollResult.earningsLineItems) ? payrollResult.earningsLineItems : [],
                    deductionsLineItems: Array.isArray(payrollResult.deductionsLineItems) ? payrollResult.deductionsLineItems : [],
                    breakdown: payrollResult.breakdown || {},
                    taxWorksheet: payrollResult.taxWorksheet || null,
                    processedDate: payrollResult.paidDate ? new Date(payrollResult.paidDate) : new Date(),
                };

                if (historyIdx !== -1) {
                    profile.compensation.payrollHistory[historyIdx] = {
                        ...(profile.compensation.payrollHistory[historyIdx]?.toObject?.() || profile.compensation.payrollHistory[historyIdx]),
                        ...historyEntry,
                    };
                } else {
                    profile.compensation.payrollHistory.push(historyEntry);
                }

                // Upsert documents (category: 'Payslips')
                if (payslipUrl) {
                    if (!Array.isArray(profile.documents)) profile.documents = [];
                    const docIdx = profile.documents.findIndex(d => d.category === 'Payslips' && d.title === `Payslip - ${period}`);
                    const docEntry = {
                        category: 'Payslips',
                        title: `Payslip - ${period}`,
                        fileName: `Payslip_${payrollResult.employeeCode}_${period.replace(/\s+/g, '_')}.pdf`,
                        url: payslipUrl,
                        uploadDate: new Date(),
                        verificationStatus: 'Verified'
                    };
                    if (docIdx !== -1) {
                        profile.documents[docIdx] = {
                            ...(profile.documents[docIdx]?.toObject?.() || profile.documents[docIdx]),
                            ...docEntry,
                        };
                    } else {
                        profile.documents.push(docEntry);
                    }
                }

                await profile.save();
            }
        }
    } catch (profileErr) {
        console.error('[PayrollIntegration] Error syncing payslip to employee profile:', profileErr.message);
    }

    return updatedResult;
}

const receivePayrollResult = async (req, res) => {
    try {
        // Verify HMAC signature from MyBills
        const signature = req.headers['x-mybills-signature'];
        if (!signature) {
            return res.status(401).json({ message: 'x-mybills-signature header is required.' });
        }

        const rawBody = req.rawBody
            ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
            : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        const jsonBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const tsHeader = req.headers['x-hrms-timestamp'];

        const secretsToTry = Array.from(new Set([
            req.payrollIntegration?.webhookSecret,
            req.payrollIntegration?.accessToken
        ].filter(Boolean)));

        if (secretsToTry.length === 0) {
            return res.status(401).json({ message: 'Payroll integration webhook secret is not configured.' });
        }

        const provided = Buffer.from(String(signature).trim(), 'hex');
        let isValid = false;

        for (const secret of secretsToTry) {
            const inputsToTry = [
                tsHeader ? `${tsHeader}.${rawBody}` : null,
                rawBody,
                tsHeader ? `${tsHeader}.${jsonBody}` : null,
                jsonBody
            ].filter(Boolean);

            for (const input of inputsToTry) {
                const computedHex = crypto.createHmac('sha256', secret).update(input).digest('hex');
                const computed = Buffer.from(computedHex, 'hex');
                if (provided.length === computed.length && crypto.timingSafeEqual(provided, computed)) {
                    isValid = true;
                    break;
                }
            }
            if (isValid) break;
        }

        if (!isValid) {
            return res.status(401).json({ message: 'Signature mismatch: HMAC verification failed.' });
        }

        const results = Array.isArray(req.body.payrollResults)
            ? req.body.payrollResults
            : (req.body.payrollResult ? [req.body.payrollResult] : []);

        if (results.length === 0) {
            return res.status(400).json({
                message: 'Invalid payload: payrollResult object or payrollResults array is required.'
            });
        }

        const saved = [];
        for (const item of results) {
            const resDoc = await saveSinglePayrollResult(req.companyId, item);
            if (resDoc) saved.push(resDoc);
        }

        res.json({ message: `Successfully processed ${saved.length} payroll result(s).`, count: saved.length });
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