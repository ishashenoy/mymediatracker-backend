const express = require('express');
const router = express.Router();
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');

const Post = require('../models/postModel');
const PostInteraction = require('../models/postInteractionModel');
const PollVote = require('../models/pollVoteModel');
const UserMedia = require('../models/userMediaModel');
const User = require('../models/userModel');
const List = require('../models/listModel');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests. Try again later.' },
});

// Suggestions cached per user (5 minutes) — invalidated on follow/unfollow
const suggestionsCache = new NodeCache({ stdTTL: 300 });

// Trending cached globally (24 hours) — same strategy as mediaController
const trendingCache = new NodeCache({ stdTTL: 86400 });

// ── Hydration helper (mirrors postController.hydratePosts) ──────────────────
async function hydratePosts(posts, userId) {
  if (!posts.length) return [];

  const postIds = posts.map(p => p._id);

  const interactions = await PostInteraction.find({
    user_id: userId,
    post_id: { $in: postIds },
  }).lean();
  const interactionSet = new Set(interactions.map(i => `${i.post_id}_${i.interaction_type}`));

  const pollPostIds = posts.filter(p => p.poll && p.poll.options?.length).map(p => p._id);
  const pollVotes = pollPostIds.length
    ? await PollVote.find({ post_id: { $in: pollPostIds }, user_id: userId }).lean()
    : [];
  const pollVoteMap = new Map(pollVotes.map(v => [v.post_id.toString(), v.option_index]));

  const listIds = posts.map(p => p.linked_list_id).filter(Boolean);
  const lists = listIds.length
    ? await List.find({ _id: { $in: listIds } }).select('_id name').lean()
    : [];
  const listMap = new Map(lists.map(l => [l._id.toString(), l]));

  return posts.map(p => ({
    ...p,
    author: p.author_id,
    viewer_interactions: {
      liked:      interactionSet.has(`${p._id}_like`),
      reposted:   interactionSet.has(`${p._id}_repost`),
      bookmarked: interactionSet.has(`${p._id}_bookmark`),
    },
    viewer_poll_vote: pollVoteMap.has(p._id.toString())
      ? pollVoteMap.get(p._id.toString())
      : null,
    linked_list: p.linked_list_id
      ? (listMap.get(p.linked_list_id.toString()) || null)
      : null,
  }));
}

// ── Sidebar helper: suggestions + trending in parallel ──────────────────────
async function fetchSidebarData(userId) {
  const [suggestionsResult, trendingResult] = await Promise.allSettled([

    // Who-to-follow suggestions (cached per user for 5 min)
    (async () => {
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
        { $project: { username: 1, icon: 1, is_creator_badge: { $eq: ['$is_creator_badge', true] } } },
      ]);

      suggestionsCache.set(key, suggestions);
      return suggestions;
    })(),

    // Trending media (cached globally for 24 h)
    (async () => {
      const cached = trendingCache.get('trending');
      if (cached) return cached;

      const result = await UserMedia.aggregate([
        { $group: { _id: '$unique_media_ref', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 15 },
        {
          $lookup: {
            from: 'uniquemedias',
            localField: '_id',
            foreignField: '_id',
            as: 'media',
          },
        },
        { $unwind: '$media' },
        {
          $project: {
            _id: 0,
            name: '$media.name',
            type: '$media.type',
            media_id: '$media.media_id',
            source: '$media.source',
            count: 1,
            sampleDoc: {
              _id: '$media._id',
              name: '$media.name',
              type: '$media.type',
              image_url: '$media.image_url',
              media_id: '$media.media_id',
              source: '$media.source',
              score: '$media.score',
            },
          },
        },
      ]);

      trendingCache.set('trending', result);
      return result;
    })(),
  ]);

  return {
    suggestions: suggestionsResult.status === 'fulfilled' ? suggestionsResult.value : [],
    trending:    trendingResult.status  === 'fulfilled' ? trendingResult.value    : [],
  };
}

// ── GET /api/aggregate/home ─────────────────────────────────────────────────
// Returns: { feed: { posts, nextCursor, hasMore }, suggestions, trending }
// Runs feed + sidebar queries in parallel; sidebar results are cached.
// Only use this endpoint for the initial (no-cursor) page load — subsequent
// "load more" requests should hit /api/posts/feed directly.
router.get('/home', limiter, requireAuth, async (req, res) => {
  const { cursor, limit: limitParam = 20 } = req.query;
  const userId = req.user._id;
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  try {
    // Feed (not cached — user-specific and cursor-paginated)
    const feedPromise = (async () => {
      const query = {};
      if (cursor) query.created_at = { $lt: new Date(cursor) };

      const rawPosts = await Post.find(query)
        .populate('author_id', 'username icon is_creator_badge')
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

    const [feedResult, sidebarResult] = await Promise.allSettled([
      feedPromise,
      fetchSidebarData(userId),
    ]);

    const feed = feedResult.status === 'fulfilled'
      ? feedResult.value
      : { posts: [], nextCursor: null, hasMore: false };

    const { suggestions, trending } = sidebarResult.status === 'fulfilled'
      ? sidebarResult.value
      : { suggestions: [], trending: [] };

    return res.status(200).json({ feed, suggestions, trending });
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
