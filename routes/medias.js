const express = require('express');
const {
    createMedia,
    getMedias,
    getProfileMedia,
    deleteMedia,
    updateMedia
} = require('../controllers/mediaController')
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

//require auth for all media routes
router.use(requireAuth);

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
