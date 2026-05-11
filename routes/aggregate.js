const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');

const Post = require('../models/postModel');
const UserMedia = require('../models/userMediaModel');
const User = require('../models/userModel');
const UniqueMedia = require('../models/uniqueMediaModel');
const List = require('../models/listModel');
const ListItem = require('../models/listItemModel');
const { buildFeedPostQuery } = require('../utils/feedPostQuery');
const { canViewPrivateAccountContent, isAdminUser, mongoIsAdminUserExpr } = require('../utils/privacy');
const { hydratePosts } = require('../controllers/postController');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests. Try again later.' },
});

// Suggestions cached per user (5 minutes) — invalidated on follow/unfollow
const suggestionsCache = new NodeCache({ stdTTL: 300 });

/** Who-to-follow suggestions (cached per user for 5 min). */
async function fetchSuggestions(userId) {
  const key = `sug_${userId}`;
  const cached = suggestionsCache.get(key);
  if (cached) return cached;

  const user = await User.findById(userId).select('following').lean();
  const followingUsernames = user?.following || [];

  const suggestions = await User.aggregate([
    {
      $match: {
        _id: { $ne: userId },
        username: { $nin: followingUsernames },
        private: { $ne: true },
      },
    },
    { $addFields: { follower_count: { $size: { $ifNull: ['$followers', []] } } } },
    { $sort: { follower_count: -1 } },
    { $limit: 5 },
    {
      $project: {
        username: 1,
        icon: 1,
        is_admin_badge: mongoIsAdminUserExpr,
      },
    },
  ]);

  suggestionsCache.set(key, suggestions);
  return suggestions;
}

function followingStripUserPayload(doc) {
  return {
    _id: doc._id,
    username: doc.username,
    displayName: doc.displayName || '',
    icon: doc.icon || null,
    is_admin_badge: isAdminUser(doc),
  };
}

/** People you follow (in follow order) whose newest library title on a public list has a usable cover. */
async function fetchFollowingFeedStrip(viewerId) {
  const me = await User.findById(viewerId).select('following').lean();
  const followingUsernames = Array.isArray(me?.following) ? me.following : [];
  if (!followingUsernames.length) return [];

  const followedUsers = await User.find({ username: { $in: followingUsernames } })
    .select('username displayName icon is_admin_badge is_creator_badge role isAdmin is_admin private account_deletion_requested_at')
    .lean();

  const byUsername = new Map(followedUsers.map((u) => [u.username, u]));
  const ordered = followingUsernames.map((uname) => byUsername.get(uname)).filter(Boolean);
  const visible = ordered.filter((u) => canViewPrivateAccountContent(u, me));
  if (!visible.length) return [];

  const ids = visible.map((u) => u._id);

  const publicLists = await List.find({
    user_id: { $in: ids },
    archived: { $ne: true },
    private: { $ne: true },
  })
    .select('_id')
    .lean();

  const publicListIds = publicLists.map((l) => l._id);
  if (!publicListIds.length) return [];

  const listItems = await ListItem.find({
    list_id: { $in: publicListIds },
    user_id: { $in: ids },
  })
    .select('user_media_id')
    .lean();

  const allowedMediaIds = [...new Set(listItems.map((li) => li.user_media_id.toString()))];
  if (!allowedMediaIds.length) return [];

  const allowedObjectIds = allowedMediaIds.map((id) => new mongoose.Types.ObjectId(id));

  const groups = await UserMedia.aggregate([
    {
      $match: {
        user_id: { $in: ids },
        _id: { $in: allowedObjectIds },
      },
    },
    { $sort: { user_id: 1, createdAt: -1 } },
    { $group: { _id: '$user_id', doc: { $first: '$$ROOT' } } },
  ]);

  const groupMap = new Map(groups.map((g) => [g._id.toString(), g.doc]));
  const umObjectIds = [...new Set(groups.map((g) => g.doc.unique_media_ref).filter(Boolean))];
  const ums = await UniqueMedia.find({ _id: { $in: umObjectIds } })
    .select('name type image_url')
    .lean();
  const umMap = new Map(ums.map((u) => [u._id.toString(), u]));

  return visible
    .map((u) => {
      const doc = groupMap.get(u._id.toString());
      let last_media = null;
      if (doc) {
        const media = umMap.get(String(doc.unique_media_ref)) || {};
        const useCustom = Boolean(doc.use_custom_display) && String(doc.custom_image_url || '').trim();
        const cover_url = useCustom ? doc.custom_image_url : (media.image_url || '');
        if (cover_url && cover_url !== 'N/A') {
          const name =
            useCustom && String(doc.custom_name || '').trim()
              ? doc.custom_name
              : (media.name || '');
          last_media = {
            cover_url,
            name,
            type: media.type || '',
          };
        }
      }
      return {
        user: followingStripUserPayload(u),
        last_media,
      };
    })
    .filter((row) => row.last_media != null);
}

// ── GET /api/aggregate/home ─────────────────────────────────────────────────
// Returns: { feed, suggestions }. Trending and following-strip are omitted here
// (use /api/medias/trending and /api/aggregate/following-strip when needed).
// Only use this endpoint for the initial (no-cursor) page load — subsequent
// "load more" requests should hit /api/posts/feed directly.
router.get('/home', limiter, requireAuth, async (req, res) => {
  const { cursor, limit: limitParam = 20, tag } = req.query;
  const userId = req.user._id;
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  const feedQueryBuilt = buildFeedPostQuery({ cursor, tag });
  if (feedQueryBuilt.error) {
    return res.status(400).json({ error: feedQueryBuilt.error });
  }
  const { query: feedMongoQuery } = feedQueryBuilt;

  try {
    // Feed (not cached — user-specific and cursor-paginated)
    const feedPromise = (async () => {
      const rawPosts = await Post.find(feedMongoQuery)
        .populate('author_id', 'username displayName icon is_admin_badge is_creator_badge role isAdmin is_admin')
        .sort({ created_at: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = rawPosts.length > limit;
      const posts = hasMore ? rawPosts.slice(0, limit) : rawPosts;
      const nextCursor = hasMore ? posts[posts.length - 1].created_at.toISOString() : null;

      return {
        posts: await hydratePosts(posts, userId),
        nextCursor,
        hasMore,
      };
    })();

    const [feedResult, suggestionsResult] = await Promise.allSettled([
      feedPromise,
      fetchSuggestions(userId),
    ]);

    const feed = feedResult.status === 'fulfilled'
      ? feedResult.value
      : { posts: [], nextCursor: null, hasMore: false };

    const suggestions = suggestionsResult.status === 'fulfilled'
      ? suggestionsResult.value
      : [];

    return res.status(200).json({ feed, suggestions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/aggregate/following-strip ────────────────────────────────────
// Fallback when home is loaded without aggregate bundle (e.g. legacy clients).
router.get('/following-strip', limiter, requireAuth, async (req, res) => {
  try {
    const rows = await fetchFollowingFeedStrip(req.user._id);
    return res.status(200).json({ followingFeedStrip: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Cache invalidation helpers (exported for use by follow/unfollow routes) ─
function invalidateSuggestionsCache(userId) {
  suggestionsCache.del(`sug_${userId}`);
}

module.exports = router;
module.exports.invalidateSuggestionsCache = invalidateSuggestionsCache;
