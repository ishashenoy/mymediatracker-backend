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

// Unified search across all media types - sorted by title relevance
router.get('/all/:title', requireAuth, async function(req, res) {
    const { title } = req.params;
    const searchQuery = title.toLowerCase().trim();
    const abortCont = new AbortController();
    const timeout = setTimeout(() => abortCont.abort(), 10000); // 10s timeout

    // Helper function to calculate relevance score
    const getRelevanceScore = (itemTitle, searchQuery) => {
        if (!itemTitle) return 0;
        const normalizedTitle = itemTitle.toLowerCase().trim();
        
        // Exact match gets highest score
        if (normalizedTitle === searchQuery) return 100;
        
        // Starts with query gets high score
        if (normalizedTitle.startsWith(searchQuery)) return 80;
        
        // Contains query as whole word gets good score
        const wordRegex = new RegExp(`\\b${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (wordRegex.test(normalizedTitle)) return 60;
        
        // Contains query anywhere gets lower score
        if (normalizedTitle.includes(searchQuery)) return 40;
        
        // Partial word match gets lowest score
        return 20;
    };

    try {
        // Fetch from all APIs in parallel
        const [animeRes, mangaRes, tvRes, movieRes, bookRes, gameRes] = await Promise.allSettled([
            // Anime (Jikan)
            fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&sfw=true&limit=20`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { data: [] })
                .then(j => j.data || []),
            
            // Manga (Jikan)
            fetch(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(title)}&limit=20`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { data: [] })
                .then(j => j.data || []),
            
            // TV Shows (TVmaze)
            fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : [])
                .then(data => data.map(item => item.show)),
            
            // Movies (TMDB)
            fetch(`https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(title)}&api_key=${process.env.TMDB_API_KEY}`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { results: [] })
                .then(j => j.results || []),
            
            // Books (Google Books)
            fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(title)}&key=${process.env.GOOGLE_BOOKS_API_KEY}&maxResults=20`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { items: [] })
                .then(j => j.items || []),
            
            // Games (RAWG)
            fetch(`https://api.rawg.io/api/games?key=${process.env.RAWG_API_KEY}&search=${encodeURIComponent(title)}&page_size=20`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { results: [] })
                .then(j => j.results || [])
        ]);

        clearTimeout(timeout);

        // Normalize and combine all results with relevance scoring
        const allResults = [];

        // Anime results
        if (animeRes.status === 'fulfilled' && animeRes.value) {
            animeRes.value.forEach(item => {
                const name = item.title_english || item.title || '';
                allResults.push({
                    id: item.mal_id?.toString() || '',
                    name: name,
                    image_url: item.images?.jpg?.image_url || item.images?.webp?.image_url || null,
                    type: 'anime',
                    source: 'mal',
                    relevance: getRelevanceScore(name, searchQuery),
                    raw: item
                });
            });
        }

        // Manga results
        if (mangaRes.status === 'fulfilled' && mangaRes.value) {
            mangaRes.value.forEach(item => {
                const name = item.title_english || item.title || '';
                allResults.push({
                    id: item.mal_id?.toString() || '',
                    name: name,
                    image_url: item.images?.jpg?.image_url || item.images?.webp?.image_url || null,
                    type: 'manga',
                    source: 'mal',
                    relevance: getRelevanceScore(name, searchQuery),
                    raw: item
                });
            });
        }

        // TV results
        if (tvRes.status === 'fulfilled' && tvRes.value) {
            tvRes.value.forEach(item => {
                if (!item) return;
                const name = item.name || '';
                allResults.push({
                    id: item.id?.toString() || '',
                    name: name,
                    image_url: item.image?.medium || item.image?.original || null,
                    type: 'tv',
                    source: 'tvmaze',
                    relevance: getRelevanceScore(name, searchQuery),
                    raw: item
                });
            });
        }

        // Movie results
        if (movieRes.status === 'fulfilled' && movieRes.value) {
            movieRes.value.forEach(item => {
                const name = item.title || '';
                const imageUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
                allResults.push({
                    id: item.id?.toString() || '',
                    name: name,
                    image_url: imageUrl,
                    type: 'movie',
                    source: 'tmdb',
                    relevance: getRelevanceScore(name, searchQuery),
                    raw: item
                });
            });
        }

        // Book results
        if (bookRes.status === 'fulfilled' && bookRes.value) {
            bookRes.value.forEach(item => {
                const name = item.volumeInfo?.title || '';
                const imageUrl = item.volumeInfo?.imageLinks?.thumbnail?.replace('http://', 'https://') || null;
                allResults.push({
                    id: item.id || '',
                    name: name,
                    image_url: imageUrl,
                    type: 'book',
                    source: 'googlebooks',
                    relevance: getRelevanceScore(name, searchQuery),
                    raw: item
                });
            });
        }

        // Game results
        if (gameRes.status === 'fulfilled' && gameRes.value) {
            gameRes.value.forEach(item => {
                const name = item.name || '';
                allResults.push({
                    id: item.id?.toString() || '',
                    name: name,
                    image_url: item.background_image || null,
                    type: 'game',
                    source: 'rawg',
                    relevance: getRelevanceScore(name, searchQuery),
                    raw: item
                });
            });
        }

        // Sort by relevance score (descending), then by name (ascending) for same scores
        allResults.sort((a, b) => {
            if (b.relevance !== a.relevance) {
                return b.relevance - a.relevance;
            }
            return a.name.localeCompare(b.name);
        });

        // Limit total results
        const limitedResults = allResults.slice(0, 50);

        return res.status(200).json({
            query: title,
            total: limitedResults.length,
            results: limitedResults
        });

    } catch (error) {
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: 'Search request timed out' });
        }
        return res.status(500).json({ error: error.message || 'Failed to perform unified search' });
    }
});

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

