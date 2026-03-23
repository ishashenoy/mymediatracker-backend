const express = require('express');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const {
  createPost,
  deletePost,
  getFeedPosts,
  toggleLike,
  toggleRepost,
  toggleBookmark,
  votePoll,
  addComment,
  getComments,
  getSuggestions,
  recordView,
  getBookmarkedPosts,
  getUserPosts,
  toggleCommentLike,
  toggleCommentRepost,
  toggleCommentBookmark,
} = require('../controllers/postController');

const router = express.Router();

const postsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests. Try again later.' },
});

router.use(postsLimiter);
router.use(requireAuth);

// Static routes must come before /:postId to avoid Express treating
// "feed", "suggestions", "bookmarks", and "user" as postId values
router.get('/feed',              getFeedPosts);
router.get('/suggestions',       getSuggestions);
router.get('/bookmarks',         getBookmarkedPosts);
router.get('/user/:username',    getUserPosts);
router.post('/',                 createPost);

router.post('/:postId/like',        toggleLike);
router.post('/:postId/repost',      toggleRepost);
router.post('/:postId/bookmark',    toggleBookmark);
router.post('/:postId/view',        recordView);
router.post('/:postId/poll/vote',   votePoll);
router.post('/:postId/comments',    addComment);
router.get('/:postId/comments',     getComments);
router.delete('/:postId',           deletePost);

router.post('/:postId/comments/:commentId/like',     toggleCommentLike);
router.post('/:postId/comments/:commentId/repost',   toggleCommentRepost);
router.post('/:postId/comments/:commentId/bookmark', toggleCommentBookmark);

module.exports = router;
