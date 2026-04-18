const express = require('express');
const multer = require('multer');
const {
    createMedia,
    uploadMediaImage,
    getMedias,
    getMyEntryByLookup,
    getTrendingMedia,
    deleteMedia,
    updateMedia,
    importMedia,
    suggestMediaMatches
} = require('../controllers/mediaController')
const requireAuth = require('../middleware/requireAuth');
const maintenanceMode = require('../middleware/maintenanceMode');
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 200, // 200 requests per window
  message: "Too many requests. Try again later."
});

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!file?.mimetype?.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    return cb(null, true);
  },
});

router.use(limiter);

// GET the top 30 medias.
router.get('/trending', getTrendingMedia);

// suggest media matches (global search, no auth required)
router.get('/matches', suggestMediaMatches);

//require auth for all media routes
router.use(requireAuth);

// Search the authenticated user's own media library by name
// Returns lightweight results suitable for the post composer attachment picker
router.get('/my-library', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const userId = req.user._id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 20);

  if (!q) return res.status(200).json({ results: [] });

  try {
    const UserMedia = require('../models/userMediaModel');
    const UniqueMedia = require('../models/uniqueMediaModel');

    function escapeRegex(str) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Two-step: find matching UniqueMedia, then intersect with user's library
    const regex = new RegExp(escapeRegex(q), 'i');
    const matchingMedia = await UniqueMedia.find({ name: regex })
      .select('_id name image_url type source media_id')
      .limit(100)
      .lean();

    if (!matchingMedia.length) return res.status(200).json({ results: [] });

    const uniqueMediaIds = matchingMedia.map(m => m._id);
    const userMedias = await UserMedia.find({
      user_id: userId,
      unique_media_ref: { $in: uniqueMediaIds },
    })
      .select('_id unique_media_ref use_custom_display custom_name custom_image_url rating')
      .limit(limit)
      .lean();

    const mediaMap = new Map(matchingMedia.map(m => [m._id.toString(), m]));
    const results = userMedias.map(um => {
      const media = mediaMap.get(um.unique_media_ref.toString());
      if (!media) return null;
      return {
        user_media_id: um._id,
        unique_media_id: media._id,
        name: um.use_custom_display && um.custom_name ? um.custom_name : media.name,
        image_url: um.use_custom_display && um.custom_image_url ? um.custom_image_url : media.image_url,
        type: media.type,
        source: media.source,
        media_id: media.media_id,
        rating: um.rating ?? null,
      };
    }).filter(Boolean);

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Current user's library entry for a given external title (auth-only; returns null if not in library)
router.get('/mine-by-lookup', getMyEntryByLookup);

//GET all media
router.get('/', getMedias);

//POST a new media
router.post('/', maintenanceMode, createMedia);

// Upload a custom media cover image
router.post('/upload-image', maintenanceMode, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image too large. Max size is 5MB.' });
      }
      return res.status(400).json({ error: err.message || 'Invalid image upload.' });
    }
    return next();
  });
}, uploadMediaImage);

//DELETE a media
router.delete('/:id', maintenanceMode, deleteMedia);

//UPDATE a media
router.patch('/:id', maintenanceMode, updateMedia);

// IMPORT (POST) media(s) from other website
router.post('/import/:source', maintenanceMode, importMedia);

module.exports = router;
