const cron = require('node-cron');
const Attendance = require('../models/Attendance');

const startAutoCheckoutCron = () => {
    // Run at 23:59:59 every day (Daily Checkout)
    // Format: minute hour dayOfMonth month dayOfWeek
    // '59 23 * * *' runs at 11:59:59 PM
    cron.schedule('59 23 * * *', async () => {
        console.log('[CRON] Running daily auto-checkout for forgotten sessions...');
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(today.getDate() + 1);

            // Find all records from today that have a clockIn but no clockOut
            const forgottenSessions = await Attendance.find({
                date: { $gte: today, $lt: tomorrow },
                clockIn: { $exists: true },
                clockOut: { $exists: false }
            });

            console.log(`[CRON] Found ${forgottenSessions.length} forgotten sessions.`);

            for (const record of forgottenSessions) {
                // Set clockOut to 23:59:59 of that day
                const checkoutTime = new Date(record.date);
                checkoutTime.setHours(23, 59, 59, 999);

                record.clockOut = checkoutTime;
                record.clockOutIST = checkoutTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
                record.status = 'PRESENT'; // Assume present if they at least clocked in
                record.notes = (record.notes || '') + ' [Auto-checked out by system]';

                await record.save();
                console.log(`[CRON] Auto-checked out user ${record.user} for ${record.date.toISOString().split('T')[0]}`);
            }

            console.log('[CRON] Daily auto-checkout completed.');
        } catch (error) {
            console.error('[CRON] Error during auto-checkout:', error);
        }
    });
};

module.exports = startAutoCheckoutCron;
