const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const router = express.Router();

const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 100, // 100 requests per window
  message: "Too many requests. Try again later."
});

router.use(limiter);

// Searching for video games
router.get('/games/:title', requireAuth, async function(req, res){
    const {title} = req.params;
    const baseUrl = `https://api.rawg.io/api/games?key=${process.env.RAWG_API_KEY}&search=${encodeURIComponent(title)}`;
    
    const abortCont = new AbortController();

    try{
        const response = await fetch(baseUrl, { signal: abortCont.signal });
        if (!response.ok) throw new Error("Failed to fetch");
        const json = await response.json();
        const data = json.results || [];
        return res.status(200).json(data);
    } catch (error){
        if (error.name !== "AbortError") {
            return res.status(500).json({error: error.message || "Failed to fetch games"});
        }
    }
    return res.status(500).json({error: "Request aborted"});
});

module.exports = router;