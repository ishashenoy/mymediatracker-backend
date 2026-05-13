const express = require('express');
const rateLimit = require('express-rate-limit');
const duplicateReviewEnabled = require('../middleware/duplicateReviewEnabled');
const {
  listDuplicateGroups,
  getDuplicateGroupItems,
  previewMerge,
  applyMerge,
} = require('../controllers/duplicateReviewController');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: 'Too many requests. Try again later.',
});

const LOCAL_ORIGINS = new Set([
  'http://localhost:3001',
  'http://localhost:4173',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);

function requireLocalToolAccess(req, res, next) {
  const origin = req.get('origin');
  const host = String(req.get('host') || '').toLowerCase();

  if (origin) {
    return LOCAL_ORIGINS.has(origin)
      ? next()
      : res.status(403).json({ error: 'Duplicate review is limited to local use.' });
  }

  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    return next();
  }

  return res.status(403).json({ error: 'Duplicate review is limited to local use.' });
}

const router = express.Router();

router.use(duplicateReviewEnabled);
router.use(requireLocalToolAccess);
router.use(limiter);

router.get('/groups', listDuplicateGroups);
router.get('/groups/:type/:normalizedName/items', getDuplicateGroupItems);
router.post('/merge/preview', previewMerge);
router.post('/merge/apply', applyMerge);

module.exports = router;
