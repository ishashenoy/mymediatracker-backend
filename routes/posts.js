const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const requireAuth = require('../middleware/requireAuth');
const {
  uploadPostImage,
  createPost,
  deletePost,
  getFeedPosts,
  getPostById,
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
} = require('../controllers/postController');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file?.mimetype?.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    return cb(null, true);
  },
});

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
router.get('/bookmarks/comments', getBookmarkedComments);
router.get('/user/:username',    getUserPosts);
router.get('/by-media',          getPostsByMedia);
router.get('/by-list/:listId',   getPostsByList);
router.post('/upload-image',    upload.single('image'), uploadPostImage);
router.post('/',                 createPost);

router.post('/:postId/like',        toggleLike);
router.post('/:postId/repost',      toggleRepost);
router.post('/:postId/bookmark',    toggleBookmark);
router.post('/:postId/poll/vote',   votePoll);
router.post('/:postId/comments',    addComment);
router.get('/:postId/comments',     getComments);
router.get('/:postId',              getPostById);
router.delete('/:postId',           deletePost);

router.post('/:postId/comments/:commentId/like',     toggleCommentLike);
router.post('/:postId/comments/:commentId/repost',   toggleCommentRepost);
router.post('/:postId/comments/:commentId/bookmark', toggleCommentBookmark);
router.delete('/:postId/comments/:commentId',        deleteComment);

module.exports = router;
