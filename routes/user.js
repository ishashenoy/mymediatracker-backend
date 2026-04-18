const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const multer = require('multer');
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 200, // 100 requests per window
  message: "Too many requests. Try again later."
});

const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 requests per window
  message: "Too many requests. Try again later."
});

const passResetLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3, // 3 requests per window
  message: "Too many requests. Try again later."
});

//controller functions
const {signupUser, loginUser, followRequest, unfollowRequest, changePrivacy, changeIcon, changeBanner, getConnections, getIcon, getUserProfile, getMediaActivityHeatmap, getStarReceipt, searchUsers, sendPasswordResetEmail, resetPassword, updateOnboarding, updateBio, updateSocialLinks, submitFeedback, requestAccountDeletion, cancelAccountDeletion} = require('../controllers/userController');
const { getUserPosts } = require('../controllers/postController');

const router = express.Router();

// login route
router.post('/login', authLimiter, loginUser);

// signup route
router.post('/signup', authLimiter, signupUser);

// Search users (must be before /:username routes to avoid shadowing)
router.get('/search', limiter, requireAuth, searchUsers);

// Feedback / suggestions (authenticated)
router.post('/feedback', limiter, requireAuth, submitFeedback);

// follow request route
// the username is of the receiving user
router.patch('/:username/follow', limiter, requireAuth, followRequest);

// unfollow request route
// the username is of the receiving user
router.patch('/:username/unfollow', limiter, requireAuth, unfollowRequest);

// change privacy
router.patch('/:username/privacy', limiter, requireAuth, changePrivacy);

// update profile bio
router.patch('/:username/bio', limiter, requireAuth, updateBio);

// social profile links (Instagram / X / TikTok)
router.patch('/:username/social-links', limiter, requireAuth, updateSocialLinks);

// upload icon
router.post('/:username/icon', limiter, requireAuth, upload.single('image'), changeIcon);
router.post('/:username/banner', limiter, requireAuth, upload.single('image'), changeBanner);

// get connections list
router.get('/:username/connections', limiter, requireAuth, getConnections);

// get user profile (public view, but enhanced data for authenticated users)
router.get('/:username/profile', limiter, getUserProfile);

// profile contributions heat map (follows same visibility as profile lists)
router.get('/:username/media-activity', limiter, getMediaActivityHeatmap);

// Top-rated "star receipt" (same visibility as profile library)
router.get('/:username/star-receipt', limiter, getStarReceipt);

// get user posts + reposts
router.get('/:username/posts', limiter, requireAuth, getUserPosts);

//This route below can be seen without having an account
// get icon
router.get('/:username/icon', limiter, getIcon);

// This route is for password recovery - sending the email
router.post('/forgot-password', passResetLimiter, sendPasswordResetEmail);

// This route is for password recovery - resetting the password
router.post('/reset-password/:token', passResetLimiter, resetPassword);

// Save onboarding selections
router.patch('/:username/onboarding', limiter, requireAuth, updateOnboarding);

// Account deletion (grace period + password confirmation)
router.post('/:username/request-account-deletion', limiter, requireAuth, requestAccountDeletion);
router.post('/:username/cancel-account-deletion', limiter, requireAuth, cancelAccountDeletion);

module.exports = router;