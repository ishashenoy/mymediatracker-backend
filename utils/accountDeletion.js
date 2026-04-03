const GRACE_DAYS = 30;

function isAccountPendingDeletion(user) {
  return Boolean(user?.account_deletion_requested_at);
}

function isAccountPastPurgeDeadline(user, now = new Date()) {
  if (!user?.account_scheduled_purge_at) return false;
  return now >= new Date(user.account_scheduled_purge_at);
}

/** Non-owners should not see any public surface for this user while deletion is pending. */
function shouldHideUserFromPublicDiscovery(user) {
  return isAccountPendingDeletion(user);
}

function scheduledPurgeAtFromNow(fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setUTCDate(d.getUTCDate() + GRACE_DAYS);
  return d;
}

module.exports = {
  GRACE_DAYS,
  isAccountPendingDeletion,
  isAccountPastPurgeDeadline,
  shouldHideUserFromPublicDiscovery,
  scheduledPurgeAtFromNow,
};
