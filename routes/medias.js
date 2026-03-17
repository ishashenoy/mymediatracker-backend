const express = require('express');
const {
    createMedia,
    getMedias,
    getTrendingMedia,
    deleteMedia,
    updateMedia,
    importMedia,
    uploadCover,
    suggestMediaMatches
} = require('../controllers/mediaController')
const requireAuth = require('../middleware/requireAuth');
const maintenanceMode = require('../middleware/maintenanceMode');
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

// suggest media matches (global search, no auth required)
router.get('/matches', suggestMediaMatches);

//require auth for all media routes
router.use(requireAuth);

//GET all media
router.get('/', getMedias);

//POST a new media
router.post('/', maintenanceMode, createMedia);

//DELETE a media
router.delete('/:id', maintenanceMode, deleteMedia);

//UPDATE a media
router.patch('/:id', maintenanceMode, updateMedia);

// IMPORT (POST) media(s) from other website
router.post('/import/:source', maintenanceMode, importMedia);

// upload a media cover
router.post('/image', limiter, requireAuth, maintenanceMode, upload.single('image'), uploadCover);

module.exports = router;
