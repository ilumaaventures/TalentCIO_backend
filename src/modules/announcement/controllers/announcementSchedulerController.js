const Announcement = require('../announcement.model');
const { fetchPopulatedAnnouncementById, notifyPublishedAnnouncement } = require('../utils/announcementHelpers');

exports.activateRecurringAnnouncements = async (io) => {
    try {
        const today = new Date();
        const currentDay = today.getDate();

        const recurringAnnouncements = await Announcement.find({
            recurringInterval: { $in: ['monthly', 'quarterly', 'yearly'] },
            recurringDayOfMonth: currentDay,
            $or: [
                { expiresAt: null },
                { expiresAt: { $gt: today } }
            ]
        });

        if (recurringAnnouncements.length === 0) {
            return;
        }

        console.log(`[SCHEDULER] Found ${recurringAnnouncements.length} recurring candidates for day ${currentDay}`);

        for (const announcement of recurringAnnouncements) {
            try {
                const interval = announcement.recurringInterval;
                const start = announcement.createdAt || new Date();
                
                let shouldActivate = false;
                if (interval === 'monthly') {
                    shouldActivate = true;
                } else if (interval === 'quarterly') {
                    const monthsDiff = (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth());
                    if (monthsDiff % 3 === 0) {
                        shouldActivate = true;
                    }
                } else if (interval === 'yearly') {
                    if (today.getMonth() === start.getMonth()) {
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
                announcement.comments = [];
                announcement.reactions = [];
                
                await announcement.save();

                const populatedAnnouncement = await fetchPopulatedAnnouncementById(announcement._id);

                const mockReq = {
                    companyId: announcement.companyId,
                    user: { _id: announcement.createdBy },
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
