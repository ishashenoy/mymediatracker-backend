const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const multer = require('multer');
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

//controller functions
const {signupUser, loginUser, followRequest, unfollowRequest, changePrivacy, changeIcon, getFollowers, getFollowing, getIcon} = require('../controllers/userController');

const router = express.Router();

// login route
router.post('/login', loginUser);

// signup route
router.post('/signup', signupUser);

// follow request route
// the username is of the receiving user
router.patch('/follow/:username', requireAuth, followRequest);

// unfollow request route
// the username is of the receiving user
router.patch('/unfollow/:username', requireAuth, unfollowRequest);

// change privacy
router.patch('/:username/privacy', requireAuth, changePrivacy);

// change icon
router.post('/:username/process-icon', requireAuth, upload.single('image'), changeIcon);

// get followers list
router.get('/followers/:username', getFollowers);

// get following list
router.get('/following/:username', getFollowing);

// get icon
router.get('/icon/:username', getIcon);

module.exports = router;