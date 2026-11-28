const { format } = require('date-fns');
const Attendance = require('../attendance/model/attendance.model');
const Holiday = require('../holiday/holiday.model');
const LeaveRequest = require('../leave/model/leaveRequest.model');
const LeaveConfig = require('../leave/model/leaveConfig.model');
const User = require('../user/user.model');
const { parseDateAsIST } = require('../attendance/attendancePolicy');
const { toLocalTimezoneRep } = require('../timesheet/timesheetPeriod');

const resolveMonthRange = (month, year) => {
  let parsedMonth = Number.parseInt(month, 10);
  let parsedYear = Number.parseInt(year, 10);

  if (typeof month === 'string' && month.includes('-')) {
    const parts = month.split('-');
    if (parts.length === 2) {
      parsedYear = Number.parseInt(parts[0], 10);
      parsedMonth = Number.parseInt(parts[1], 10);
    }
  }

  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    return null;
  }

  if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 3000) {
    return null;
  }

  const paddedMonth = String(parsedMonth).padStart(2, '0');
  const nextMonth = parsedMonth === 12 ? 1 : parsedMonth + 1;
  const nextYear = parsedMonth === 12 ? parsedYear + 1 : parsedYear;
  const paddedNextMonth = String(nextMonth).padStart(2, '0');

  const start = parseDateAsIST(`${parsedYear}-${paddedMonth}-01`);
  const end = parseDateAsIST(`${nextYear}-${paddedNextMonth}-01`);

  return { start, end, parsedMonth, parsedYear };
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

/**
 * Computes IST day-by-day attendance, weekly offs, holidays, and leave-policy
 * credits/deductions for a company's employees in a given month/year.
 */
