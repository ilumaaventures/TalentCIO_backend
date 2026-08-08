const cron = require('node-cron');
const { activateRecurringAnnouncements } = require('./controllers/announcementSchedulerController');

const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';

const startAnnouncementScheduler = (io) => {
    // Run daily at midnight: 0 0 * * *
    cron.schedule('0 0 * * *', async () => {
        console.log('[CRON] Running daily announcement scheduler...');
        try {
            await activateRecurringAnnouncements(io);
        } catch (error) {
            console.error('[CRON] Error in announcement scheduler job:', error);
        }
    }, {
        timezone: CRON_TIMEZONE
    });
    console.log('[CRON] Announcement scheduler initialized (0 0 * * *).');
};

module.exports = startAnnouncementScheduler;
