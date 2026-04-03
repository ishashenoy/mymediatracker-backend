const cron = require('node-cron');
const { purgeAccountsPastScheduledDate } = require('../services/permanentlyPurgeUser');

/**
 * Daily purge of accounts whose grace period has ended (see userModel account_scheduled_purge_at).
 */
function startAccountPurgeScheduler() {
  cron.schedule('0 2 * * *', async () => {
    try {
      const result = await purgeAccountsPastScheduledDate();
      if (result.purged > 0 || result.errors.length > 0) {
        console.log('[purgeScheduledAccounts]', result);
      }
    } catch (err) {
      console.error('[purgeScheduledAccounts]', err);
    }
  });
}

module.exports = { startAccountPurgeScheduler };
