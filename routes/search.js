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
router.get('/games/:title', requireAuth, async function (req, res) {
    const { title } = req.params;
    const baseUrl = `https://api.rawg.io/api/games?key=${process.env.RAWG_API_KEY}&search=${encodeURIComponent(title)}`;

    const abortCont = new AbortController();

    try {
        const response = await fetch(baseUrl, { signal: abortCont.signal });
        if (!response.ok) throw new Error("Failed to fetch");
        const json = await response.json();
        const data = json.results || [];
        return res.status(200).json(data);
    } catch (error) {
        if (error.name !== "AbortError") {
            return res.status(500).json({ error: error.message || "Failed to fetch games" });
        }
    }
    return res.status(500).json({ error: "Request aborted" });
});

// Fetching details for a specific video game
router.get('/games/details/:id', requireAuth, async function (req, res) {
    const { id } = req.params;
    const baseUrl = `https://api.rawg.io/api/games/${id}?key=${process.env.RAWG_API_KEY}`;

    try {
        const response = await fetch(baseUrl);
        if (!response.ok) throw new Error("Failed to fetch game details");
        const json = await response.json();
        return res.status(200).json(json);
    } catch (error) {
        return res.status(500).json({ error: error.message || "Failed to fetch game details" });
    }
});

// // Searching for movies via TMDB
// router.get('/movies/:title', requireAuth, async function(req, res){
//     const {title} = req.params;
//     const baseUrl = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(title)}`;

//     const abortCont = new AbortController();

//     try{
//         const response = await fetch(baseUrl, { signal: abortCont.signal });
//         if (!response.ok) throw new Error("Failed to fetch movies");
//         const json = await response.json();
//         const data = json.results || [];
//         return res.status(200).json(data);
//     } catch (error){
//         if (error.name !== "AbortError") {
//             return res.status(500).json({error: error.message || "Failed to fetch movies"});
//         }
//     }
//     return res.status(500).json({error: "Request aborted"});
// });

// // Fetching details for a specific TMDB movie
// router.get('/movies/details/:id', requireAuth, async function(req, res){
//     const {id} = req.params;
//     const baseUrl = `https://api.themoviedb.org/3/movie/${id}?api_key=${process.env.TMDB_API_KEY}`;

//     try{
//         const response = await fetch(baseUrl);
//         if (!response.ok) throw new Error("Failed to fetch movie details");
//         const json = await response.json();
//         return res.status(200).json(json);
//     } catch (error){
//         return res.status(500).json({error: error.message || "Failed to fetch movie details"});
//     }
// });

// // Fetching details for a specific justwatch movie
// router.get('/justwatch/details/:id', requireAuth, async function(req, res){
//     const {id} = req.params;
//     const baseUrl = `https://imdb.iamidiotareyoutoo.com/justwatch?id=${id}`;

//     try{
//         const response = await fetch(baseUrl);
//         if (!response.ok) throw new Error("Failed to fetch justwatch movie details");
//         const json = await response.json();
//         return res.status(200).json(json);
//     } catch (error){
//         return res.status(500).json({error: error.message || "Failed to fetch justwatch movie details"});
//     }
// });

module.exports = router;