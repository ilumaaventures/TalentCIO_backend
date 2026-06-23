const {
    addWeeks,
    endOfDay,
    endOfMonth,
    endOfISOWeek,
    format,
    startOfDay,
    startOfMonth,
    startOfISOWeek
} = require('date-fns');

const WEEKLY_PERIOD_RE = /^(\d{4})-W(\d{2})$/;
const BI_WEEKLY_PERIOD_RE = /^(\d{4})-BW(\d{2})$/;

const normalizeApprovalCycle = (cycle = 'Monthly') => {
    if (cycle === 'Daily' || cycle === 'Weekly' || cycle === 'Bi-Weekly') {
        return cycle;
    }
    return 'Monthly';
};

const getWeekStartFromYearAndNumber = (year, weekNumber) => {
    // ISO week 1 is the week containing January 4th.
    const isoWeekYearStart = startOfISOWeek(new Date(year, 0, 4));
    return addWeeks(isoWeekYearStart, weekNumber - 1);
};

const toLocalTimezoneRep = (dateInput, timeZone = 'Asia/Kolkata') => {
    if (!dateInput) return dateInput;
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return date;
    const tzString = date.toLocaleString('en-US', { timeZone });
    return new Date(tzString);
};

const fromLocalTimezoneRep = (localRepDate, timeZoneOffset = '+05:30') => {
    if (!localRepDate || isNaN(localRepDate.getTime())) return localRepDate;
    const year = localRepDate.getFullYear();
    const month = String(localRepDate.getMonth() + 1).padStart(2, '0');
    const day = String(localRepDate.getDate()).padStart(2, '0');
    const hours = String(localRepDate.getHours()).padStart(2, '0');
    const minutes = String(localRepDate.getMinutes()).padStart(2, '0');
    const seconds = String(localRepDate.getSeconds()).padStart(2, '0');
    const ms = String(localRepDate.getMilliseconds()).padStart(3, '0');
    return new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${timeZoneOffset}`);
};

const getTimesheetPeriodIdForDate = (dateValue, cycle = 'Monthly') => {
    const date = toLocalTimezoneRep(dateValue);
    const normalizedCycle = normalizeApprovalCycle(cycle);

    if (normalizedCycle === 'Weekly') {
        return format(date, "yyyy-'W'II");
    }

    if (normalizedCycle === 'Bi-Weekly') {
        const weekNumber = parseInt(format(date, 'II'), 10);
        const biWeeklyNumber = Math.ceil(weekNumber / 2);
        return `${format(date, 'yyyy')}-BW${String(biWeeklyNumber).padStart(2, '0')}`;
    }

    if (normalizedCycle === 'Daily') {
        return format(date, 'yyyy-MM-dd');
    }

    return format(date, 'yyyy-MM');
};

const buildTimesheetPeriodRange = (periodId, cycle = 'Monthly') => {
    const normalizedCycle = normalizeApprovalCycle(cycle);

    let range;
    if (normalizedCycle === 'Weekly') {
        const weeklyMatch = String(periodId || '').match(WEEKLY_PERIOD_RE);
        if (weeklyMatch) {
            const year = parseInt(weeklyMatch[1], 10);
            const weekNumber = parseInt(weeklyMatch[2], 10);
            const start = getWeekStartFromYearAndNumber(year, weekNumber);
            range = { start, end: endOfISOWeek(start) };
        } else {
            const date = toLocalTimezoneRep(periodId);
            range = { start: startOfISOWeek(date), end: endOfISOWeek(date) };
        }
    } else if (normalizedCycle === 'Bi-Weekly') {
        const biWeeklyMatch = String(periodId || '').match(BI_WEEKLY_PERIOD_RE);
        if (biWeeklyMatch) {
            const year = parseInt(biWeeklyMatch[1], 10);
            const biWeeklyNumber = parseInt(biWeeklyMatch[2], 10);
            const firstWeekNumber = ((biWeeklyNumber - 1) * 2) + 1;
            const start = getWeekStartFromYearAndNumber(year, firstWeekNumber);
            const secondWeekStart = addWeeks(start, 1);
            range = { start, end: endOfISOWeek(secondWeekStart) };
        } else {
            const derivedPeriodId = getTimesheetPeriodIdForDate(new Date(periodId), 'Bi-Weekly');
            return buildTimesheetPeriodRange(derivedPeriodId, 'Bi-Weekly');
        }
    } else if (normalizedCycle === 'Daily') {
        const date = toLocalTimezoneRep(periodId);
        const start = startOfDay(date);
        range = { start, end: endOfDay(start) };
    } else {
        // Monthly
        const monthlyMatch = String(periodId || '').match(/^(\d{4})-(\d{2})$/);
        let date;
        if (monthlyMatch) {
            const year = parseInt(monthlyMatch[1], 10);
            const month = parseInt(monthlyMatch[2], 10);
            date = new Date(year, month - 1, 1);
        } else {
            date = toLocalTimezoneRep(periodId);
        }
        range = { start: startOfMonth(date), end: endOfMonth(date) };
    }

    return {
        start: fromLocalTimezoneRep(range.start),
        end: fromLocalTimezoneRep(range.end)
    };
};

module.exports = {
    buildTimesheetPeriodRange,
    getTimesheetPeriodIdForDate,
    normalizeApprovalCycle,
    toLocalTimezoneRep,
    fromLocalTimezoneRep
};
