const cron = require('node-cron');
const Attendance = require('../models/Attendance');
const Company = require('../models/Company');
const User = require('../models/User');
const {
    IST_TIMEZONE,
    buildAttendancePolicy,
    buildEndOfDayIST,
    getISTTime
} = require('../utils/attendancePolicy');

const CRON_TIMEZONE = process.env.CRON_TIMEZONE || IST_TIMEZONE;
const AUTO_CHECKOUT_NOTE = '[Auto-checked out by system]';
let autoCheckoutJobRunning = false;

const startAutoCheckoutCron = () => {
    // Run every minute and close open sessions that crossed shift end,
    // max working hours, or the end of day in IST.
    cron.schedule('0 * * * * *', async () => {
        if (autoCheckoutJobRunning) {
            console.warn('[CRON] Skipping auto-checkout because the previous cycle is still active.');
            return;
        }

        autoCheckoutJobRunning = true;
        console.log('[CRON] Running shift-aware auto-checkout scan...');
        try {
            const openSessions = await Attendance.find({
                clockIn: { $exists: true, $ne: null },
                attendanceMode: { $ne: 'present_only' },
                $or: [
                    { clockOut: { $exists: false } },
                    { clockOut: null }
                ]
            })
                .select('_id user companyId date clockIn notes autoCheckoutAt shiftCode shiftName shiftType shiftStartTime shiftEndTime maxWorkingHours')
                .lean();

            console.log(`[CRON] Found ${openSessions.length} open attendance sessions.`);

            if (openSessions.length === 0) {
                return;
            }

            const userIds = [...new Set(openSessions.map((record) => String(record.user)).filter(Boolean))];
            const companyIds = [...new Set(openSessions.map((record) => String(record.companyId)).filter(Boolean))];

            const [users, companies] = await Promise.all([
                User.find({ _id: { $in: userIds } })
                    .select('_id attendanceMode attendanceShiftCode')
                    .lean(),
                Company.find({ _id: { $in: companyIds } })
                    .select('_id settings.attendance')
                    .lean()
            ]);

            const usersById = new Map(users.map((user) => [String(user._id), user]));
            const companiesById = new Map(companies.map((company) => [String(company._id), company]));
            const now = new Date();

            const bulkUpdates = openSessions.flatMap((record) => {
                const company = companiesById.get(String(record.companyId));
                const user = usersById.get(String(record.user));
                const policy = buildAttendancePolicy({
                    company,
                    user,
                    attendanceDate: record.date,
                    clockInTime: record.clockIn
                });
                const checkoutTime = record.autoCheckoutAt
                    ? new Date(record.autoCheckoutAt)
                    : (policy.autoCheckoutAt || buildEndOfDayIST(record.date));

                if (checkoutTime > now) {
                    return [];
                }

                const nextNotes = record.notes?.includes(AUTO_CHECKOUT_NOTE)
                    ? record.notes
                    : (record.notes ? `${record.notes} ${AUTO_CHECKOUT_NOTE}` : AUTO_CHECKOUT_NOTE);

                return [{
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
                                clockOutIST: getISTTime(checkoutTime),
                                status: 'PRESENT',
                                notes: nextNotes,
                                autoCheckoutAt: checkoutTime,
                                autoCheckoutReason: AUTO_CHECKOUT_NOTE,
                                attendanceMode: policy.mode,
                                shiftCode: policy.shift?.code || record.shiftCode || null,
                                shiftName: policy.shift?.name || record.shiftName || null,
                                shiftType: policy.shift?.shiftType || record.shiftType || null,
                                shiftStartTime: policy.shift?.startTime || record.shiftStartTime || null,
                                shiftEndTime: policy.shift?.endTime || record.shiftEndTime || null,
                                maxWorkingHours: policy.maxWorkingHours || record.maxWorkingHours || null
                            }
                        }
                    }
                }];
            });

            if (bulkUpdates.length === 0) {
                return;
            }

            await Attendance.bulkWrite(bulkUpdates, { ordered: false });

            console.log(`[CRON] Auto-checkout completed for ${bulkUpdates.length} session(s).`);
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
