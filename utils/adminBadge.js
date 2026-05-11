/**
 * Storage-only: visible admin badge or legacy creator badge.
 * Role-based admins are handled in `privacy.isAdminUser`.
 */
function userHasAdminBadge(user) {
  if (!user || typeof user !== 'object') return false;
  if (user.is_admin_badge === true) return true;
  return user.is_creator_badge === true;
}

module.exports = { userHasAdminBadge };
