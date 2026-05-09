const {
    addWeeks,
    endOfDay,
    endOfMonth,
    endOfWeek,
    format,
    startOfDay,
    startOfMonth,
    startOfWeek
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
    const firstDayOfYear = new Date(year, 0, 1);
    const daysToFirstMonday = (8 - firstDayOfYear.getDay()) % 7;
    const firstMonday = new Date(year, 0, 1 + daysToFirstMonday);
    return startOfWeek(addWeeks(firstMonday, weekNumber - 1));
};

const getTimesheetPeriodIdForDate = (dateValue, cycle = 'Monthly') => {
    const date = new Date(dateValue);
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

    if (normalizedCycle === 'Weekly') {
        const weeklyMatch = String(periodId || '').match(WEEKLY_PERIOD_RE);
        if (weeklyMatch) {
            const year = parseInt(weeklyMatch[1], 10);
            const weekNumber = parseInt(weeklyMatch[2], 10);
            const start = getWeekStartFromYearAndNumber(year, weekNumber);
            return { start, end: endOfWeek(start) };
        }

        const date = new Date(`${periodId}-01`);
        return { start: startOfWeek(date), end: endOfWeek(date) };
    }

    if (normalizedCycle === 'Bi-Weekly') {
        const biWeeklyMatch = String(periodId || '').match(BI_WEEKLY_PERIOD_RE);
        if (biWeeklyMatch) {
            const year = parseInt(biWeeklyMatch[1], 10);
            const biWeeklyNumber = parseInt(biWeeklyMatch[2], 10);
            const firstWeekNumber = ((biWeeklyNumber - 1) * 2) + 1;
            const start = getWeekStartFromYearAndNumber(year, firstWeekNumber);
            const secondWeekStart = addWeeks(start, 1);
            return { start, end: endOfWeek(secondWeekStart) };
        }

        const derivedPeriodId = getTimesheetPeriodIdForDate(new Date(periodId), 'Bi-Weekly');
        return buildTimesheetPeriodRange(derivedPeriodId, 'Bi-Weekly');
    }

    if (normalizedCycle === 'Daily') {
        const start = startOfDay(new Date(periodId));
        return { start, end: endOfDay(start) };
    }

    const [year, month] = String(periodId).split('-');
    const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
    return { start: startOfMonth(date), end: endOfMonth(date) };
};

module.exports = {
    buildTimesheetPeriodRange,
    getTimesheetPeriodIdForDate,
    normalizeApprovalCycle
};
