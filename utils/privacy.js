const User = require('../models/userModel');

const isAdminUser = (user) => {
  if (!user) return false;
  return user.role === 'admin' || user.isAdmin === true || user.is_admin === true;
};

const isOwnerOrAdmin = (targetUser, requestingUser) => {
  if (!targetUser || !requestingUser) return false;
  if (requestingUser._id.toString() === targetUser._id.toString()) return true;
  return isAdminUser(requestingUser);
};

const canViewPrivateAccountContent = (targetUser, requestingUser) => {
  if (!targetUser) return false;
  // Pending account deletion: only the account owner (or admin) may see library / posts / lists.
  if (targetUser.account_deletion_requested_at) {
    return isOwnerOrAdmin(targetUser, requestingUser);
  }
  if (targetUser.private !== true) return true;
  if (!requestingUser) return false;
  if (isOwnerOrAdmin(targetUser, requestingUser)) return true;

  const following = Array.isArray(requestingUser.following) ? requestingUser.following : [];
  return following.includes(targetUser.username);
};

/**
 * Whether the user may create a post with linked_list_id for this list.
 * Mirrors visibility for GET /api/lists/:listId/full (see routes/lists canViewList).
 */
const canPostDiscussionOnList = async (list, postingUserId) => {
  if (!list) return false;
  const listOwner = await User.findById(list.user_id).select('_id username private account_deletion_requested_at following role isAdmin is_admin').lean();
  if (!listOwner) return false;
  const postingUser = await User.findById(postingUserId).select('_id username following role isAdmin is_admin').lean();
  if (!postingUser) return false;
  if (!canViewPrivateAccountContent(listOwner, postingUser)) return false;
  if (list.private !== true) return true;
  if (postingUser._id.toString() === list.user_id.toString()) return true;
  return isAdminUser(postingUser);
};

module.exports = {
  isAdminUser,
  isOwnerOrAdmin,
  canViewPrivateAccountContent,
  canPostDiscussionOnList,
};
