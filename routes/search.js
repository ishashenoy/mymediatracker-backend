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

const UNIFIED_MEDIA_TYPES = ['anime', 'manga', 'tv', 'movie', 'book', 'game', 'music'];
const ALL_SEARCHABLE_TYPES = [...UNIFIED_MEDIA_TYPES, 'web-video'];

// Unified search across all media types - sorted by title relevance
// Optional query: ?type=movie (or anime, manga, tv, book, game, music) to search one type only
router.get('/all/:title', requireAuth, async function(req, res) {
    const { title } = req.params;
    const searchQuery = title.toLowerCase().trim();
    const rawType = String(req.query.type || 'all').toLowerCase().trim();
    let activeTypes = ALL_SEARCHABLE_TYPES;
    if (rawType !== 'all') {
        if (!ALL_SEARCHABLE_TYPES.includes(rawType)) {
            return res.status(400).json({
                error: `Invalid type. Use one of: all, ${ALL_SEARCHABLE_TYPES.join(', ')}`
            });
        }
        activeTypes = [rawType];
    }

    const abortCont = new AbortController();
    const timeout = setTimeout(() => abortCont.abort(), 10000); // 10s timeout

    const normalizeSearchText = (value = "") =>
        String(value)
            .toLowerCase()
            .trim()
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ");

    const levenshteinDistance = (a = "", b = "") => {
        const m = a.length;
        const n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 0; i <= m; i += 1) dp[i][0] = i;
        for (let j = 0; j <= n; j += 1) dp[0][j] = j;
        for (let i = 1; i <= m; i += 1) {
            for (let j = 1; j <= n; j += 1) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + cost
                );
            }
        }
        return dp[m][n];
    };

    // Higher score => closer title match.
    const getRelevanceScore = (itemTitle, queryText) => {
        if (!itemTitle || !queryText) return 0;
        const normalizedTitle = normalizeSearchText(itemTitle);
        const normalizedQuery = normalizeSearchText(queryText);
        if (!normalizedTitle || !normalizedQuery) return 0;

        const titleTokens = normalizedTitle.split(" ").filter(Boolean);
        const queryTokens = normalizedQuery.split(" ").filter(Boolean);
        const titleSet = new Set(titleTokens);
        const overlapCount = queryTokens.filter((token) => titleSet.has(token)).length;
        const tokenCoverage = queryTokens.length ? overlapCount / queryTokens.length : 0;

        const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const startsWith = normalizedTitle.startsWith(normalizedQuery);
        const wholeWord = new RegExp(`\\b${escaped}\\b`, "i").test(normalizedTitle);
        const includes = normalizedTitle.includes(normalizedQuery);

        const distance = levenshteinDistance(normalizedTitle, normalizedQuery);
        const maxLen = Math.max(normalizedTitle.length, normalizedQuery.length) || 1;
        const similarity = 1 - distance / maxLen;

        let score = 0;
        if (normalizedTitle === normalizedQuery) score += 120;
        if (startsWith) score += 50;
        if (wholeWord) score += 35;
        if (includes) score += 20;
        score += Math.round(tokenCoverage * 50);
        score += Math.round(Math.max(0, similarity) * 40);

        return score;
    };

    const fetchJobs = [];
    if (activeTypes.includes('anime')) {
        fetchJobs.push(
            fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&sfw=true&limit=20`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { data: [] })
                .then(j => ({ kind: 'anime', rows: j.data || [] }))
        );
    }
    if (activeTypes.includes('manga')) {
        fetchJobs.push(
            fetch(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(title)}&limit=20`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { data: [] })
                .then(j => ({ kind: 'manga', rows: j.data || [] }))
        );
    }
    if (activeTypes.includes('tv')) {
        fetchJobs.push(
            fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : [])
                .then(data => ({ kind: 'tv', rows: data.map(item => item.show) }))
        );
    }
    if (activeTypes.includes('movie')) {
        fetchJobs.push(
            fetch(`https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(title)}&api_key=${process.env.TMDB_API_KEY}`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { results: [] })
                .then(j => ({ kind: 'movie', rows: j.results || [] }))
        );
    }
    if (activeTypes.includes('book')) {
        fetchJobs.push(
            fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(title)}&key=${process.env.GOOGLE_BOOKS_API_KEY}&maxResults=20`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { items: [] })
                .then(j => ({ kind: 'book', rows: j.items || [] }))
        );
    }
    if (activeTypes.includes('game')) {
        fetchJobs.push(
            fetch(`https://api.rawg.io/api/games?key=${process.env.RAWG_API_KEY}&search=${encodeURIComponent(title)}&page_size=20`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { results: [] })
                .then(j => ({ kind: 'game', rows: j.results || [] }))
        );
    }
    if (activeTypes.includes('music')) {
        fetchJobs.push(
            fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=music&entity=song&limit=20`, { signal: abortCont.signal })
                .then(r => r.ok ? r.json() : { results: [] })
                .then(j => ({ kind: 'music', rows: j.results || [] }))
        );
    }

    try {
        const settled = await Promise.allSettled(fetchJobs);
        clearTimeout(timeout);

        // Normalize and combine all results with relevance scoring
        const allResults = [];

        settled.forEach((entry) => {
            if (entry.status !== 'fulfilled' || !entry.value) return;
            const { kind, rows } = entry.value;
            if (!Array.isArray(rows)) return;

            if (kind === 'anime') {
                rows.forEach(item => {
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
            } else if (kind === 'manga') {
                rows.forEach(item => {
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
            } else if (kind === 'tv') {
                rows.forEach(item => {
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
            } else if (kind === 'movie') {
                rows.forEach(item => {
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
            } else if (kind === 'book') {
                rows.forEach(item => {
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
            } else if (kind === 'game') {
                rows.forEach(item => {
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
            } else if (kind === 'music') {
                rows.forEach(item => {
                    const trackName = item.trackName || item.collectionName || '';
                    const imageUrl = item.artworkUrl100
                        ? item.artworkUrl100.replace('100x100bb', '600x600bb')
                        : null;
                    allResults.push({
                        id: item.trackId?.toString() || item.collectionId?.toString() || '',
                        name: trackName,
                        image_url: imageUrl,
                        type: 'music',
                        source: 'itunes',
                        relevance: getRelevanceScore(trackName, searchQuery),
                        raw: item
                    });
                });
            }
        });

        // De-duplicate by source+type+id and keep best-ranked item.
        const dedupedByKey = new Map();
        allResults.forEach((item) => {
            const key = `${item.type || ''}::${item.source || 'internal'}::${item.id || ''}`;
            const existing = dedupedByKey.get(key);
            if (!existing) {
                dedupedByKey.set(key, item);
                return;
            }
            if (item.relevance > existing.relevance) {
                dedupedByKey.set(key, item);
                return;
            }
            if (
                item.relevance === existing.relevance
                && !existing.image_url
                && item.image_url
            ) {
                dedupedByKey.set(key, item);
            }
        });

        // Sort by relevance score (descending), then by name (ascending) for same scores
        const sortedResults = Array.from(dedupedByKey.values()).sort((a, b) => {
            if (b.relevance !== a.relevance) {
                return b.relevance - a.relevance;
            }
            return a.name.localeCompare(b.name);
        });

        // Limit total results
        const limitedResults = sortedResults.slice(0, 50);

        return res.status(200).json({
            query: title,
            total: limitedResults.length,
            results: limitedResults
        });

    } catch (error) {
        clearTimeout(timeout);
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
    const baseUrl = `https://api.themoviedb.org/3/movie/${id}?api_key=${process.env.TMDB_API_KEY}&append_to_response=credits`;

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

// Searching for music via iTunes Search API (free, no key required)
router.get('/music/:title', requireAuth, async function(req, res){
    const { title } = req.params;
    const baseUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=music&entity=song&limit=25`;

    try {
        const response = await fetch(baseUrl);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`iTunes Search API error: ${response.status} - ${errorText}`);
        }
        const json = await response.json();
        const data = json.results || [];
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message || "Failed to fetch music" });
    }
});

// Fetching details for a specific iTunes track
router.get('/music/details/:id', requireAuth, async function(req, res){
    const { id } = req.params;
    const baseUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=song`;

    try {
        const response = await fetch(baseUrl);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`iTunes Lookup API error: ${response.status} - ${errorText}`);
        }
        const json = await response.json();
        const result = (json.results || [])[0] || null;
        if (!result) {
            return res.status(404).json({ error: "Track not found" });
        }
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error: error.message || "Failed to fetch music details" });
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