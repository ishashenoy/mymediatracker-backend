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
    const baseUrl = `https://www.giantbomb.com/api/search/?api_key=${process.env.GIANT_BOMB_API_KEY}&format=json&resources=game&query=`
    const {title} = req.params;
    
    const abortCont = new AbortController();

    try{
        const response = await fetch(baseUrl+title, { signal: abortCont.signal });
        if (!response.ok) throw new Error("Failed to fetch");
        const json = await response.json();
        data = json.results;
    } catch (error){
        if (error.name !== "AbortError") {
            return res.status(500).json({error: error});
        }
    }
    abortCont.abort();
    return res.status(200).json(data);
});

module.exports = router;