// Searching for movies via TMDB
router.get('/movies/:title', requireAuth, async function(req, res){
    const {title} = req.params;
    const baseUrl = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(title)}&api_key=${process.env.TMDB_API_KEY}`;

    const abortCont = new AbortController();

    try{
        const response = await fetch(baseUrl, {
            signal: abortCont.signal,
            headers: { 'accept': 'application/json' }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`TMDB API error: ${response.status} - ${errorText}`);
        }

        const json = await response.json();
        const data = json.results || [];
        return res.status(200).json(data);
    } catch (error){
        if (error.name !== "AbortError") {
            return res.status(500).json({error: error.message || "Failed to fetch movies"});
        }
    }
    return res.status(500).json({error: "Request aborted"});
});

// Fetching details for a specific TMDB movie
router.get('/movies/details/:id', requireAuth, async function(req, res){
    const {id} = req.params;
    const baseUrl = `https://api.themoviedb.org/3/movie/${id}?api_key=${process.env.TMDB_API_KEY}`;

    try{
        const response = await fetch(baseUrl, {
            headers: {
                'accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`TMDB API error: ${response.status} - ${errorText}`);
        }
        
        const json = await response.json();
        return res.status(200).json(json);
    } catch (error){
        return res.status(500).json({error: error.message || "Failed to fetch movie details"});
    }
});

// Searching for books via Google Books API
router.get('/books/:title', requireAuth, async function(req, res){
    const {title} = req.params;
    const baseUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(title)}&key=${process.env.GOOGLE_BOOKS_API_KEY}`;

    const abortCont = new AbortController();

    try{
        const response = await fetch(baseUrl, { signal: abortCont.signal });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Google Books API error: ${response.status} - ${errorText}`);
        }
        const json = await response.json();
        const data = json.items || [];
        return res.status(200).json(data);
    } catch (error){
        if (error.name !== "AbortError") {
            return res.status(500).json({error: error.message || "Failed to fetch books"});
        }
    }
    return res.status(500).json({error: "Request aborted"});
});

// Fetching details for a specific Google Books volume
router.get('/books/details/:id', requireAuth, async function(req, res){
    const {id} = req.params;
    const baseUrl = `https://www.googleapis.com/books/v1/volumes/${id}?key=${process.env.GOOGLE_BOOKS_API_KEY}`;

    try{
        const response = await fetch(baseUrl);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Google Books API error: ${response.status} - ${errorText}`);
        }
        const json = await response.json();
        return res.status(200).json(json);
    } catch (error){
        return res.status(500).json({error: error.message || "Failed to fetch book details"});
    }
});

// Fetching details for a specific justwatch movie
router.get('/justwatch/details/:id', requireAuth, async function(req, res){
    const {id} = req.params;
    const baseUrl = `https://imdb.iamidiotareyoutoo.com/justwatch?id=${id}`;

    try{
        const response = await fetch(baseUrl);
        if (!response.ok) throw new Error("Failed to fetch justwatch movie details");
        const json = await response.json();
        return res.status(200).json(json);
    } catch (error){
        return res.status(500).json({error: error.message || "Failed to fetch justwatch movie details"});
    }
});

module.exports = router;