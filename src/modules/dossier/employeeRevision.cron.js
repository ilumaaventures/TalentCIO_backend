const cron = require('node-cron');
const EmployeeRevision = require('./employeeRevision.model');
const { applyRevisionToEmployee } = require('./employeeRevision.controller');

const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';

let isJobRunning = false;

const runScheduledRevisionsScan = async () => {
    if (isJobRunning) {
        console.warn('[REVISION CRON] Skipping scan because previous cycle is still active.');
        return;
    }

    isJobRunning = true;
    try {
        const endOfToday = new Date();
        endOfToday.setHours(23, 59, 59, 999);

        // Find all scheduled revisions whose effective date has arrived (due on or before today)
        const dueRevisions = await EmployeeRevision.find({
            status: 'scheduled',
            effectiveDate: { $lte: endOfToday }
        }).sort({ effectiveDate: 1, createdAt: 1 });

        if (dueRevisions.length === 0) {
            return;
        }

        console.log(`[REVISION CRON] Found ${dueRevisions.length} due scheduled revision(s) to apply.`);

        let successCount = 0;
        let failureCount = 0;

        for (const revision of dueRevisions) {
            try {
                await applyRevisionToEmployee(revision, revision.companyId);
                successCount++;
                console.log(`[REVISION CRON] Successfully applied revision ${revision._id} for employee ${revision.employeeId}`);
            } catch (err) {
                failureCount++;
                console.error(`[REVISION CRON] Failed to apply revision ${revision._id}:`, err.message);
            }
        }

        console.log(`[REVISION CRON] Scan complete: ${successCount} applied, ${failureCount} failed.`);
    } catch (error) {
        console.error('[REVISION CRON] Error during scheduled revision execution:', error);
    } finally {
        isJobRunning = false;
    }
};

const startEmployeeRevisionCron = () => {
    // Run daily at midnight (00:00)
    cron.schedule('0 0 * * *', async () => {
        console.log('[REVISION CRON] Running daily employee revisions processor...');
        await runScheduledRevisionsScan();
    }, {
        timezone: CRON_TIMEZONE
    });

    console.log(`[REVISION CRON] Employee revision scheduler initialized (0 0 * * * @ ${CRON_TIMEZONE}).`);
};

module.exports = {
    startEmployeeRevisionCron,
    runScheduledRevisionsScan
};
