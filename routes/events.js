const express = require('express');
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const { createEvent } = require('../controllers/eventsController');

const router = express.Router();

const limiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please try again later.' },
});

router.post('/', limiter, requireAuth, createEvent);

module.exports = router;