const computeCompanyAttendanceSummary = async ({
  companyId,
  company = null,
  month,
  year,
  allowedEmployeeIds = null,
  userIds = null,
  includeDailyDetails = true
}) => {
  const monthRange = resolveMonthRange(month, year);
  if (!monthRange) {
    throw new Error('Valid month and year parameters are required.');
  }

  const { start, end, parsedMonth, parsedYear } = monthRange;
  const weeklyOffs = Array.isArray(company?.settings?.attendance?.weeklyOff)
    && company.settings.attendance.weeklyOff.length > 0
    ? company.settings.attendance.weeklyOff
    : ['Sunday'];

  const companyWorkingHours = Number(company?.settings?.attendance?.workingHours) || 8;

  const userQuery = { companyId };
  if (Array.isArray(userIds)) {
    userQuery._id = { $in: userIds };
  } else if (Array.isArray(allowedEmployeeIds) && allowedEmployeeIds.length > 0) {
    userQuery._id = { $in: allowedEmployeeIds };
  }

  const [attendanceRecords, approvedLeaves, leaveConfigs, holidays, users] = await Promise.all([
    Attendance.find({
      companyId,
      ...(Array.isArray(userIds) ? { user: { $in: userIds } } : {}),
      date: { $gte: start, $lt: end }
    }).lean(),
    LeaveRequest.find({
      companyId,
      ...(Array.isArray(userIds) ? { user: { $in: userIds } } : {}),
      status: 'Approved',
      startDate: { $lt: end },
      endDate: { $gte: start }
    }).lean(),
    LeaveConfig.find({ companyId, isActive: true }).lean(),
    Holiday.find({
      companyId,
      date: { $gte: start, $lt: end }
    }).lean(),
    User.find(userQuery, null, { includeDeleted: true }).lean()
  ]);

  const holidayMap = new Map();
  holidays.forEach((holiday) => {
    const dateStr = format(toLocalTimezoneRep(holiday.date), 'yyyy-MM-dd');
    holidayMap.set(dateStr, holiday);
  });

  const leaveConfigMap = new Map(
    leaveConfigs.map((config) => [config.leaveType, config])
  );

  const attendanceMap = new Map();
  attendanceRecords.forEach((rec) => {
    const uid = String(rec.user?._id || rec.user || '');
    if (uid && rec.date) {
      const dateStr = format(toLocalTimezoneRep(rec.date), 'yyyy-MM-dd');
      attendanceMap.set(`${uid}_${dateStr}`, rec);
    }
  });

  const totalDaysInMonth = new Date(parsedYear, parsedMonth, 0).getDate();
  const paddedMonth = String(parsedMonth).padStart(2, '0');
  const monthStartStr = `${parsedYear}-${paddedMonth}-01`;
  const monthEndStr = `${parsedYear}-${paddedMonth}-${String(totalDaysInMonth).padStart(2, '0')}`;

  const nowLocal = toLocalTimezoneRep(new Date());
  const todayStr = format(nowLocal, 'yyyy-MM-dd');
  const isCurrentMonth = (nowLocal.getFullYear() === parsedYear && (nowLocal.getMonth() + 1) === parsedMonth);
  const currentDayIST = isCurrentMonth ? nowLocal.getDate() : totalDaysInMonth;
  const elapsedDays = isCurrentMonth ? Math.min(totalDaysInMonth, currentDayIST) : totalDaysInMonth;

  const evalEnd = parseDateAsIST(monthEndStr);
  evalEnd.setSeconds(evalEnd.getSeconds() + (23 * 3600 + 59 * 60 + 59));

  const summaries = users
    .filter((user) => {
      const userIdStr = String(user._id);

      if (user.joiningDate) {
        const joinStr = format(toLocalTimezoneRep(user.joiningDate), 'yyyy-MM-dd');
        if (joinStr > monthEndStr) return false;
      }

      if (user.dateOfLeaving) {
        const leaveStr = format(toLocalTimezoneRep(user.dateOfLeaving), 'yyyy-MM-dd');
        if (leaveStr < monthStartStr) return false;
      }

      return user.isActive
        || attendanceRecords.some(r => String(r.user?._id || r.user) === userIdStr)
        || approvedLeaves.some(l => String(l.user?._id || l.user) === userIdStr);
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
      let sandwichLeaveDays = 0;
      let workedOffDays = 0;
      let totalWorkingHours = 0;

      const userWeeklyOffs = [
        ...(Array.isArray(weeklyOffs) ? weeklyOffs : []),
        ...(Array.isArray(user.customFlexibleOffDays) ? user.customFlexibleOffDays : [])
      ];

      const joiningDateStr = user.joiningDate ? format(toLocalTimezoneRep(user.joiningDate), 'yyyy-MM-dd') : null;
      const dateOfLeavingStr = user.dateOfLeaving ? format(toLocalTimezoneRep(user.dateOfLeaving), 'yyyy-MM-dd') : null;
      const userApprovedLeaves = approvedLeaves.filter(l => String(l.user?._id || l.user || '') === userIdStr);

      const dailyDetails = includeDailyDetails ? [] : null;
      const cursor = new Date(start);

      while (cursor <= evalEnd && cursor < end) {
        const localCursor = toLocalTimezoneRep(cursor);
        const dateStr = format(localCursor, 'yyyy-MM-dd');
        const dayName = format(localCursor, 'EEEE');

        const hasJoined = !joiningDateStr || dateStr >= joiningDateStr;
        const hasLeft = dateOfLeavingStr && dateStr > dateOfLeavingStr;
        const isFutureDate = isCurrentMonth && dateStr > todayStr;

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
            if (status === 'PRESENT') {
              if (attendanceRec.clockIn && attendanceRec.clockOut) {
                const diffMs = new Date(attendanceRec.clockOut).getTime() - new Date(attendanceRec.clockIn).getTime();
                workingHours = diffMs > 0 ? Number((diffMs / (1000 * 60 * 60)).toFixed(2)) : companyWorkingHours;
              } else {
                workingHours = companyWorkingHours;
              }
            } else if (status === 'HALF_DAY') {
              if (attendanceRec.clockIn && attendanceRec.clockOut) {
                const diffMs = new Date(attendanceRec.clockOut).getTime() - new Date(attendanceRec.clockIn).getTime();
                workingHours = diffMs > 0 ? Number((diffMs / (1000 * 60 * 60)).toFixed(2)) : Number((companyWorkingHours / 2).toFixed(2));
              } else {
                workingHours = Number((companyWorkingHours / 2).toFixed(2));
              }
            }
          }

          let isPaidLeave = null;
          if (matchingLeave) {
            const leaveConfig = leaveConfigMap.get(matchingLeave.leaveType);
            isPaidLeave = leaveConfig?.isPaid !== false;
          }

          if (includeDailyDetails) {
            let dayStatus = 'ABSENT';
            if (isFutureDate && !hasEntry && !matchingLeave) {
              dayStatus = isWeeklyOffDay ? 'WEEKLY_OFF' : (isHolidayDay ? 'HOLIDAY' : 'UPCOMING');
            } else if (isWeeklyOffDay) {
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
          }

          if (isOffDay) {
            let offDayCredit = 1;

            if (matchingLeave) {
              const leaveConfig = leaveConfigMap.get(matchingLeave.leaveType);
              if (leaveConfig?.sandwichRule) {
                const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
                if (isPaidLeave) paidLeaves += leaveDays;
                else unpaidLeaves += leaveDays;
                sandwichLeaveDays += leaveDays;
                offDayCredit = Math.max(0, 1 - leaveDays);
              }
            }

            if (offDayCredit > 0) {
              if (isWeeklyOffDay) {
                weeklyOffDays += offDayCredit;
              } else if (isHolidayDay) {
                holidayDays += offDayCredit;
              }
            }

            if (hasEntry && (status === 'PRESENT' || status === 'HALF_DAY')) {
              const credit = status === 'HALF_DAY' ? 0.5 : 1;
              workedOffDays += credit;
              totalWorkingHours += workingHours;
            }
          } else if (isFutureDate && !hasEntry && !matchingLeave) {
            // Future unelapsed days in ongoing month: do not mark absent
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
              } else if (status === 'LEAVE' || status === 'ABSENT') {
                if (matchingLeave) {
                  const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
                  if (isPaidLeave) paidLeaves += leaveDays;
                  else unpaidLeaves += leaveDays;
                  if (matchingLeave.isHalfDay) absentDays += 0.5;
                } else {
                  absentDays += 1;
                }
              }
            } else if (matchingLeave) {
              const leaveDays = matchingLeave.isHalfDay ? 0.5 : 1;
              if (isPaidLeave) paidLeaves += leaveDays;
              else unpaidLeaves += leaveDays;
              if (matchingLeave.isHalfDay) absentDays += 0.5;
            } else {
              absentDays += 1;
            }
          }
        }

        cursor.setDate(cursor.getDate() + 1);
      }

      const calculatedPaidDays = presentDays + paidLeaves + weeklyOffDays + holidayDays;
      const empCode = user.employeeCode || '';
      const empId = empCode || String(user._id);
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email;

      return {
        employeeId: empId,
        employeeCode: empCode,
        employeeNumber: empCode || empId,
        userId: userIdStr,
        email: user.email || '',
        fullName,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
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
        sandwichLeaveDays,
        workedOffDays,
        paidDays: calculatedPaidDays,
        totalWorkingHours: Number(totalWorkingHours.toFixed(2)),
        ...(includeDailyDetails ? { dailyDetails } : {})
      };
    })
    .sort((left, right) => (left.employeeCode || left.employeeId || '').localeCompare(right.employeeCode || right.employeeId || ''));

  return {
    monthRange,
    totalDaysInMonth,
    elapsedDays,
    summaries
  };
};

module.exports = {
  resolveMonthRange,
  isDayWeeklyOff,
  computeCompanyAttendanceSummary
};
