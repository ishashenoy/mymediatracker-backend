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
  if (targetUser.private !== true) return true;
  if (!requestingUser) return false;
  if (isOwnerOrAdmin(targetUser, requestingUser)) return true;

  const following = Array.isArray(requestingUser.following) ? requestingUser.following : [];
  return following.includes(targetUser.username);
};

module.exports = {
  isAdminUser,
  isOwnerOrAdmin,
  canViewPrivateAccountContent,
};
