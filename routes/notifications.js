const express = require('express');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const {
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../controllers/notificationController');

const router = express.Router();

const notificationsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 150,
  message: { error: 'Too many requests. Try again later.' },
});

router.use(notificationsLimiter);
router.use(requireAuth);

router.get('/', listNotifications);
router.get('/unread-count', getUnreadCount);
router.patch('/read-all', markAllNotificationsRead);
router.patch('/:notificationId/read', markNotificationRead);

module.exports = router;
