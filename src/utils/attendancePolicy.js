const IST_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_SHIFT_CODE = 'general';
const DEFAULT_ATTENDANCE_MODE = 'clock_in_out';
const DEFAULT_SHIFT_LIST = [
    {
        code: 'general',
        name: 'General',
        shiftType: 'general',
        startTime: '09:00',
        endTime: '18:00',
        maxWorkingHours: 9
    },
    {
        code: 'any',
        name: 'Any Time',
        shiftType: 'any',
        startTime: '00:00',
        endTime: '23:59',
        maxWorkingHours: 8
    }
];

const getISTTime = (dateInput = new Date()) => (
    new Date(dateInput).toLocaleString('en-IN', { timeZone: IST_TIMEZONE })
);

const getISTDateParts = (dateInput = new Date()) => {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: IST_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const [year, month, day] = formatter.format(new Date(dateInput)).split('-').map(Number);
    return { year, month, day };
};

const getStartOfDayIST = (dateInput = new Date()) => {
    const { year, month, day } = getISTDateParts(dateInput);
    return new Date(year, month - 1, day);
};

const parseDateAsIST = (dateInput) => {
    if (!dateInput) return null;
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) {
        return getStartOfDayIST();
    }

    const { year, month, day } = getISTDateParts(date);
    return new Date(year, month - 1, day);
};

const parseTimeToMinutes = (timeValue = '00:00') => {
    const [hours, minutes] = String(timeValue || '00:00').split(':').map((value) => parseInt(value, 10) || 0);
    return (hours * 60) + minutes;
};

const buildISTDateTime = (dateInput, timeValue = '00:00', seconds = 0) => {
    const { year, month, day } = getISTDateParts(dateInput);
    const [hours, minutes] = String(timeValue || '00:00').split(':').map((value) => parseInt(value, 10) || 0);
    const paddedMonth = String(month).padStart(2, '0');
    const paddedDay = String(day).padStart(2, '0');
    const paddedHours = String(hours).padStart(2, '0');
    const paddedMinutes = String(minutes).padStart(2, '0');
    const paddedSeconds = String(seconds).padStart(2, '0');

    return new Date(`${year}-${paddedMonth}-${paddedDay}T${paddedHours}:${paddedMinutes}:${paddedSeconds}+05:30`);
};

const buildEndOfDayIST = (dateInput) => buildISTDateTime(dateInput, '23:59', 59);

const normalizeShiftList = (attendanceSettings = {}) => {
    const rawShifts = Array.isArray(attendanceSettings.attendanceShifts) && attendanceSettings.attendanceShifts.length > 0
        ? attendanceSettings.attendanceShifts
        : DEFAULT_SHIFT_LIST;

    return rawShifts.map((shift, index) => {
        const code = String(shift?.code || shift?.name || `shift_${index + 1}`)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-');

        return {
            code,
            name: String(shift?.name || code).trim(),
            shiftType: shift?.shiftType === 'any' ? 'any' : 'general',
            startTime: String(shift?.startTime || (shift?.shiftType === 'any' ? '00:00' : '09:00')).slice(0, 5),
            endTime: String(shift?.endTime || (shift?.shiftType === 'any' ? '23:59' : '18:00')).slice(0, 5),
            maxWorkingHours: Math.max(Number(shift?.maxWorkingHours) || Number(attendanceSettings.workingHours) || 8, 1)
        };
    });
};

const getAttendanceModeForUser = ({ company, user }) => (
    user?.attendanceMode ||
    company?.settings?.attendance?.defaultAttendanceMode ||
    DEFAULT_ATTENDANCE_MODE
);

const resolveShiftForUser = ({ company, user }) => {
    const attendanceSettings = company?.settings?.attendance || {};
    const shifts = normalizeShiftList(attendanceSettings);
    const requestedCode = String(
        user?.attendanceShiftCode ||
        attendanceSettings.defaultShiftCode ||
        DEFAULT_SHIFT_CODE
    ).trim().toLowerCase();

    const shift = shifts.find((item) => item.code === requestedCode)
        || shifts.find((item) => item.code === DEFAULT_SHIFT_CODE)
        || shifts[0];

    return { shifts, shift };
};

const buildAttendancePolicy = ({ company, user, attendanceDate = new Date(), clockInTime = null }) => {
    const mode = getAttendanceModeForUser({ company, user });
    const { shift } = resolveShiftForUser({ company, user });
    const shiftStartAt = shift?.shiftType === 'general'
        ? buildISTDateTime(attendanceDate, shift.startTime)
        : null;
    const shiftEndAt = shift?.shiftType === 'general'
        ? buildISTDateTime(attendanceDate, shift.endTime, 59)
        : null;
    const maxWorkingHours = Math.max(Number(shift?.maxWorkingHours) || Number(company?.settings?.attendance?.workingHours) || 8, 1);
    const endOfDayAt = buildEndOfDayIST(attendanceDate);

    let autoCheckoutAt = endOfDayAt;
    if (clockInTime) {
        const cutoffCandidates = [endOfDayAt];

        if (shiftEndAt) {
            cutoffCandidates.push(shiftEndAt);
        }

        const maxHoursCheckoutAt = new Date(new Date(clockInTime).getTime() + (maxWorkingHours * 60 * 60 * 1000));
        cutoffCandidates.push(maxHoursCheckoutAt);

        autoCheckoutAt = cutoffCandidates.reduce((earliest, current) => (
            current < earliest ? current : earliest
        ), cutoffCandidates[0]);
    }

    return {
        mode,
        shift,
        shiftStartAt,
        shiftEndAt,
        maxWorkingHours,
        endOfDayAt,
        autoCheckoutAt
    };
};

const isWithinShiftWindow = ({ policy, currentTime = new Date() }) => {
    if (!policy?.shift || policy.shift.shiftType === 'any') {
        return true;
    }

    if (!policy.shiftStartAt || !policy.shiftEndAt) {
        return true;
    }

    const now = new Date(currentTime);
    return now >= policy.shiftStartAt && now <= policy.shiftEndAt;
};

module.exports = {
    IST_TIMEZONE,
    DEFAULT_SHIFT_CODE,
    DEFAULT_ATTENDANCE_MODE,
    DEFAULT_SHIFT_LIST,
    getISTTime,
    getISTDateParts,
    getStartOfDayIST,
    parseDateAsIST,
    parseTimeToMinutes,
    buildISTDateTime,
    buildEndOfDayIST,
    normalizeShiftList,
    resolveShiftForUser,
    buildAttendancePolicy,
    isWithinShiftWindow
};
