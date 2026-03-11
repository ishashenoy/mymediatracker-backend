const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { getFeed } = require('../controllers/feedController');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const feedLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  message: "Too many feed requests. Try again later."
});

router.use(feedLimiter);
router.use(requireAuth);

router.get('/', getFeed);

module.exports = router;