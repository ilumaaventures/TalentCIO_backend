const cron = require('node-cron');
const Attendance = require('../models/Attendance');

const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';
let autoCheckoutJobRunning = false;

const startAutoCheckoutCron = () => {
    // Run at 23:59:59 every day (Daily Checkout)
    // Format: minute hour dayOfMonth month dayOfWeek
    // '59 23 * * *' runs at 11:59:59 PM
    cron.schedule('59 23 * * *', async () => {
        if (autoCheckoutJobRunning) {
            console.warn('[CRON] Skipping auto-checkout because the previous cycle is still active.');
            return;
        }

        autoCheckoutJobRunning = true;
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
            })
                .select('_id user date notes')
                .lean();

            console.log(`[CRON] Found ${forgottenSessions.length} forgotten sessions.`);

            if (forgottenSessions.length === 0) {
                return;
            }

            const bulkUpdates = forgottenSessions.map(record => {
                // Set clockOut to 23:59:59 of that day
                const checkoutTime = new Date(record.date);
                checkoutTime.setHours(23, 59, 59, 999);
                const nextNotes = record.notes
                    ? `${record.notes} [Auto-checked out by system]`
                    : '[Auto-checked out by system]';

                return {
                    updateOne: {
                        filter: { _id: record._id, clockOut: { $exists: false } },
                        update: {
                            $set: {
                                clockOut: checkoutTime,
                                clockOutIST: checkoutTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                                status: 'PRESENT',
                                notes: nextNotes
                            }
                        }
                    }
                };
            });

            await Attendance.bulkWrite(bulkUpdates, { ordered: false });

            console.log('[CRON] Daily auto-checkout completed.');
        } catch (error) {
            console.error('[CRON] Error during auto-checkout:', error);
        } finally {
            autoCheckoutJobRunning = false;
        }
    }, {
        timezone: CRON_TIMEZONE
    });
};

module.exports = startAutoCheckoutCron;
