/**
 * Calculates the total elapsed work hours between two dates, 
 * skipping days defined in the weeklyOff array.
 * 
 * @param {Date|String} startDate - Start of the period
 * @param {Date|String} endDate - End of the period
 * @param {Array<String>} weeklyOff - Array of days off (e.g. ['Saturday', 'Sunday'])
 * @returns {Number} Total elapsed work hours
 */
exports.calculateWorkHours = (startDate, endDate, weeklyOff = ['Saturday', 'Sunday']) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start) || isNaN(end) || start > end) return 0;

    const dayMap = { 
        'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 
        'Thursday': 4, 'Friday': 5, 'Saturday': 6 
    };
    
    const offDayNums = (weeklyOff || []).map(day => dayMap[day]).filter(n => n !== undefined);

    let totalMs = 0;
    let currentDay = new Date(start);
    currentDay.setHours(0, 0, 0, 0);

    // Iterate day-by-day instead of hour-by-hour so long-lived tickets do not
    // burn CPU just to compute elapsed working time.
    while (currentDay < end) {
        const nextDay = new Date(currentDay);
        nextDay.setDate(nextDay.getDate() + 1);

        if (!offDayNums.includes(currentDay.getDay())) {
            const effectiveStart = start > currentDay ? start : currentDay;
            const effectiveEnd = end < nextDay ? end : nextDay;

            if (effectiveStart < effectiveEnd) {
                totalMs += (effectiveEnd - effectiveStart);
            }
        }

        currentDay = nextDay;
    }

    return totalMs / (1000 * 60 * 60);
};
