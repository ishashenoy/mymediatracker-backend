const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const maintenanceMode = require('../middleware/maintenanceMode');
const {
  listMediaRequests,
  getMediaRequestById,
  createMediaRequest,
  updateMediaRequest,
  uploadMediaRequestCover,
  approveMediaRequest,
  rejectMediaRequest,
  patchMediaRequestAdminComment,
} = require('../controllers/mediaRequestController');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  message: 'Too many requests. Try again later.',
});

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

const router = express.Router();

router.use(limiter);
router.use(requireAuth);

router.get('/', listMediaRequests);
router.get('/:id', getMediaRequestById);
router.post('/', maintenanceMode, createMediaRequest);

router.post('/:id/cover', maintenanceMode, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image too large. Max size is 5MB.' });
      }
      return res.status(400).json({ error: err.message || 'Invalid image upload.' });
    }
    return next();
  });
}, uploadMediaRequestCover);

router.post('/:id/approve', requireAdmin, approveMediaRequest);
router.post('/:id/reject', requireAdmin, rejectMediaRequest);

router.patch('/:id/admin-comment', requireAdmin, patchMediaRequestAdminComment);

router.patch('/:id', maintenanceMode, updateMediaRequest);

module.exports = router;
