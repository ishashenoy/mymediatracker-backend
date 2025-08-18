const express = require('express');
const {
    createMedia,
    getMedias,
    getProfileMedia,
    deleteMedia,
    updateMedia
} = require('../controllers/mediaController')
const requireAuth = require('../middleware/requireAuth');
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 200, // 200 requests per window
  message: "Too many requests. Try again later."
});

const router = express.Router();

//require auth for all media routes
router.use(requireAuth);
router.use(limiter);

//GET all media
router.get('/', getMedias);

//GET all media from a profile
router.get('/:username', getProfileMedia);

//POST a new media
router.post('/', createMedia);

//DELETE a media
router.delete('/:id', deleteMedia);

//UPDATE a media
router.patch('/:id', updateMedia);

module.exports = router;
