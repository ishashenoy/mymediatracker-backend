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
const {signupUser, loginUser, followRequest, unfollowRequest, changePrivacy, changeIcon, changeBanner, getConnections, getIcon, getBanner, searchUsers, sendPasswordResetEmail, resetPassword} = require('../controllers/userController');

const router = express.Router();

// login route
router.post('/login', authLimiter, loginUser);

// signup route
router.post('/signup', authLimiter, signupUser);

// Search users (must be before /:username routes to avoid shadowing)
router.get('/search', limiter, requireAuth, searchUsers);

// follow request route
// the username is of the receiving user
router.patch('/:username/follow', limiter, requireAuth, followRequest);

// get banners
router.get('/banners', limiter, requireAuth, getBanner);

// unfollow request route
// the username is of the receiving user
router.patch('/:username/unfollow', limiter, requireAuth, unfollowRequest);

// change privacy
router.patch('/:username/privacy', limiter, requireAuth, changePrivacy);

// upload banner
router.post('/banners/:type_number', limiter, requireAuth, upload.single('image'), changeBanner);

// upload icon
router.post('/:username/icon', limiter, requireAuth, upload.single('image'), changeIcon);

// get connections list
router.get('/:username/connections', limiter, requireAuth, getConnections);

//This route below can be seen without having an account
// get icon
router.get('/:username/icon', limiter, getIcon);

// This route is for password recovery - sending the email
router.post('/forgot-password', passResetLimiter, sendPasswordResetEmail);

// This route is for password recovery - resetting the password
router.post('/reset-password/:token', passResetLimiter, resetPassword);

module.exports = router;