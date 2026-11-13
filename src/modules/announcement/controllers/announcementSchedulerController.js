const Announcement = require('../announcement.model');
const { fetchPopulatedAnnouncementById, notifyPublishedAnnouncement } = require('../utils/announcementHelpers');

const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';

const getZonedParts = (date = new Date(), timeZone = CRON_TIMEZONE) => {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
    });
    const parts = formatter.formatToParts(date);
    const map = {};
    parts.forEach((p) => { map[p.type] = p.value; });
    return {
        year: parseInt(map.year, 10),
        month: parseInt(map.month, 10), // 1-12
        day: parseInt(map.day, 10)
    };
};

const getDaysInMonth = (year, month) => {
    return new Date(year, month, 0).getDate();
};

const isSameZonedDay = (dateA, dateB, timeZone = CRON_TIMEZONE) => {
    if (!dateA || !dateB) return false;
    const a = getZonedParts(new Date(dateA), timeZone);
    const b = getZonedParts(new Date(dateB), timeZone);
    return a.year === b.year && a.month === b.month && a.day === b.day;
};

exports.activateRecurringAnnouncements = async (io) => {
    try {
        const today = new Date();
        const todayZoned = getZonedParts(today, CRON_TIMEZONE);
        const currentDay = todayZoned.day;
        const daysInCurrentMonth = getDaysInMonth(todayZoned.year, todayZoned.month);
        const isLastDay = currentDay === daysInCurrentMonth;

        const dayFilter = isLastDay
            ? { $gte: currentDay, $lte: 31 }
            : currentDay;

        const recurringAnnouncements = await Announcement.find({
            recurringInterval: { $in: ['monthly', 'quarterly', 'yearly'] },
            recurringDayOfMonth: dayFilter,
            $or: [
                { expiresAt: null },
                { expiresAt: { $gt: today } }
            ]
        });

        if (recurringAnnouncements.length === 0) {
            return;
        }

        console.log(`[SCHEDULER] Found ${recurringAnnouncements.length} recurring candidates for day ${currentDay} (Timezone: ${CRON_TIMEZONE})`);

        for (const announcement of recurringAnnouncements) {
            try {
                // Prevent duplicate activation if it was already published today
                if (announcement.publishedAt && isSameZonedDay(announcement.publishedAt, today, CRON_TIMEZONE)) {
                    continue;
                }

                const interval = announcement.recurringInterval;
                const start = announcement.createdAt || new Date();
                const startZoned = getZonedParts(new Date(start), CRON_TIMEZONE);

                let shouldActivate = false;
                if (interval === 'monthly') {
                    shouldActivate = true;
                } else if (interval === 'quarterly') {
                    const monthsDiff = (todayZoned.year - startZoned.year) * 12 + (todayZoned.month - startZoned.month);
                    if (monthsDiff % 3 === 0) {
                        shouldActivate = true;
                    }
                } else if (interval === 'yearly') {
                    if (todayZoned.month === startZoned.month) {
                        shouldActivate = true;
                    }
                }

                if (!shouldActivate) {
                    continue;
                }

                console.log(`[SCHEDULER] Activating ${interval} recurring announcement: ${announcement.title}`);
                announcement.status = 'published';
                announcement.publishedAt = new Date();
                announcement.acknowledgements = [];
                // Comments and reactions are preserved for context history
                
                await announcement.save();

                const populatedAnnouncement = await fetchPopulatedAnnouncementById(announcement._id);

                const mockReq = {
                    companyId: announcement.companyId,
                    user: { _id: announcement.createdBy || null },
                    app: {
                        get: (key) => key === 'io' ? io : null
                    }
                };

                await notifyPublishedAnnouncement({ req: mockReq, announcement: populatedAnnouncement });
                console.log(`[SCHEDULER] Activated recurring announcement successfully: ${announcement.title}`);
            } catch (innerError) {
                console.error(`[SCHEDULER] Failed to activate recurring announcement ${announcement._id}:`, innerError);
            }
        }
    } catch (error) {
        console.error('[SCHEDULER] Error during recurring announcements activation:', error);
    }
};
