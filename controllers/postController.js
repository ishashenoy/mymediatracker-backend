const Post = require('../models/postModel');
const PostInteraction = require('../models/postInteractionModel');
const PollVote = require('../models/pollVoteModel');
const Comment = require('../models/commentModel');
const CommentInteraction = require('../models/commentInteractionModel');
const User = require('../models/userModel');
const List = require('../models/listModel');
const { fireEvent } = require('./eventsController');
const { sanitizeText, sanitizeUrl, sanitizeIdentifier } = require('../utils/sanitize');

// ─── Create Post ────────────────────────────────────────────────────────────

const createPost = async (req, res) => {
  const { body, linked_media, linked_medias, poll, linked_list_id, tag, session_id } = req.body;
  const userId = req.user._id;

  const safeBody = sanitizeText(body, { maxLen: 2000, allowNewlines: true });
  const safeSessionId = session_id ? sanitizeIdentifier(session_id, { maxLen: 80 }) : null;

  const VALID_TAGS = ['review', 'question', 'recommendation', 'discussion', 'rant'];
  if (tag && !VALID_TAGS.includes(tag)) {
    return res.status(400).json({ error: 'Invalid tag.' });
  }

  if (!safeBody || safeBody.length === 0) {
    return res.status(400).json({ error: 'Post body is required.' });
  }
  // length already capped by sanitizer (defense-in-depth)

  // Validate poll if provided
  if (poll) {
    if (!Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 4) {
      return res.status(400).json({ error: 'Poll must have between 2 and 4 options.' });
    }
    for (const opt of poll.options) {
      const safeOpt = sanitizeText(opt, { maxLen: 100, allowNewlines: false });
      if (!safeOpt) {
        return res.status(400).json({ error: 'Poll options cannot be empty.' });
      }
    }
  }

  // Validate linked_list_id if provided
  if (linked_list_id) {
    try {
      const list = await List.findById(linked_list_id).lean();
      if (!list) return res.status(400).json({ error: 'Linked list not found.' });
      if (list.user_id.toString() !== userId.toString()) {
        return res.status(403).json({ error: 'You can only link your own lists.' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid linked_list_id.' });
    }
  }

  try {
    const postData = {
      author_id: userId,
      body: safeBody,
      tag: (tag && VALID_TAGS.includes(tag)) ? tag : null,
    };

    if (linked_media && linked_media.name && linked_media.type) {
      postData.linked_media = {
        unique_media_id: linked_media.unique_media_id || null,
        name: sanitizeText(linked_media.name, { maxLen: 200, allowNewlines: false }),
        image_url: sanitizeUrl(linked_media.image_url),
        type: linked_media.type,
        source: linked_media.source ? sanitizeIdentifier(linked_media.source, { maxLen: 40 }) : null,
        media_id: linked_media.media_id ? sanitizeIdentifier(linked_media.media_id, { maxLen: 120 }) : null,
      };
    }

    if (Array.isArray(linked_medias) && linked_medias.length > 0) {
      if (linked_medias.length > 4) {
        return res.status(400).json({ error: 'Maximum 4 media items allowed.' });
      }
      postData.linked_medias = linked_medias
        .filter(m => m && m.name && m.type)
        .map(m => ({
          unique_media_id: m.unique_media_id || null,
          name: sanitizeText(m.name, { maxLen: 200, allowNewlines: false }),
          image_url: sanitizeUrl(m.image_url),
          type: m.type,
          source: m.source ? sanitizeIdentifier(m.source, { maxLen: 40 }) : null,
          media_id: m.media_id ? sanitizeIdentifier(m.media_id, { maxLen: 120 }) : null,
        }));
    }

    if (poll) {
      postData.poll = {
        options: poll.options.map(t => ({ text: sanitizeText(t, { maxLen: 100, allowNewlines: false }), vote_count: 0 })),
        total_votes: 0,
      };
    }

    if (linked_list_id) {
      postData.linked_list_id = linked_list_id;
    }

    const post = await Post.create(postData);
    await post.populate('author_id', 'username icon');

    // Populate linked list name for response
    let linkedListData = null;
    if (post.linked_list_id) {
      const list = await List.findById(post.linked_list_id).select('name').lean();
      linkedListData = list ? { _id: list._id, name: list.name } : null;
    }

    fireEvent(userId, 'post_create', null, {
      body_length: post.body.length,
      has_media: !!(postData.linked_media || postData.linked_medias?.length),
      has_poll: !!postData.poll,
      has_list: !!postData.linked_list_id,
      session_id: safeSessionId,
    });

    const shaped = shapePost(post, null, linkedListData);
    return res.status(201).json({ post: shaped });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Delete Post ─────────────────────────────────────────────────────────────

const deletePost = async (req, res) => {
  const { postId } = req.params;
  const userId = req.user._id;

  try {
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    if (post.author_id.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    const commentIds = await Comment.find({ post_id: postId }).distinct('_id');
    await CommentInteraction.deleteMany({ comment_id: { $in: commentIds } });
    await Comment.deleteMany({ post_id: postId });
    await PostInteraction.deleteMany({ post_id: postId });
    await PollVote.deleteMany({ post_id: postId });
    await post.deleteOne();

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Get Feed Posts (cursor-based pagination) ───────────────────────────────

const getFeedPosts = async (req, res) => {
  const { cursor, limit: limitParam = 20 } = req.query;
  const userId = req.user._id;
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  try {
    const query = {};
    if (cursor) query.created_at = { $lt: new Date(cursor) };

    const rawPosts = await Post.find(query)
      .populate('author_id', 'username icon')
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rawPosts.length > limit;
    const posts = hasMore ? rawPosts.slice(0, limit) : rawPosts;
    const nextCursor = hasMore ? posts[posts.length - 1].created_at.toISOString() : null;

    return res.status(200).json({
      posts: await hydratePosts(posts, userId),
      nextCursor,
      hasMore,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Get Posts by Linked Media ───────────────────────────────────────────────

const getPostsByMedia = async (req, res) => {
  const { source, media_id, cursor, limit: limitParam = 20 } = req.query;
  const userId = req.user._id;
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  if (!source || !media_id) {
    return res.status(400).json({ error: 'source and media_id are required.' });
  }

  try {
    const query = { 'linked_media.source': source, 'linked_media.media_id': String(media_id) };
    if (cursor) query.created_at = { $lt: new Date(cursor) };

    const rawPosts = await Post.find(query)
      .populate('author_id', 'username icon')
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rawPosts.length > limit;
    const posts = hasMore ? rawPosts.slice(0, limit) : rawPosts;
    const nextCursor = hasMore ? posts[posts.length - 1].created_at.toISOString() : null;

    return res.status(200).json({
      posts: await hydratePosts(posts, userId),
      nextCursor,
      hasMore,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Get Posts by Linked List ─────────────────────────────────────────────────

const getPostsByList = async (req, res) => {
  const { listId } = req.params;
  const { cursor, limit: limitParam = 20 } = req.query;
  const userId = req.user._id;
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  try {
    const query = { linked_list_id: listId };
    if (cursor) query.created_at = { $lt: new Date(cursor) };

    const rawPosts = await Post.find(query)
      .populate('author_id', 'username icon')
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rawPosts.length > limit;
    const posts = hasMore ? rawPosts.slice(0, limit) : rawPosts;
    const nextCursor = hasMore ? posts[posts.length - 1].created_at.toISOString() : null;

    return res.status(200).json({
      posts: await hydratePosts(posts, userId),
      nextCursor,
      hasMore,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Toggle Interaction (like / repost / bookmark) ──────────────────────────

const COUNT_FIELD = { like: 'like_count', repost: 'repost_count', bookmark: 'bookmark_count' };
const PAST_TENSE  = { like: 'liked', repost: 'reposted', bookmark: 'bookmarked' };

async function toggleInteraction(req, res, type) {
  const { postId } = req.params;
  const { feed_position, session_id } = req.body;
  const userId = req.user._id;
  const countField = COUNT_FIELD[type];
  const pastKey = PAST_TENSE[type];

  try {
    const existing = await PostInteraction.findOne({
      user_id: userId,
      post_id: postId,
      interaction_type: type,
    });

    let updatedPost;
    let active;

    if (existing) {
      await existing.deleteOne();
      updatedPost = await Post.findByIdAndUpdate(
        postId,
        { $inc: { [countField]: -1 } },
        { new: true }
      );
      active = false;
    } else {
      await PostInteraction.create({
        user_id: userId,
        post_id: postId,
        interaction_type: type,
        feed_position: feed_position ?? null,
        session_id: session_id || null,
      });
      updatedPost = await Post.findByIdAndUpdate(
        postId,
        { $inc: { [countField]: 1 } },
        { new: true }
      );
      active = true;
      fireEvent(userId, `post_${type}`, null, {
        post_id: postId,
        feed_position: feed_position ?? null,
        session_id: session_id || null,
      });
    }

    if (!updatedPost) return res.status(404).json({ error: 'Post not found.' });

    return res.status(200).json({
      [pastKey]: active,
      [countField]: Math.max(0, updatedPost[countField]),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

const toggleLike     = (req, res) => toggleInteraction(req, res, 'like');
const toggleRepost   = (req, res) => toggleInteraction(req, res, 'repost');
const toggleBookmark = (req, res) => toggleInteraction(req, res, 'bookmark');

// ─── Vote on Poll ─────────────────────────────────────────────────────────────

const votePoll = async (req, res) => {
  const { postId } = req.params;
  const { option_index } = req.body;
  const userId = req.user._id;

  if (option_index === undefined || option_index === null) {
    return res.status(400).json({ error: 'option_index is required.' });
  }

  try {
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    if (!post.poll || !post.poll.options.length) {
      return res.status(400).json({ error: 'This post has no poll.' });
    }
    if (option_index < 0 || option_index >= post.poll.options.length) {
      return res.status(400).json({ error: 'Invalid option_index.' });
    }

    // Check if user already voted
    const existing = await PollVote.findOne({ post_id: postId, user_id: userId });

    if (existing) {
      if (existing.option_index === option_index) {
        // Unvote (toggle off)
        await existing.deleteOne();
        post.poll.options[existing.option_index].vote_count = Math.max(
          0,
          post.poll.options[existing.option_index].vote_count - 1
        );
        post.poll.total_votes = Math.max(0, post.poll.total_votes - 1);
        await post.save();
        return res.status(200).json({
          viewer_vote: null,
          options: post.poll.options,
          total_votes: post.poll.total_votes,
        });
      } else {
        // Change vote
        const prevIdx = existing.option_index;
        existing.option_index = option_index;
        await existing.save();
        post.poll.options[prevIdx].vote_count = Math.max(0, post.poll.options[prevIdx].vote_count - 1);
        post.poll.options[option_index].vote_count += 1;
        await post.save();
        return res.status(200).json({
          viewer_vote: option_index,
          options: post.poll.options,
          total_votes: post.poll.total_votes,
        });
      }
    } else {
      // New vote
      await PollVote.create({ post_id: postId, user_id: userId, option_index });
      post.poll.options[option_index].vote_count += 1;
      post.poll.total_votes += 1;
      await post.save();

      fireEvent(userId, 'post_poll_vote', null, { post_id: postId, option_index });

      return res.status(200).json({
        viewer_vote: option_index,
        options: post.poll.options,
        total_votes: post.poll.total_votes,
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Add Comment ─────────────────────────────────────────────────────────────

const addComment = async (req, res) => {
  const { postId } = req.params;
  const { body, session_id } = req.body;
  const userId = req.user._id;

  const safeBody = sanitizeText(body, { maxLen: 500, allowNewlines: true });
  const safeSessionId = session_id ? sanitizeIdentifier(session_id, { maxLen: 80 }) : null;

  if (!safeBody || safeBody.length === 0) {
    return res.status(400).json({ error: 'Comment body is required.' });
  }
  // length already capped by sanitizer (defense-in-depth)

  try {
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ error: 'Post not found.' });

    const comment = await Comment.create({
      post_id: postId,
      author_id: userId,
      body: safeBody,
    });

    await Post.findByIdAndUpdate(postId, { $inc: { comment_count: 1 } });
    await comment.populate('author_id', 'username icon');

    fireEvent(userId, 'post_comment', null, {
      post_id: postId,
      session_id: safeSessionId,
    });

    return res.status(201).json({
      comment: {
        _id: comment._id,
        body: comment.body,
        created_at: comment.created_at,
        author: comment.author_id,
        like_count: 0,
        repost_count: 0,
        bookmark_count: 0,
        viewer_interactions: { liked: false, reposted: false, bookmarked: false },
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Get Comments (cursor-based, ascending) ───────────────────────────────

const getComments = async (req, res) => {
  const { postId } = req.params;
  const { cursor, limit: limitParam = 20 } = req.query;
  const userId = req.user._id;
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  try {
    const query = { post_id: postId };
    if (cursor) query.created_at = { $gt: new Date(cursor) };

    const rawComments = await Comment.find(query)
      .populate('author_id', 'username icon')
      .sort({ created_at: 1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rawComments.length > limit;
    const comments = hasMore ? rawComments.slice(0, limit) : rawComments;
    const nextCursor = hasMore ? comments[comments.length - 1].created_at.toISOString() : null;

    const commentIds = comments.map(c => c._id);
    const interactions = commentIds.length
      ? await CommentInteraction.find({ user_id: userId, comment_id: { $in: commentIds } }).lean()
      : [];
    const interactionSet = new Set(interactions.map(i => `${i.comment_id}_${i.interaction_type}`));

    const shaped = comments.map(c => ({
      _id: c._id,
      body: c.body,
      created_at: c.created_at,
      author: c.author_id,
      like_count: c.like_count || 0,
      repost_count: c.repost_count || 0,
      bookmark_count: c.bookmark_count || 0,
      viewer_interactions: {
        liked:      interactionSet.has(`${c._id}_like`),
        reposted:   interactionSet.has(`${c._id}_repost`),
        bookmarked: interactionSet.has(`${c._id}_bookmark`),
      },
    }));

    return res.status(200).json({ comments: shaped, nextCursor, hasMore });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Get Bookmarked Posts ─────────────────────────────────────────────────────

const getBookmarkedPosts = async (req, res) => {
  const { cursor, limit: limitParam = 20 } = req.query;
  const userId = req.user._id;
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  try {
    const query = { user_id: userId, interaction_type: 'bookmark' };
    if (cursor) query.created_at = { $lt: new Date(cursor) };

    const rawInteractions = await PostInteraction.find(query)
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rawInteractions.length > limit;
    const interactions = hasMore ? rawInteractions.slice(0, limit) : rawInteractions;
    const nextCursor = hasMore ? interactions[interactions.length - 1].created_at.toISOString() : null;

    const postIds = interactions.map(i => i.post_id);
    const posts = await Post.find({ _id: { $in: postIds } })
      .populate('author_id', 'username icon')
      .lean();

    // Preserve bookmark-date order
    const postMap = new Map(posts.map(p => [p._id.toString(), p]));
    const ordered = postIds
      .map(id => postMap.get(id.toString()))
      .filter(Boolean);

    return res.status(200).json({
      posts: await hydratePosts(ordered, userId),
      nextCursor,
      hasMore,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Get Bookmarked Comments ──────────────────────────────────────────────────

const getBookmarkedComments = async (req, res) => {
  const { cursor, limit: limitParam = 20 } = req.query;
  const userId = req.user._id;
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  try {
    const query = { user_id: userId, interaction_type: 'bookmark' };
    if (cursor) query.created_at = { $lt: new Date(cursor) };

    const rawInteractions = await CommentInteraction.find(query)
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rawInteractions.length > limit;
    const interactions = hasMore ? rawInteractions.slice(0, limit) : rawInteractions;
    const nextCursor = hasMore ? interactions[interactions.length - 1].created_at.toISOString() : null;

    const commentIds = interactions.map(i => i.comment_id);
    const comments = await Comment.find({ _id: { $in: commentIds } })
      .populate('author_id', 'username icon')
      .lean();

    const postIds = [...new Set(comments.map(c => c.post_id.toString()))];
    const posts = await Post.find({ _id: { $in: postIds } }).select('_id body').lean();
    const postMap = new Map(posts.map(p => [p._id.toString(), p]));

    const commentMap = new Map(comments.map(c => [c._id.toString(), c]));
    const ordered = commentIds.map(id => commentMap.get(id.toString())).filter(Boolean);

    const shaped = ordered.map(c => ({
      _id: c._id,
      body: c.body,
      created_at: c.created_at,
      author: c.author_id,
      post: postMap.get(c.post_id.toString()) || { _id: c.post_id },
      like_count: c.like_count || 0,
      repost_count: c.repost_count || 0,
      bookmark_count: c.bookmark_count || 0,
      viewer_interactions: { liked: false, reposted: false, bookmarked: true },
    }));

    return res.status(200).json({ comments: shaped, nextCursor, hasMore });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Get User Posts (own posts + reposts, merged by date) ────────────────────

const getUserPosts = async (req, res) => {
  const { username } = req.params;
  const { cursor, limit: limitParam = 20 } = req.query;
  const viewerId = req.user._id;
  const limit = Math.min(parseInt(limitParam, 10) || 20, 50);

  try {
    const profileUser = await User.findOne({ username }).select('_id username');
    if (!profileUser) return res.status(404).json({ error: 'User not found.' });
    const profileUserId = profileUser._id;

    const dateFilter = cursor ? { $lt: new Date(cursor) } : undefined;

    const ownPostQuery = { author_id: profileUserId };
    if (dateFilter) ownPostQuery.created_at = dateFilter;
    const ownPosts = await Post.find(ownPostQuery)
      .populate('author_id', 'username icon')
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .lean();

    const repostQuery = { user_id: profileUserId, interaction_type: 'repost' };
    if (dateFilter) repostQuery.created_at = dateFilter;
    const repostInteractions = await PostInteraction.find(repostQuery)
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .lean();

    let repostItems = [];
    if (repostInteractions.length > 0) {
      const repostPostIds = repostInteractions.map(i => i.post_id);
      const repostedPosts = await Post.find({ _id: { $in: repostPostIds } })
        .populate('author_id', 'username icon')
        .lean();
      const repostDateMap = new Map(
        repostInteractions.map(i => [i.post_id.toString(), i.created_at])
      );
      repostItems = repostedPosts.map(p => ({
        ...p,
        sort_date: repostDateMap.get(p._id.toString()),
        reposted_by: username,
      }));
    }

    const ownItems = ownPosts.map(p => ({ ...p, sort_date: p.created_at }));
    const merged = [...ownItems, ...repostItems].sort(
      (a, b) => new Date(b.sort_date) - new Date(a.sort_date)
    );

    const hasMore = merged.length > limit;
    const items = hasMore ? merged.slice(0, limit) : merged;
    const nextCursor = hasMore ? new Date(items[items.length - 1].sort_date).toISOString() : null;

    return res.status(200).json({
      posts: await hydratePosts(items, viewerId),
      nextCursor,
      hasMore,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Who to Follow Suggestions ────────────────────────────────────────────

const getSuggestions = async (req, res) => {
  const userId = req.user._id;

  try {
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
      { $project: { username: 1, icon: 1 } },
    ]);

    return res.status(200).json({ suggestions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Shared hydration helper ──────────────────────────────────────────────────
// Enriches a raw posts array with:
//  - viewer_interactions (liked/reposted/bookmarked)
//  - viewer_poll_vote (option_index or null)
//  - linked_list (name + _id populated from List, if any)

async function hydratePosts(posts, userId) {
  if (!posts.length) return [];

  const postIds = posts.map(p => p._id);

  // ── 1. Viewer interactions in one query
  const interactions = await PostInteraction.find({
    user_id: userId,
    post_id: { $in: postIds },
  }).lean();
  const interactionSet = new Set(interactions.map(i => `${i.post_id}_${i.interaction_type}`));

  // ── 2. Poll votes for posts that have polls
  const pollPostIds = posts.filter(p => p.poll && p.poll.options && p.poll.options.length).map(p => p._id);
  const pollVotes = pollPostIds.length
    ? await PollVote.find({ post_id: { $in: pollPostIds }, user_id: userId }).lean()
    : [];
  const pollVoteMap = new Map(pollVotes.map(v => [v.post_id.toString(), v.option_index]));

  // ── 3. Linked lists in one query
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

// ─── Delete Comment ──────────────────────────────────────────────────────────

const deleteComment = async (req, res) => {
  const { postId, commentId } = req.params;
  const userId = req.user._id;

  try {
    const comment = await Comment.findById(commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    if (String(comment.author_id) !== String(userId)) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    await CommentInteraction.deleteMany({ comment_id: commentId });
    await Comment.findByIdAndDelete(commentId);
    await Post.findByIdAndUpdate(postId, { $inc: { comment_count: -1 } });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── Toggle Comment Interaction (like / repost / bookmark) ──────────────────

const COMMENT_COUNT_FIELD = { like: 'like_count', repost: 'repost_count', bookmark: 'bookmark_count' };
const COMMENT_PAST_TENSE  = { like: 'liked', repost: 'reposted', bookmark: 'bookmarked' };

async function toggleCommentInteraction(req, res, type) {
  const { commentId } = req.params;
  const userId = req.user._id;
  const countField = COMMENT_COUNT_FIELD[type];
  const pastKey = COMMENT_PAST_TENSE[type];

  try {
    const existing = await CommentInteraction.findOne({
      user_id: userId,
      comment_id: commentId,
      interaction_type: type,
    });

    let updatedComment;
    let active;

    if (existing) {
      await existing.deleteOne();
      updatedComment = await Comment.findByIdAndUpdate(
        commentId,
        { $inc: { [countField]: -1 } },
        { new: true }
      );
      active = false;
    } else {
      await CommentInteraction.create({ user_id: userId, comment_id: commentId, interaction_type: type });
      updatedComment = await Comment.findByIdAndUpdate(
        commentId,
        { $inc: { [countField]: 1 } },
        { new: true }
      );
      active = true;
    }

    if (!updatedComment) return res.status(404).json({ error: 'Comment not found.' });

    return res.status(200).json({
      [pastKey]: active,
      [countField]: Math.max(0, updatedComment[countField] || 0),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

const toggleCommentLike     = (req, res) => toggleCommentInteraction(req, res, 'like');
const toggleCommentRepost   = (req, res) => toggleCommentInteraction(req, res, 'repost');
const toggleCommentBookmark = (req, res) => toggleCommentInteraction(req, res, 'bookmark');

// ─── Shape helper (used only on freshly-created post) ────────────────────────

function shapePost(post, viewerInteractions, linkedList) {
  const obj = post.toObject ? post.toObject() : post;
  return {
    _id: obj._id,
    body: obj.body,
    tag: obj.tag || null,
    linked_media: obj.linked_media || null,
    linked_medias: obj.linked_medias?.length ? obj.linked_medias : [],
    poll: obj.poll || null,
    linked_list: linkedList || null,
    like_count:      obj.like_count,
    comment_count:   obj.comment_count,
    repost_count:    obj.repost_count,
    bookmark_count:  obj.bookmark_count,
    view_count:      obj.view_count,
    created_at:      obj.created_at,
    author:          obj.author_id,
    viewer_interactions: viewerInteractions || { liked: false, reposted: false, bookmarked: false },
    viewer_poll_vote: null,
  };
}

module.exports = {
  createPost,
  deletePost,
  getFeedPosts,
  getPostsByMedia,
  getPostsByList,
  toggleLike,
  toggleRepost,
  toggleBookmark,
  votePoll,
  addComment,
  getComments,
  getSuggestions,
  getBookmarkedPosts,
  getBookmarkedComments,
  getUserPosts,
  toggleCommentLike,
  toggleCommentRepost,
  toggleCommentBookmark,
  deleteComment,
};
