const mongoose = require('mongoose');
const Notification = require('../models/notificationModel');
const Comment = require('../models/commentModel');
const { userHasAdminBadge } = require('../utils/adminBadge');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

async function createNotification({ recipientId, actorId, type, entityType, entityId }) {
  if (!recipientId || !actorId || !type || !entityType || !entityId) return null;
  if (!isObjectId(recipientId) || !isObjectId(actorId) || !isObjectId(entityId)) return null;
  if (String(recipientId) === String(actorId)) return null;

  try {
    return await Notification.create({
      recipient_id: recipientId,
      actor_id: actorId,
      type,
      entity_type: entityType,
      entity_id: entityId,
    });
  } catch {
    return null;
  }
}

const listNotifications = async (req, res) => {
  const userId = req.user._id;
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(rawLimit, MAX_LIMIT))
    : DEFAULT_LIMIT;
  const { cursor } = req.query;

  if (cursor) {
    const date = new Date(cursor);
    if (Number.isNaN(date.getTime())) {
      return res.status(400).json({ error: 'Invalid cursor.' });
    }
  }

  try {
    const query = { recipient_id: userId };
    if (cursor) query.created_at = { $lt: new Date(cursor) };

    const rows = await Notification.find(query)
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .populate('actor_id', 'username icon is_admin_badge is_creator_badge')
      .lean();

    const hasMore = rows.length > limit;
    const notifications = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? notifications[notifications.length - 1].created_at.toISOString() : null;
    const commentNotifications = notifications.filter((n) => n.entity_type === 'comment');
    const commentIds = commentNotifications
      .map((n) => n.entity_id)
      .filter((id) => isObjectId(id));
    const comments = commentIds.length
      ? await Comment.find({ _id: { $in: commentIds } }).select('_id post_id').lean()
      : [];
    const commentToPostMap = new Map(comments.map((c) => [String(c._id), String(c.post_id)]));

    return res.status(200).json({
      notifications: notifications.map((n) => ({
        _id: n._id,
        type: n.type,
        entity_type: n.entity_type,
        entity_id: n.entity_id,
        target_post_id: n.entity_type === 'comment'
          ? (commentToPostMap.get(String(n.entity_id)) || null)
          : (n.entity_type === 'post' ? String(n.entity_id) : null),
        read: Boolean(n.read),
        created_at: n.created_at,
        actor: n.actor_id ? {
          _id: n.actor_id._id,
          username: n.actor_id.username,
          icon: n.actor_id.icon || null,
          is_admin_badge: userHasAdminBadge(n.actor_id),
        } : null,
      })),
      hasMore,
      nextCursor,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const getUnreadCount = async (req, res) => {
  try {
    const unreadCount = await Notification.countDocuments({
      recipient_id: req.user._id,
      read: false,
    });
    return res.status(200).json({ unreadCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const markNotificationRead = async (req, res) => {
  const { notificationId } = req.params;
  if (!isObjectId(notificationId)) {
    return res.status(400).json({ error: 'Invalid notification id.' });
  }

  try {
    const updated = await Notification.findOneAndUpdate(
      { _id: notificationId, recipient_id: req.user._id },
      { $set: { read: true } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Notification not found.' });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const markAllNotificationsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient_id: req.user._id, read: false },
      { $set: { read: true } }
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createNotification,
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
};
