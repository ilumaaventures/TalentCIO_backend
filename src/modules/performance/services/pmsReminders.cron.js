const cron = require('node-cron');
const os = require('os');
const { runPmsRemindersJob } = require('./pmsReminders.service');
const PmsLock = require('../models/pmsLock.model');

const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';
const PMS_REMINDERS_CRON_SCHEDULE = process.env.PMS_REMINDERS_CRON_SCHEDULE || '0 9 * * *'; // Daily at 09:00 AM

let pmsJobRunning = false;

/**
 * Initializes the PMS automated reminders cron scheduler with multi-instance distributed locking
 * @param {Object} io Socket.IO instance
 */
const startPmsRemindersCron = (io) => {
  if (process.env.DISABLE_PMS_REMINDERS_CRON === 'true') {
    console.log('[PMS CRON] PMS reminders cron disabled via DISABLE_PMS_REMINDERS_CRON flag.');
    return;
  }

  cron.schedule(
    PMS_REMINDERS_CRON_SCHEDULE,
    async () => {
      if (pmsJobRunning) {
        console.log('[PMS CRON] Previous reminder execution is still active locally, skipping tick.');
        return;
      }

      const now = new Date();
      const lockDurationMs = 15 * 60 * 1000; // 15 minutes lease
      const instanceId = `${os.hostname() || 'host'}-${process.pid}`;

      // Distributed lock acquisition to ensure single execution across horizontally scaled nodes
      let lockAcquired = false;
      try {
        const lock = await PmsLock.findOneAndUpdate(
          {
            _id: 'pms_daily_reminders',
            $or: [
              { expiresAt: { $lt: now } },
              { expiresAt: null },
              { lockedAt: null },
            ],
          },
          {
            $set: {
              lockedAt: now,
              expiresAt: new Date(now.getTime() + lockDurationMs),
              acquiredBy: instanceId,
            },
          },
          { upsert: true, new: true }
        );

        if (lock && lock.acquiredBy === instanceId) {
          lockAcquired = true;
        } else {
          console.log(`[PMS CRON] Cluster instance (${lock?.acquiredBy}) holds active distributed lock. Skipping tick.`);
          return;
        }
      } catch (lockErr) {
        console.warn('[PMS CRON] Distributed lock check failed, falling back to local process lock:', lockErr.message);
        lockAcquired = true;
      }

      if (!lockAcquired) return;

      pmsJobRunning = true;
      console.log(`[PMS CRON] [${instanceId}] Starting scheduled PMS appraisal reminders check at ${new Date().toISOString()}...`);

      try {
        const result = await runPmsRemindersJob({ io });
        console.log(
          `[PMS CRON] Reminders run complete: ${result.dispatchedReminders} sent, ${result.skippedDeduplicated} deduplicated across ${result.processedCycles} active cycles.`
        );
      } catch (err) {
        console.error('[PMS CRON] Unexpected error during PMS reminders execution:', err);
      } finally {
        pmsJobRunning = false;
        try {
          await PmsLock.updateOne(
            { _id: 'pms_daily_reminders', acquiredBy: instanceId },
            { $set: { expiresAt: new Date(0), lockedAt: null } }
          );
        } catch (_) {}
      }
    },
    {
      timezone: CRON_TIMEZONE,
    }
  );

  console.log(`[PMS CRON] PMS automated reminders cron scheduled with expression: "${PMS_REMINDERS_CRON_SCHEDULE}" (${CRON_TIMEZONE})`);
};

module.exports = startPmsRemindersCron;
