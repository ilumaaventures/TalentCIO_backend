const cron = require('node-cron');
const Attendance = require('../models/Attendance');

const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';
const AUTO_CHECKOUT_NOTE = '[Auto-checked out by system]';
let autoCheckoutJobRunning = false;

const getTodayBoundsInCronTimezone = (dateInput = new Date()) => {
    const zonedNow = new Date(dateInput.toLocaleString('en-US', { timeZone: CRON_TIMEZONE }));
    const start = new Date(zonedNow);
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    return { start, end };
};

const startAutoCheckoutCron = () => {
    // Run at 23:59:59 every day (Daily Checkout)
    // node-cron format with seconds: second minute hour dayOfMonth month dayOfWeek
    // '59 59 23 * * *' runs at 11:59:59 PM
    cron.schedule('59 59 23 * * *', async () => {
        if (autoCheckoutJobRunning) {
            console.warn('[CRON] Skipping auto-checkout because the previous cycle is still active.');
            return;
        }

        autoCheckoutJobRunning = true;
        console.log('[CRON] Running daily auto-checkout for forgotten sessions...');
        try {
            const { start, end } = getTodayBoundsInCronTimezone();

            // Find all records from today that have a clockIn but no clockOut
            const forgottenSessions = await Attendance.find({
                date: { $gte: start, $lt: end },
                clockIn: { $exists: true },
                $or: [
                    { clockOut: { $exists: false } },
                    { clockOut: null }
                ]
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
                checkoutTime.setHours(23, 59, 59, 0);
                const nextNotes = record.notes?.includes(AUTO_CHECKOUT_NOTE)
                    ? record.notes
                    : (record.notes ? `${record.notes} ${AUTO_CHECKOUT_NOTE}` : AUTO_CHECKOUT_NOTE);

                return {
                    updateOne: {
                        filter: {
                            _id: record._id,
                            $or: [
                                { clockOut: { $exists: false } },
                                { clockOut: null }
                            ]
                        },
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
