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
    let current = new Date(start);

    // If start is an off day, move to the beginning of the next working day
    // For simplicity, we just iterate hour by hour if it's a small range (like 48h)
    // For a more robust solution across weeks, we could iterate by full days.
    
    // Hour-by-hour iteration for accuracy in partial days
    while (current < end) {
        const currentHour = new Date(current);
        const nextHour = new Date(current);
        nextHour.setHours(current.getHours() + 1);
        
        const effectiveEnd = nextHour > end ? end : nextHour;
        
        if (!offDayNums.includes(currentHour.getDay())) {
            totalMs += (effectiveEnd - current);
        }
        
        current = nextHour;
    }

    return totalMs / (1000 * 60 * 60);
};
