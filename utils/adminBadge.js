/**
 * User badge flag was renamed is_creator_badge → is_admin_badge.
 * Accepts either field until DB documents are migrated (see scripts/renameCreatorBadgeToAdminBadge.js).
 */
function userHasAdminBadge(user) {
  if (!user || typeof user !== 'object') return false;
  if (user.is_admin_badge === true) return true;
  if (user.is_admin_badge === false) return false;
  return user.is_creator_badge === true;
}

module.exports = { userHasAdminBadge };
