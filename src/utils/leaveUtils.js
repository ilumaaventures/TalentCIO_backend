const Holiday = require('../models/Holiday');
const { eachDayOfInterval, format, isSameDay } = require('date-fns');

/**
 * Calculate the number of leave days based on range and policy rules.
 * @param {Date} startDate 
 * @param {Date} endDate 
 * @param {Object} leavePolicy (LeaveConfig)
 * @param {Array} holidays (List of holiday dates, optional optimization)
 * @returns {Number} daysCount
 */
/**
 * Calculate the number of leave days based on range and policy rules.
 * @param {Date} startDate 
 * @param {Date} endDate 
 * @param {Object} leavePolicy (LeaveConfig)
 * @param {Array<string>} weeklyOffs (List of day names, e.g. ['Saturday', 'Sunday'])
 * @returns {Number} daysCount
 */
const calculateLeaveDays = async (startDate, endDate, leavePolicy, weeklyOffs = ['Saturday', 'Sunday']) => {
    if (!startDate || !endDate || !leavePolicy) return 0;

    // 1. Get all days in range
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    let count = 0;

    // 2. Fetch Holidays within the date range for the SPECIFIC company
    const holidayDocs = await Holiday.find({
        companyId: leavePolicy.companyId,
        date: { $gte: startDate, $lte: endDate }
    });
    const holidayDates = holidayDocs.map(h => new Date(h.date).toDateString());

    // 3. Iterate
    for (const day of days) {
        const dateStr = day.toDateString();
        const dayName = format(day, 'EEEE');
        const isWeeklyOff = weeklyOffs.includes(dayName);
        const isHoliday = holidayDates.includes(dateStr);
        const isOffDay = isWeeklyOff || isHoliday;

        if (!isOffDay) {
            // Working Day -> Always Counts as Leave
            count++;
        } else {
            // Off Day (Holiday/Weekend) -> Counts as Leave ONLY if Sandwich Rule is TRUE
            if (leavePolicy.sandwichRule) {
                count++;
            }
        }
    }

    return count;
};

module.exports = { calculateLeaveDays };
