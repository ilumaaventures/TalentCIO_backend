const Timesheet = require('../../timesheet/timesheet.model');
const { getTimesheetPeriodIdForDate } = require('../../timesheet/timesheetPeriod');
const { getISTTime } = require('../attendancePolicy');

const ensureTimesheetPeriodEditable = async ({ company, companyId, userId, dateValue }) => {
    const cycle = company?.settings?.timesheet?.approvalCycle || 'Monthly';
    const periodId = getTimesheetPeriodIdForDate(dateValue, cycle);
    const timesheet = await Timesheet.findOne({ user: userId, month: periodId, companyId }).select('status').lean();

    if (timesheet && (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED')) {
        return {
            ok: false,
            message: `Cannot modify attendance for a ${timesheet.status.toLowerCase()} timesheet period.`
        };
    }

    return { ok: true };
};

const getClientIp = (req) => {
    let ip = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;
    if (ip && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
        ip = '127.0.0.1';
    }
    return ip;
};

const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

const getAttendanceSettings = (company) => company?.settings?.attendance || {};

const canUpdateFutureRecords = (user) => (
    user?.roles?.some(r =>
        (typeof r === 'string' && r === 'Admin') ||
        (typeof r === 'object' && r.name === 'Admin')
    ) ||
    user?.permissions?.includes('*') ||
    user?.permissions?.includes('attendance.update_future')
);

const applyPolicyMetadata = (attendance, policy) => {
    attendance.attendanceMode = policy.mode;
    attendance.shiftCode = policy.shift?.code || null;
    attendance.shiftName = policy.shift?.name || null;
    attendance.shiftType = policy.shift?.shiftType || null;
    attendance.shiftStartTime = policy.shift?.startTime || null;
    attendance.shiftEndTime = policy.shift?.endTime || null;
    attendance.maxWorkingHours = policy.maxWorkingHours || null;
    attendance.autoCheckoutAt = policy.autoCheckoutAt || null;
};

const applyPresentOnlyRecord = (attendance, note = '[Marked present]') => {
    attendance.clockIn = null;
    attendance.clockInIST = null;
    attendance.clockOut = null;
    attendance.clockOutIST = null;
    attendance.autoCheckoutAt = null;
    attendance.autoCheckoutReason = null;

    if (note) {
        attendance.notes = attendance.notes?.includes(note)
            ? attendance.notes
            : (attendance.notes ? `${attendance.notes} ${note}` : note);
    }
};

const finalizeCheckout = async (attendance, checkoutTime, reason = '', clockOutLocation = null) => {
    attendance.clockOut = checkoutTime;
    attendance.clockOutIST = getISTTime(checkoutTime);
    attendance.status = 'PRESENT';
    if (reason) {
        attendance.autoCheckoutReason = reason;
        attendance.notes = attendance.notes ? `${attendance.notes} ${reason}` : reason;
    }
    if (clockOutLocation) {
        attendance.clockOutLocation = clockOutLocation;
    }
    await attendance.save();
    return attendance;
};

module.exports = {
    ensureTimesheetPeriodEditable,
    getClientIp,
    calculateDistance,
    getAttendanceSettings,
    canUpdateFutureRecords,
    applyPolicyMetadata,
    applyPresentOnlyRecord,
    finalizeCheckout
};
