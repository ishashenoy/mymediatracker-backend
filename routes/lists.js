const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const List = require('../models/listModel');
const ListItem = require('../models/listItemModel');
const UserMedia = require('../models/userMediaModel');
const UniqueMedia = require('../models/uniqueMediaModel');
const requireAuth = require('../middleware/requireAuth');
const { findOrCreateUniqueMedia } = require('../controllers/mediaController');
const { fireEvent } = require('../controllers/eventsController');
const multer = require('multer');
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 200, // 100 requests per window
  message: "Too many requests. Try again later."
});

// Import banner controllers
const { changeBanner, getBanner } = require('../controllers/userController');


// Create a new custom list
router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  const user_id = req.user._id;
  if (!name || !user_id) {
    return res.status(400).json({ error: 'List name required.' });
  }
  try {
    const newList = new List({ user_id, name });
    await newList.save();
    return res.status(201).json({ list: newList });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});


// Get all lists for a user (with preview items and totalCount)
router.get('/user/:username', async (req, res) => {
  const { username } = req.params;
  const User = require('../models/userModel');
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Get all non-archived lists for the user
    const lists = await List.find({ user_id: user._id, archived: { $ne: true } });

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
          .sort({ createdAt: -1 })
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
  const { source, media_id } = req.query;
  const user_id = req.user._id;

  if (!source || !media_id) {
    return res.status(400).json({ error: 'source and media_id are required.' });
  }

  try {
    // Find the UniqueMedia
    const uniqueMedia = await UniqueMedia.findOne({
      source: String(source).trim(),
      media_id: String(media_id).trim(),
    });

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

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required.' });
  }

  if (!mongoose.Types.ObjectId.isValid(listId)) {
    return res.status(400).json({ error: 'Invalid listId.' });
  }

  try {
    // Verify list exists and belongs to user
    const list = await List.findById(listId);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    if (list.user_id.toString() !== user_id.toString()) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    // Find or create UniqueMedia (shared helper also dual-writes to canonical_media)
    const uniqueMedia = await findOrCreateUniqueMedia({
      name,
      image_url,
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
    try {
      await ListItem.create({
        list_id: listId,
        user_id,
        user_media_id: userMedia._id,
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

    return res.status(201).json({ message: 'Added to list.', userMediaId: userMedia._id });
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
  const User = require('../models/userModel');
  
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
          .sort({ createdAt: -1 })
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

    const items = await ListItem.find({ list_id: listId })
      .populate({
        path: 'user_media_id',
        populate: {
          path: 'unique_media_ref'
        }
      })
      .sort({ createdAt: -1 });

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
    const items = await ListItem.find({ list_id: listId })
      .populate({
        path: 'user_media_id',
        populate: { path: 'unique_media_ref' }
      })
      .sort({ createdAt: -1 });
    return res.status(200).json({
      ...list.toObject(),
      items,
      totalCount: items.length
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Banner routes for lists
router.post('/:listId/banner', limiter, requireAuth, upload.single('image'), changeBanner);
router.get('/:listId/banner', limiter, requireAuth, getBanner);

// // GET unified user collection (media + lists)
// router.get('/user/:username/collection', getUserCollection);

module.exports = router;
