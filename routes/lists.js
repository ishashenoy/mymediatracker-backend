const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const List = require('../models/listModel');
const ListItem = require('../models/listItemModel');
const UserMedia = require('../models/userMediaModel');
const UniqueMedia = require('../models/uniqueMediaModel');
const User = require('../models/userModel');
const requireAuth = require('../middleware/requireAuth');
const { findOrCreateUniqueMedia } = require('../controllers/mediaController');
const { fireEvent } = require('../controllers/eventsController');
const { sanitizeText, sanitizeUrl } = require('../utils/sanitize');
const { isAdminUser, isOwnerOrAdmin, canViewPrivateAccountContent } = require('../utils/privacy');

// Set privacy for a list
router.put('/:listId/privacy', requireAuth, async (req, res) => {
  const { listId } = req.params;
  const { private: isPrivate } = req.body;
  const user_id = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(listId)) {
    return res.status(400).json({ error: 'Invalid listId.' });
  }
  if (typeof isPrivate !== 'boolean') {
    return res.status(400).json({ error: 'Invalid privacy value.' });
  }

  try {
    const list = await List.findById(listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    if (list.user_id.toString() !== user_id.toString()) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    list.private = isPrivate;
    await list.save();
    return res.status(200).json({ list });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Reorder lists for the authenticated user
router.put('/reorder', requireAuth, async (req, res) => {
  const { listIds } = req.body;
  const user_id = req.user._id;

  if (!Array.isArray(listIds) || listIds.length === 0) {
    return res.status(400).json({ error: 'listIds must be a non-empty array.' });
  }

  try {
    const ownedLists = await List.find({ user_id, archived: { $ne: true } }).select('_id');
    const ownedIdSet = new Set(ownedLists.map((list) => list._id.toString()));

    if (ownedIdSet.size !== listIds.length || listIds.some((id) => !ownedIdSet.has(String(id)))) {
      return res.status(400).json({ error: 'listIds must include all and only your active lists.' });
    }

    await Promise.all(
      listIds.map((listId, index) =>
        List.updateOne(
          { _id: listId, user_id },
          { $set: { position: index, updated_at: new Date() } }
        )
      )
    );

    return res.status(200).json({ message: 'List order updated.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Reorder items within a list for the authenticated owner
router.put('/:listId/items/reorder', requireAuth, async (req, res) => {
  const { listId } = req.params;
  const { itemIds } = req.body;
  const user_id = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(listId)) {
    return res.status(400).json({ error: 'Invalid listId.' });
  }
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: 'itemIds must be a non-empty array.' });
  }

  try {
    const list = await List.findById(listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    if (list.user_id.toString() !== user_id.toString()) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    const listItems = await ListItem.find({ list_id: listId }).select('_id');
    const listItemIdSet = new Set(listItems.map((item) => item._id.toString()));

    if (listItemIdSet.size !== itemIds.length || itemIds.some((id) => !listItemIdSet.has(String(id)))) {
      return res.status(400).json({ error: 'itemIds must include all and only items in this list.' });
    }

    await Promise.all(
      itemIds.map((itemId, index) =>
        ListItem.updateOne(
          { _id: itemId, list_id: listId },
          { $set: { position: index } }
        )
      )
    );

    return res.status(200).json({ message: 'List item order updated.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 200, // 100 requests per window
  message: "Too many requests. Try again later."
});

const ensureListOwner = async (listId, userId) => {
  const list = await List.findById(listId);
  if (!list) return { error: { status: 404, message: 'List not found.' } };
  if (list.user_id.toString() !== userId.toString()) {
    return { error: { status: 403, message: 'Not authorized.' } };
  }
  return { list };
};

const canViewList = async (list, requestingUser) => {
  const listOwner = await User.findById(list.user_id).select('_id username private');
  if (!listOwner) return false;
  if (!canViewPrivateAccountContent(listOwner, requestingUser)) return false;
  if (list?.private !== true) return true;
  if (!requestingUser) return false;
  if (requestingUser._id.toString() === list.user_id.toString()) return true;
  return isAdminUser(requestingUser);
};

const getRequestingUser = async (req) => {
  if (req.requestingUser !== undefined) return req.requestingUser;

  req.requestingUser = null;
  const { authorization } = req.headers;
  if (!authorization || !authorization.startsWith('Bearer ')) return req.requestingUser;

  const token = authorization.split(' ')[1];
  if (!token) return req.requestingUser;

  try {
    const { _id } = jwt.verify(token, process.env.SECRET);
    req.requestingUser = await User.findById(_id).select('_id username following role isAdmin is_admin');
  } catch (error) {
    req.requestingUser = null;
  }

  return req.requestingUser;
};


// Create a new custom list
router.post('/', requireAuth, async (req, res) => {
  const { name, private: isPrivate } = req.body;
  const user_id = req.user._id;
  const safeName = sanitizeText(name, { maxLen: 80, allowNewlines: false });
  if (!safeName || !user_id) {
    return res.status(400).json({ error: 'List name required.' });
  }
  try {
    const currentMax = await List.findOne({ user_id }).sort({ position: -1 }).select('position');
    const nextPosition = typeof currentMax?.position === 'number' ? currentMax.position + 1 : 0;
    const newList = new List({
      user_id,
      name: safeName,
      private: Boolean(isPrivate),
      position: nextPosition,
    });
    await newList.save();
    return res.status(201).json({ list: newList });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});


// Get all lists for a user (with preview items and totalCount)
router.get('/user/:username', async (req, res) => {
  const { username } = req.params;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const requestingUser = await getRequestingUser(req);
    const ownerOrAdmin = isOwnerOrAdmin(user, requestingUser);
    if (user.account_deletion_requested_at && !ownerOrAdmin) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const canViewPrivateContent = canViewPrivateAccountContent(user, requestingUser);
    if (!canViewPrivateContent) {
      return res.status(200).json({ lists: [] });
    }

    // Get all non-archived lists for the user
    const lists = await List.find({
      user_id: user._id,
      archived: { $ne: true },
      ...(ownerOrAdmin ? {} : { private: { $ne: true } }),
    }).sort({ position: 1, created_at: -1 });

    // For each list, get preview items and true count
    const listsWithItems = await Promise.all(
      lists.map(async (list) => {
        // Preview (first 4)
        const previewItems = await ListItem.find({ list_id: list._id })
          .populate({
            path: 'user_media_id',
            populate: {
              path: 'unique_media_ref'
            }
          })
          .sort({ position: 1, createdAt: -1 })
          .limit(4);
        // True count
        const totalCount = await ListItem.countDocuments({ list_id: list._id });
        return {
          ...list.toObject(),
          items: previewItems,
          totalCount
        };
      })
    );
    return res.status(200).json({ lists: listsWithItems });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Get which lists a specific media belongs to for the authenticated user
router.get('/media-membership', requireAuth, async (req, res) => {
  const { source, media_id, type } = req.query;
  const user_id = req.user._id;

  if (!source || !media_id) {
    return res.status(400).json({ error: 'source and media_id are required.' });
  }

  try {
    // Find the UniqueMedia — include type so MAL anime/manga IDs don't collide
    const membershipQuery = {
      source: String(source).trim(),
      media_id: String(media_id).trim(),
    };
    if (type) membershipQuery.type = String(type).trim();
    const uniqueMedia = await UniqueMedia.findOne(membershipQuery);

    if (!uniqueMedia) {
      return res.status(200).json({ listIds: [], userMediaId: null });
    }

    // Find the UserMedia for this user + unique media
    const userMedia = await UserMedia.findOne({
      user_id,
      unique_media_ref: uniqueMedia._id,
    });

    if (!userMedia) {
      return res.status(200).json({ listIds: [], userMediaId: null });
    }

    // Find all ListItems for this UserMedia
    const listItems = await ListItem.find({
      user_media_id: userMedia._id,
      user_id,
    });

    const listIds = listItems.map(li => li.list_id.toString());
    return res.status(200).json({ listIds, userMediaId: userMedia._id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Add media to a specific list (find or create UniqueMedia + UserMedia, then create ListItem)
router.post('/:listId/add-media', requireAuth, async (req, res) => {
  const { listId } = req.params;
  const { name, image_url, type, source, media_id, score } = req.body;
  const user_id = req.user._id;

  const safeName = sanitizeText(name, { maxLen: 200, allowNewlines: false });
  const safeImageUrl = sanitizeUrl(image_url);
  if (!safeName || !type) {
    return res.status(400).json({ error: 'name and type are required.' });
  }

  if (!mongoose.Types.ObjectId.isValid(listId)) {
    return res.status(400).json({ error: 'Invalid listId.' });
  }

  try {
    const ownership = await ensureListOwner(listId, user_id);
    if (ownership.error) {
      return res.status(ownership.error.status).json({ error: ownership.error.message });
    }

    // Find or create UniqueMedia (shared helper also dual-writes to canonical_media)
    const uniqueMedia = await findOrCreateUniqueMedia({
      name: safeName,
      image_url: safeImageUrl,
      type,
      source,
      media_id,
      score,
    });

    // Find or create UserMedia
    let userMedia = await UserMedia.findOne({ user_id, unique_media_ref: uniqueMedia._id });
    if (!userMedia) {
      userMedia = await UserMedia.create({
        user_id,
        unique_media_ref: uniqueMedia._id,
        status: 'to-do',
        use_custom_display: false,
      });
    }

    // Create ListItem (ignore duplicate errors)
    let createdListItem = null;
    try {
      const lastItem = await ListItem.findOne({ list_id: listId }).sort({ position: -1 }).select('position');
      const nextPosition = typeof lastItem?.position === 'number' ? lastItem.position + 1 : 0;
      createdListItem = await ListItem.create({
        list_id: listId,
        user_id,
        user_media_id: userMedia._id,
        position: nextPosition,
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(200).json({ message: 'Already in this list.', alreadyExists: true });
      }
      throw err;
    }

    // Fire list_add event (async, fire-and-forget)
    setImmediate(() => fireEvent(user_id, 'list_add', userMedia.canonical_id || null, {
      list_id: String(listId),
    }));

    return res.status(201).json({
      message: 'Added to list.',
      userMediaId: userMedia._id,
      listItemId: createdListItem?._id,
      position: createdListItem?.position,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Remove media from a specific list (only removes ListItem, not UserMedia)
router.delete('/:listId/remove-media', requireAuth, async (req, res) => {
  const { listId } = req.params;
  const { source, media_id } = req.body;
  const user_id = req.user._id;

  if (!source || !media_id) {
    return res.status(400).json({ error: 'source and media_id are required.' });
  }

  if (!mongoose.Types.ObjectId.isValid(listId)) {
    return res.status(400).json({ error: 'Invalid listId.' });
  }

  try {
    const ownership = await ensureListOwner(listId, user_id);
    if (ownership.error) {
      return res.status(ownership.error.status).json({ error: ownership.error.message });
    }

    // Find UniqueMedia
    const uniqueMedia = await UniqueMedia.findOne({
      source: String(source).trim(),
      media_id: String(media_id).trim(),
    });
    if (!uniqueMedia) {
      return res.status(404).json({ error: 'Media not found.' });
    }

    // Find UserMedia
    const userMedia = await UserMedia.findOne({ user_id, unique_media_ref: uniqueMedia._id });
    if (!userMedia) {
      return res.status(404).json({ error: 'Media not in your collection.' });
    }

    // Delete the ListItem
    const result = await ListItem.deleteOne({
      list_id: listId,
      user_media_id: userMedia._id,
      user_id,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Media not in this list.' });
    }

    return res.status(200).json({ message: 'Removed from list.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Archive a list
router.put('/:listId/archive', requireAuth, async (req, res) => {
  const { listId } = req.params;
  const user_id = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(listId)) {
    return res.status(400).json({ error: 'Invalid listId.' });
  }

  try {
    const list = await List.findById(listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    if (list.user_id.toString() !== user_id.toString()) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    list.archived = true;
    await list.save();

    return res.status(200).json({ message: 'List archived successfully.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Rename a list
router.put('/:listId/rename', requireAuth, async (req, res) => {
  const { listId } = req.params;
  const { name } = req.body;
  const user_id = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(listId)) {
    return res.status(400).json({ error: 'Invalid listId.' });
  }
  const safeName = sanitizeText(name, { maxLen: 80, allowNewlines: false });
  if (!safeName) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  try {
    const list = await List.findById(listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    if (list.user_id.toString() !== user_id.toString()) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    list.name = safeName;
    await list.save();

    return res.status(200).json({ message: 'List renamed successfully.', name: list.name });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Restore an archived list
router.put('/:listId/restore', requireAuth, async (req, res) => {
  const { listId } = req.params;
  const user_id = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(listId)) {
    return res.status(400).json({ error: 'Invalid listId.' });
  }

  try {
    const list = await List.findById(listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    if (list.user_id.toString() !== user_id.toString()) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    list.archived = false;
    await list.save();

    return res.status(200).json({ message: 'List restored successfully.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Get all archived lists for the authenticated user
router.get('/user/:username/archived', requireAuth, async (req, res) => {
  const { username } = req.params;
  
  try {
    // Only allow users to see their own archived lists
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Not authorized to view these lists.' });
    }

    const lists = await List.find({ user_id: user._id, archived: true });

    const listsWithItems = await Promise.all(
      lists.map(async (list) => {
        const previewItems = await ListItem.find({ list_id: list._id })
          .populate({
            path: 'user_media_id',
            populate: { path: 'unique_media_ref' }
          })
          .sort({ position: 1, createdAt: -1 })
          .limit(4);
        const totalCount = await ListItem.countDocuments({ list_id: list._id });
        return {
          ...list.toObject(),
          items: previewItems,
          totalCount
        };
      })
    );
    return res.status(200).json({ lists: listsWithItems });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Get individual list details
router.get('/:listId', async (req, res) => {
  const { listId } = req.params;
  try {
    const list = await List.findById(listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });

    const requestingUser = await getRequestingUser(req);
    if (!(await canViewList(list, requestingUser))) {
      return res.status(403).json({ error: 'This list is private.' });
    }

    return res.status(200).json(list);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Get list items
router.get('/:listId/items', async (req, res) => {
  const { listId } = req.params;
  try {
    // Check if the listId is valid
    if (!listId || listId.length !== 24) {
      return res.status(400).json({ error: 'Invalid listId format.' });
    }

    const list = await List.findById(listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });

    const requestingUser = await getRequestingUser(req);
    if (!(await canViewList(list, requestingUser))) {
      return res.status(403).json({ error: 'This list is private.' });
    }

    const items = await ListItem.find({ list_id: listId })
      .populate({
        path: 'user_media_id',
        populate: {
          path: 'unique_media_ref'
        }
      })
      .sort({ position: 1, createdAt: -1 });

    // If no items found, return a 404
    if (items.length === 0) {
      return res.status(404).json({ error: 'No items found for this list.' });
    }

    return res.status(200).json(items);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Get full list details (metadata + all items)
router.get('/:listId/full', async (req, res) => {
  const { listId } = req.params;
  try {
    // Check if the listId is valid
    if (!listId || listId.length !== 24) {
      return res.status(400).json({ error: 'Invalid listId format.' });
    }
    const list = await List.findById(listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });

    const requestingUser = await getRequestingUser(req);
    if (!(await canViewList(list, requestingUser))) {
      return res.status(403).json({ error: 'This list is private.' });
    }

    const items = await ListItem.find({ list_id: listId })
      .populate({
        path: 'user_media_id',
        populate: { path: 'unique_media_ref' }
      })
      .sort({ position: 1, createdAt: -1 });
    const listObject = list.toObject();
    const listOwner = await User.findById(list.user_id).select('_id username icon is_creator_badge');
    const owner = listOwner
      ? {
          _id: listOwner._id,
          username: listOwner.username,
          icon: listOwner.icon || null,
          is_creator_badge: listOwner.is_creator_badge === true,
        }
      : null;

    return res.status(200).json({
      ...listObject,
      items,
      totalCount: items.length,
      owner,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// // GET unified user collection (media + lists)
// router.get('/user/:username/collection', getUserCollection);

module.exports = router;
