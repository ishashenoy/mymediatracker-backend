const User = require('../models/userModel');
const { isAdminUser } = require('../utils/privacy');

/**
 * Must run after requireAuth. Same rule as `isAdminUser` (role flags or admin/creator badge).
 */
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ error: 'Authorization token required' });
    }
    const user = await User.findById(req.user._id)
      .select('role isAdmin is_admin is_admin_badge is_creator_badge')
      .lean();
    if (!isAdminUser(user)) {
      return res.status(403).json({ error: 'Forbidden. Admin access required.' });
    }
    next();
  } catch (err) {
    console.error('requireAdmin', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = requireAdmin;
