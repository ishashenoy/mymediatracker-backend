const express = require('express');
const {
    createMedia,
    getMedias,
    getProfileMedia,
    getTrendingMedia,
    deleteMedia,
    updateMedia,
    importMedia,
    uploadCover
} = require('../controllers/mediaController')
const requireAuth = require('../middleware/requireAuth');
const rateLimit = require('express-rate-limit');

const multer = require('multer');
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 200, // 200 requests per window
  message: "Too many requests. Try again later."
});

const router = express.Router();

router.use(limiter);

// GET the top 30 medias.
router.get('/trending', getTrendingMedia);

//GET all media from a profile
// For this route, you do not need to have an account
router.get('/:username', getProfileMedia);

//require auth for all media routes
router.use(requireAuth);

//GET all media
router.get('/', getMedias);

//POST a new media
router.post('/', createMedia);

//DELETE a media
router.delete('/:id', deleteMedia);

//UPDATE a media
router.patch('/:id', updateMedia);

// IMPORT (POST) media(s) from other website
router.post('/import/:source', importMedia);

// upload a media cover
router.post('/image', limiter, requireAuth, upload.single('image'), uploadCover);

module.exports = router;
