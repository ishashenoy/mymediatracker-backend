const { XMLParser } = require("fast-xml-parser");
const slugify = require("slugify");
const crypto = require("crypto");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const NodeCache = require("node-cache");

const UserMedia = require("../models/userMediaModel");
const UniqueMedia = require("../models/uniqueMediaModel");
const User = require("../models/userModel");
const { createFeedActivity, checkMilestones } = require("../controllers/feedController");
const { fireEvent } = require("../controllers/eventsController");
const { sanitizeText, sanitizeUrl, sanitizeIdentifier } = require("../utils/sanitize");
const { resolveNewListItemSectionAndPosition } = require("../utils/listItemPlacement");
const { normalizeStarRatingInput, ratingForApiResponse } = require("../utils/starRating");
const { IMAGE_TRANSFORMS } = require("../utils/imageTransformProfiles");

const trendingCache = new NodeCache({ stdTTL: 86400 });

cloudinary.config({
    cloudinary_url: process.env.CLOUDINARY_URL,
});

function generateHash(str) {
    if (!str) return crypto.randomBytes(3).toString("hex");
    return crypto.createHash("md5").update(str).digest("hex").slice(0, 6);
}

function generateSlug(name, imageUrl) {
    const base = slugify(name || "untitled", { lower: true, strict: true }).slice(0, 50);
    const hash = generateHash(imageUrl || name);
    return `${base}-${hash}`;
}

function normalizeName(name = "") {
    return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegex(str = "") {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeProgress(rawProgress) {
    if (rawProgress === undefined || rawProgress === null || rawProgress === "") {
        return "";
    }

    const str = String(rawProgress).trim();

    if (!/^\d+$/.test(str)) {
        throw new Error("Progress must be a non-negative whole number");
    }

    if (str.length > 9) {
        throw new Error("Progress value is too large");
    }

    return str;
}

function serializeUserMedia(doc) {
    const media = doc.unique_media_ref || {};
    const useCustomDisplay = Boolean(doc.use_custom_display);

    return {
        _id: doc._id,
        user_id: doc.user_id,
        unique_media_ref: media._id || doc.unique_media_ref,
        canonical_id: doc.canonical_id || null,

        rating: ratingForApiResponse(doc.rating),
        status: doc.status,
        progress: doc.progress,
        fav: doc.fav,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,

        use_custom_display: useCustomDisplay,
        custom_name: doc.custom_name || "",
        custom_image_url: doc.custom_image_url || "",

        name: useCustomDisplay && doc.custom_name ? doc.custom_name : media.name,
        image_url: useCustomDisplay && doc.custom_image_url ? doc.custom_image_url : media.image_url,

        type: media.type,
        source: media.source,
        media_id: media.media_id,
        score: media.score,

        // Extended data capture fields
        review_text: doc.review_text || null,
        contains_spoilers: doc.contains_spoilers || false,
        rewatch_count: doc.rewatch_count || 0,
        format: doc.format || null,
        platform: doc.platform || null,
        started_at: doc.started_at || null,
        finished_at: doc.finished_at || null,
        source_of_discovery: doc.source_of_discovery || null,
        mood_tags: doc.mood_tags || [],
        owned: doc.owned || false,
        dropped_at_progress: doc.dropped_at_progress || null,
    };
}

function serializeInternalMediaDetails(uniqueMediaDoc, creatorDoc, viewerId) {
    if (!uniqueMediaDoc) return null;
    const creatorId = uniqueMediaDoc.created_by ? String(uniqueMediaDoc.created_by) : '';
    return {
        _id: uniqueMediaDoc._id,
        type: uniqueMediaDoc.type || '',
        source: uniqueMediaDoc.source || 'internal',
        media_id: uniqueMediaDoc.media_id || '',
        title: uniqueMediaDoc.name || '',
        cover_image_url: uniqueMediaDoc.image_url || '',
        header_image_url: uniqueMediaDoc.header_image_url || '',
        description: uniqueMediaDoc.description || '',
        created_by: creatorId || null,
        creator_username: creatorDoc?.username || '',
        creator_display_name: creatorDoc?.displayName || creatorDoc?.username || '',
        can_edit: Boolean(viewerId && creatorId && String(viewerId) === creatorId),
    };
}

async function findPotentialUniqueMatches({ name, type, limit = 8 }) {
    const cleanName = String(name || "").trim();
    const cleanType = String(type || "").trim();

    if (!cleanName || !cleanType) return [];

    const normalized = normalizeName(cleanName);
    const escaped = escapeRegex(normalized);

    const exactMatches = await UniqueMedia.find({
        type: cleanType,
        normalized_name: normalized,
    })
        .select("_id name image_url type source media_id score normalized_name")
        .limit(limit);

    if (exactMatches.length > 0) {
        return exactMatches;
    }

    const prefixMatches = await UniqueMedia.find({
        type: cleanType,
        normalized_name: { $regex: `^${escaped}`, $options: "i" },
    })
        .select("_id name image_url type source media_id score normalized_name")
        .limit(limit);

    return prefixMatches;
}

async function findOrCreateUniqueMedia({
    name,
    image_url,
    type,
    source,
    media_id,
    score,
    created_by,
}) {
    const cleanSource = String(source || "").trim();
    const cleanMediaId = String(media_id || "").trim();
    const cleanName = String(name || "").trim();
    const cleanType = String(type || "").trim();
    const cleanImage = String(image_url || "").trim();

    if (!cleanName || !cleanType) {
        throw new Error("Name and type are required.");
    }

    let uniqueMedia;

    if (cleanSource && cleanMediaId) {
        let existing = await UniqueMedia.findOne({
            source: cleanSource,
            media_id: cleanMediaId,
            type: cleanType,
        });

        if (existing) {
            uniqueMedia = existing;
        } else {
            uniqueMedia = await UniqueMedia.create({
                source: cleanSource,
                media_id: cleanMediaId,
                type: cleanType,
                name: cleanName,
                normalized_name: normalizeName(cleanName),
                image_url: cleanImage,
                ...(cleanSource === "internal" && created_by ? { created_by } : {}),
                ...(score !== undefined && score !== null && score !== "" ? { score } : {}),
            });
        }
    } else {
        let fallback = await UniqueMedia.findOne({
            type: cleanType,
            normalized_name: normalizeName(cleanName),
            image_url: cleanImage,
        });

        if (fallback) {
            uniqueMedia = fallback;
        } else {
            uniqueMedia = await UniqueMedia.create({
                type: cleanType,
                name: cleanName,
                normalized_name: normalizeName(cleanName),
                image_url: cleanImage,
                ...(cleanSource === "internal" && created_by ? { created_by } : {}),
                ...(cleanSource ? { source: cleanSource } : {}),
                ...(cleanMediaId ? { media_id: cleanMediaId } : {}),
                ...(score !== undefined && score !== null && score !== "" ? { score } : {}),
            });
        }
    }

    // Dual-write to canonical_media + media_sources (async, fire-and-forget)
    setImmediate(async () => {
        try {
            const CanonicalMedia = require("../models/canonicalMediaModel");
            const MediaSource = require("../models/mediaSourceModel");

            // Find or create canonical entry by type + normalized_name
            let canonical = await CanonicalMedia.findOne({
                type: cleanType,
                normalized_name: normalizeName(cleanName),
            });

            if (!canonical) {
                canonical = await CanonicalMedia.create({
                    type: cleanType,
                    name: cleanName,
                    normalized_name: normalizeName(cleanName),
                    primary_image_url: cleanImage,
                    is_user_submitted: !cleanSource || cleanSource === "internal",
                });
            }

            // Upsert media source record if we have external identifiers
            if (cleanSource && cleanMediaId) {
                await MediaSource.findOneAndUpdate(
                    { source: cleanSource, source_media_id: cleanMediaId },
                    {
                        canonical_id: canonical._id,
                        metadata_snapshot: { name: cleanName, image_url: cleanImage, score },
                        last_fetched_at: new Date(),
                    },
                    { upsert: true, new: true }
                );
            }

            // Lazy backfill: set canonical_id on any UserMedia that references this UniqueMedia
            await UserMedia.updateMany(
                { unique_media_ref: uniqueMedia._id, canonical_id: null },
                { $set: { canonical_id: canonical._id } }
            );
        } catch (e) {
            // Silent — dual-write failures must never affect the primary response
        }
    });

    return uniqueMedia;
}

// GET all media for logged-in user
const getMedias = async (req, res) => {
    try {
        const user_id = req.user._id;

        const entries = await UserMedia.find({ user_id })
            .populate("unique_media_ref")
            .sort({ status: 1, updatedAt: -1 });

        const user = await User.findById(user_id).select("private");

        return res.status(200).json({
            watchList: entries.map(serializeUserMedia),
            private: user?.private ?? false,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET the authenticated user's library entry for a canonical title (type + source + media_id)
const getMyEntryByLookup = async (req, res) => {
    try {
        const user_id = req.user._id;
        const type = String(req.query.type || "").trim();
        const source = String(req.query.source || "").trim().toLowerCase();
        const media_id = String(req.query.media_id || "").trim();

        if (!type || !source || !media_id) {
            return res.status(400).json({ error: "type, source, and media_id are required" });
        }

        const uniqueMedia = await UniqueMedia.findOne({ type, source, media_id });
        if (!uniqueMedia) {
            return res.status(200).json({ entry: null });
        }

        const entry = await UserMedia.findOne({
            user_id,
            unique_media_ref: uniqueMedia._id,
        }).populate("unique_media_ref");

        if (!entry) {
            return res.status(200).json({ entry: null });
        }

        return res.status(200).json({ entry: serializeUserMedia(entry) });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET media of a profile
const getProfileMedia = async (req, res) => {
    const { username } = req.params;

    try {
        const user = await User.findOne({ username });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const user_id = user._id;
        const privacy = user.private;
        const pendingDeletion = Boolean(user.account_deletion_requested_at);

        const fetchProfileMedia = async () => {
            const entries = await UserMedia.find({ user_id })
                .populate("unique_media_ref")
                .sort({ status: 1, updatedAt: -1 });

            return res.status(200).json({
                watchList: entries.map(serializeUserMedia),
                private: privacy,
            });
        };

        const { authorization } = req.headers;

        const resolveViewer = async () => {
            if (!authorization) return null;
            try {
                const jwt = require("jsonwebtoken");
                const token = authorization.split(" ")[1];
                const { _id } = jwt.verify(token, process.env.SECRET);
                return User.findById(_id).select("username role isAdmin is_admin");
            } catch {
                return null;
            }
        };

        if (pendingDeletion) {
            const viewer = await resolveViewer();
            const isOwner = viewer && viewer.username === username;
            const admin =
                viewer &&
                (viewer.role === "admin" || viewer.isAdmin === true || viewer.is_admin === true);
            if (!isOwner && !admin) {
                return res.status(404).json({ error: "User not found" });
            }
            return await fetchProfileMedia();
        }

        if (!privacy) {
            return await fetchProfileMedia();
        }

        if (authorization) {
            try {
                const jwt = require("jsonwebtoken");
                const token = authorization.split(" ")[1];
                const { _id } = jwt.verify(token, process.env.SECRET);
                const viewer = await User.findById(_id).select("username");

                if (viewer) {
                    if (viewer.username === username) {
                        return await fetchProfileMedia();
                    }

                    if (user.followers && user.followers.includes(viewer.username)) {
                        return await fetchProfileMedia();
                    }
                }
            } catch (err) {
                // treat as unauthenticated
            }
        }

        return res.status(403).json({ error: "This account is private", private: true });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET match suggestions
const suggestMediaMatches = async (req, res) => {
    try {
        const { name, type } = req.query;

        if (!name || !type) {
            return res.status(400).json({ error: "Name and type are required." });
        }

        const matches = await findPotentialUniqueMatches({ name, type, limit: 8 });
        return res.status(200).json(matches);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET trending: in-app popularity from UserMedia + UniqueMedia. ?type=all = all types; ?type=anime|… = that type only.
const TRENDING_ALLOWED_TYPES = ['anime', 'manga', 'movie', 'tv', 'game', 'book', 'music', 'web-video'];

const trendingProjection = {
    _id: 0,
    name: '$media.name',
    type: '$media.type',
    media_id: '$media.media_id',
    source: '$media.source',
    count: 1,
    sampleDoc: {
        _id: '$media._id',
        name: '$media.name',
        type: '$media.type',
        image_url: '$media.image_url',
        media_id: '$media.media_id',
        source: '$media.source',
        score: '$media.score',
    },
};

/** Exclude library rows from users in the account-deletion grace window from trending. */
const trendingExcludePendingDeletion = [
    {
        $lookup: {
            from: 'users',
            localField: 'user_id',
            foreignField: '_id',
            as: '_acct',
        },
    },
    { $unwind: { path: '$_acct', preserveNullAndEmptyArrays: false } },
    {
        $match: {
            $or: [
                { '_acct.account_deletion_requested_at': null },
                { '_acct.account_deletion_requested_at': { $exists: false } },
            ],
        },
    },
];

const getTrendingMedia = async (req, res) => {
    try {
        const raw = (req.query.type || 'all').toString().toLowerCase().trim();
        const typeFilter = raw === 'all' || !TRENDING_ALLOWED_TYPES.includes(raw) ? 'all' : raw;

        const cacheKey = typeFilter === 'all' ? 'trendingMedia_all' : `trendingMedia_${typeFilter}`;
        let cachedResult = trendingCache.get(cacheKey);
        if (cachedResult) {
            return res.status(200).json(cachedResult);
        }

        if (typeFilter === 'all') {
            const legacy = trendingCache.get('trendingMedia');
            if (legacy) {
                trendingCache.set(cacheKey, legacy);
                return res.status(200).json(legacy);
            }
        }

        const pipeline =
            typeFilter === 'all'
                ? [
                      ...trendingExcludePendingDeletion,
                      { $group: { _id: '$unique_media_ref', count: { $sum: 1 } } },
                      { $sort: { count: -1 } },
                      { $limit: 15 },
                      {
                          $lookup: {
                              from: 'uniquemedias',
                              localField: '_id',
                              foreignField: '_id',
                              as: 'media',
                          },
                      },
                      { $unwind: '$media' },
                      { $project: trendingProjection },
                  ]
                : [
                      ...trendingExcludePendingDeletion,
                      {
                          $lookup: {
                              from: 'uniquemedias',
                              localField: 'unique_media_ref',
                              foreignField: '_id',
                              as: 'um',
                          },
                      },
                      { $unwind: '$um' },
                      { $match: { 'um.type': typeFilter } },
                      {
                          $group: {
                              _id: '$unique_media_ref',
                              count: { $sum: 1 },
                              media: { $first: '$um' },
                          },
                      },
                      { $sort: { count: -1 } },
                      { $limit: 15 },
                      { $project: trendingProjection },
                  ];

        const result = await UserMedia.aggregate(pipeline);
        trendingCache.set(cacheKey, result);
        if (typeFilter === 'all') {
            trendingCache.set('trendingMedia', result);
        }
        return res.status(200).json(result);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// POST a new media
const createMedia = async (req, res) => {
    const {
        name,
        image_url,
        progress,
        type,
        rating,
        status,
        media_id,
        source,
        score,
        fav,
        matched_unique_media_id,
        use_custom_display,
        custom_name,
        custom_image_url,
        header_image_url,
        description,
        listId,
        // Tier 2 fields
        format,
        platform,
        started_at,
        finished_at,
        rewatch_count,
        // Tier 3 fields
        review_text,
        contains_spoilers,
        source_of_discovery,
        mood_tags,
        owned,
        dropped_at_progress,
    } = req.body;

    const safeName = sanitizeText(name, { maxLen: 200, allowNewlines: false });
    const safeImageUrl = sanitizeUrl(image_url);
    const safeCustomName = custom_name !== undefined ? sanitizeText(custom_name, { maxLen: 200, allowNewlines: false }) : undefined;
    const safeCustomImageUrl = custom_image_url !== undefined ? sanitizeUrl(custom_image_url) : undefined;
    const safeReviewText = review_text !== undefined ? sanitizeText(review_text, { maxLen: 2000, allowNewlines: true }) : undefined;
    const safeHeaderImageUrl = header_image_url !== undefined ? sanitizeUrl(header_image_url) : undefined;
    const safeDescription = description !== undefined ? sanitizeText(description, { maxLen: 2000, allowNewlines: true }) : undefined;
    const safeSourceOfDiscovery = source_of_discovery !== undefined ? sanitizeText(source_of_discovery, { maxLen: 120, allowNewlines: false }) : undefined;
    const safePlatform = platform !== undefined ? sanitizeText(platform, { maxLen: 80, allowNewlines: false }) : undefined;
    const safeFormat = format !== undefined ? sanitizeText(format, { maxLen: 80, allowNewlines: false }) : undefined;

    if (!safeName || !type) {
        return res.status(400).json({ error: "Name and type are required." });
    }

    let ratingToStore = null;
    if (rating !== undefined) {
        try {
            const r = normalizeStarRatingInput(rating);
            if (!r.skip) {
                ratingToStore = r.value;
            }
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }
    }

    try {
        const user_id = req.user._id;

        let safeProgress = "";
        try {
            safeProgress = normalizeProgress(progress);
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        let uniqueMedia = null;

        if (matched_unique_media_id) {
            if (!mongoose.Types.ObjectId.isValid(matched_unique_media_id)) {
                return res.status(400).json({ error: "Invalid matched_unique_media_id." });
            }

            uniqueMedia = await UniqueMedia.findById(matched_unique_media_id);

            if (!uniqueMedia) {
                return res.status(404).json({ error: "Matched media not found." });
            }
        } else {
            let finalMediaId = media_id;
            const mediaIdStr = String(media_id ?? "").trim();

            if (!mediaIdStr) {
                finalMediaId = generateSlug(name, image_url);
            } else {
                finalMediaId = mediaIdStr;
            }

            const finalSource = source || "internal";

            uniqueMedia = await findOrCreateUniqueMedia({
                name: safeName,
                image_url: safeImageUrl,
                type,
                source: finalSource,
                media_id: finalMediaId,
                score,
                created_by: user_id,
            });

            if (String(finalSource).toLowerCase() === "internal") {
                const internalUpdates = {};
                if (safeHeaderImageUrl !== undefined) internalUpdates.header_image_url = safeHeaderImageUrl;
                if (safeDescription !== undefined) internalUpdates.description = safeDescription;
                if (Object.keys(internalUpdates).length > 0) {
                    await UniqueMedia.findByIdAndUpdate(uniqueMedia._id, internalUpdates);
                }
            }
        }

        const shouldUseCustomDisplay = matched_unique_media_id
            ? Boolean(use_custom_display)
            : true;

        const userMedia = await UserMedia.create({
            user_id,
            unique_media_ref: uniqueMedia._id,
            progress: safeProgress,
            rating: ratingToStore,
            status,
            fav: Boolean(fav),

            use_custom_display: shouldUseCustomDisplay,
            custom_name: shouldUseCustomDisplay ? (safeCustomName || safeName || "") : "",
            custom_image_url: shouldUseCustomDisplay ? (safeCustomImageUrl || safeImageUrl || "") : "",

            // Tier 2/3 fields (all optional)
            ...(safeFormat !== undefined && { format: safeFormat }),
            ...(safePlatform !== undefined && { platform: safePlatform }),
            ...(started_at !== undefined && { started_at }),
            ...(finished_at !== undefined && { finished_at }),
            ...(rewatch_count !== undefined && { rewatch_count: Number(rewatch_count) || 0 }),
            ...(safeReviewText !== undefined && { review_text: safeReviewText }),
            ...(contains_spoilers !== undefined && { contains_spoilers: Boolean(contains_spoilers) }),
            ...(safeSourceOfDiscovery !== undefined && { source_of_discovery: safeSourceOfDiscovery }),
            ...(mood_tags !== undefined && { mood_tags: Array.isArray(mood_tags) ? mood_tags : [] }),
            ...(owned !== undefined && { owned: Boolean(owned) }),
            ...(dropped_at_progress !== undefined && { dropped_at_progress }),
        });

        const populated = await UserMedia.findById(userMedia._id).populate("unique_media_ref");

        let createdListItem = null;

        // Create ListItem entry if listId is provided
        if (listId && mongoose.Types.ObjectId.isValid(listId)) {
            const ListItem = require('../models/listItemModel');
            try {
                const { position: nextPosition } = await resolveNewListItemSectionAndPosition(listId);

                createdListItem = await ListItem.create({
                    list_id: listId,
                    user_id: user_id,
                    user_media_id: userMedia._id,
                    section_id: null,
                    position: nextPosition,
                });
            } catch (listItemError) {
                // If ListItem creation fails, log but don't fail the whole operation
                console.error("Error creating ListItem:", listItemError);
            }
        }

        await createFeedActivity(user_id, "added_media", userMedia._id);
        await checkMilestones(user_id);

        // Fire log_media event (canonical_id may be null until dual-write backfill completes)
        setImmediate(() => fireEvent(user_id, "log_media", populated.canonical_id || null, {
            unique_media_id: String(uniqueMedia._id),
            status: status || "",
            rating: ratingToStore,
        }));

        const serialized = serializeUserMedia(populated);
        res.status(200).json({
            ...serialized,
            listItemId: createdListItem?._id || null,
            position: typeof createdListItem?.position === 'number' ? createdListItem.position : null,
            section_id: createdListItem?.section_id ?? null,
        });
    } catch (error) {
        console.error("Error in createMedia:", error);
        res.status(400).json({ error: error.message });
    }
};

// GET internal media details by unique lookup (source=internal)
const getInternalMediaDetails = async (req, res) => {
    try {
        const type = String(req.query.type || "").trim();
        const source = String(req.query.source || "").trim().toLowerCase();
        const media_id = String(req.query.media_id || "").trim();

        if (!type || !source || !media_id) {
            return res.status(400).json({ error: "type, source, and media_id are required" });
        }
        if (source !== "internal") {
            return res.status(400).json({ error: "Only internal source is supported on this route" });
        }

        const uniqueMedia = await UniqueMedia.findOne({ type, source, media_id })
            .select("_id type source media_id name image_url header_image_url description created_by")
            .lean();

        if (!uniqueMedia) {
            return res.status(404).json({ error: "Media not found" });
        }

        let creator = null;
        if (uniqueMedia.created_by) {
            creator = await User.findById(uniqueMedia.created_by).select("username displayName").lean();
        }

        return res.status(200).json({
            media: serializeInternalMediaDetails(uniqueMedia, creator, req.user?._id || null),
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// PATCH internal media details (creator only)
const updateInternalMediaDetails = async (req, res) => {
    try {
        const user_id = req.user?._id;
        const { uniqueMediaId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(uniqueMediaId)) {
            return res.status(404).json({ error: "Media does not exist." });
        }

        const uniqueMedia = await UniqueMedia.findById(uniqueMediaId).select(
            "_id type source media_id name image_url header_image_url description created_by"
        );
        if (!uniqueMedia || String(uniqueMedia.source || "").toLowerCase() !== "internal") {
            return res.status(404).json({ error: "Media does not exist." });
        }

        if (!uniqueMedia.created_by || String(uniqueMedia.created_by) !== String(user_id)) {
            return res.status(403).json({ error: "Only the creator can edit this media." });
        }

        const incoming = req.body || {};
        const updates = {};

        if (incoming.title !== undefined) {
            updates.name = sanitizeText(incoming.title, { maxLen: 200, allowNewlines: false });
        }
        if (incoming.cover_image_url !== undefined) {
            updates.image_url = sanitizeUrl(incoming.cover_image_url);
        }
        if (incoming.header_image_url !== undefined) {
            updates.header_image_url = sanitizeUrl(incoming.header_image_url);
        }
        if (incoming.description !== undefined) {
            updates.description = sanitizeText(incoming.description, { maxLen: 2000, allowNewlines: true });
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: "No updates provided." });
        }

        const updated = await UniqueMedia.findByIdAndUpdate(uniqueMediaId, updates, { new: true })
            .select("_id type source media_id name image_url header_image_url description created_by")
            .lean();

        const creator = await User.findById(updated.created_by).select("username displayName").lean();

        return res.status(200).json({
            media: serializeInternalMediaDetails(updated, creator, user_id),
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// POST upload custom media cover image
const uploadMediaImage = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "Image file is required." });
    }

    if (!req.file.mimetype || !req.file.mimetype.startsWith("image/")) {
        return res.status(400).json({ error: "Only image files are allowed." });
    }

    try {
        const userId = String(req.user?._id || "").trim();
        if (!userId) {
            return res.status(401).json({ error: "Not authorized" });
        }
        const rawReplaceKey = req.body?.replace_key;
        const safeReplaceKey = rawReplaceKey
            ? sanitizeIdentifier(rawReplaceKey, { maxLen: 80 })
            : '';
        const publicId = safeReplaceKey
            ? `media-covers/${userId}/${safeReplaceKey}`
            : `media-covers/${userId}/${Date.now()}`;

        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
                {
                    public_id: publicId,
                    overwrite: Boolean(safeReplaceKey),
                    format: "webp",
                    transformation: IMAGE_TRANSFORMS.mediaCover,
                },
                (error, uploadResult) => {
                    if (error) reject(error);
                    else resolve(uploadResult);
                }
            ).end(req.file.buffer);
        });

        return res.status(200).json({ image_url: result.secure_url });
    } catch (error) {
        return res.status(500).json({ error: "Failed to upload image." });
    }
};

// DELETE a media
const deleteMedia = async (req, res) => {
    try {
        const user_id = req.user._id;
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ error: "Media does not exist." });
        }

        const userMedia = await UserMedia.findOne({ _id: id, user_id }).populate("unique_media_ref");

        if (!userMedia) {
            return res.status(404).json({ error: "Media does not exist." });
        }

        const serialized = serializeUserMedia(userMedia);
        const uniqueMediaId = userMedia.unique_media_ref?._id;

        await createFeedActivity(user_id, 'removed_media', userMedia._id);

        await UserMedia.deleteOne({ _id: id, user_id });

        // Clean up any ListItems referencing this UserMedia so they don't appear as broken "no cover" entries
        const ListItem = require('../models/listItemModel');
        await ListItem.deleteMany({ user_media_id: id });

        if (uniqueMediaId) {
            const remainingRefs = await UserMedia.countDocuments({ unique_media_ref: uniqueMediaId });

            if (remainingRefs === 0) {
                const media = userMedia.unique_media_ref;

                if (media?.source === "internal" && media?.image_url) {
                    try {
                        const match = media.image_url.match(/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
                        const publicId = match ? match[1] : null;

                        if (publicId) {
                            await cloudinary.uploader.destroy(publicId).catch(() => {});
                        }
                    } catch (err) {
                        console.error("Cloudinary deletion failed:", err.message);
                    }
                }

                await UniqueMedia.deleteOne({ _id: uniqueMediaId });
            }
        }

        res.status(200).json(serialized);
    } catch (error) {
        console.error("Error in deleteMedia:", error);
        res.status(500).json({ error: error.message });
    }
};

// PATCH link a user library row to an existing catalog UniqueMedia (keeps displayed cover / custom display)
const linkUserMediaToCatalog = async (req, res) => {
    try {
        const user_id = req.user._id;
        const { id } = req.params;
        const {
            unique_media_id: targetUniqueIdRaw,
            source: sourceRaw,
            media_id: mediaIdRaw,
            type: typeRaw,
            name: nameRaw,
            image_url: imageUrlRaw,
            score: scoreRaw,
        } = req.body || {};

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ error: "Media does not exist." });
        }
        const oldEntry = await UserMedia.findOne({ _id: id, user_id }).populate("unique_media_ref");
        if (!oldEntry) {
            return res.status(404).json({ error: "Media does not exist." });
        }

        const oldUnique = oldEntry.unique_media_ref;
        if (!oldUnique) {
            return res.status(400).json({ error: "Invalid library entry." });
        }

        const targetUniqueId = String(targetUniqueIdRaw || "").trim();
        const requestSource = String(sourceRaw || "").trim().toLowerCase();
        const requestMediaId = String(mediaIdRaw || "").trim();
        const requestType = String(typeRaw || "").trim().toLowerCase();
        const requestName = sanitizeText(nameRaw, { maxLen: 200, allowNewlines: false });
        const requestImageUrl = sanitizeUrl(imageUrlRaw);

        let target;
        if (mongoose.Types.ObjectId.isValid(targetUniqueId)) {
            target = await UniqueMedia.findById(targetUniqueId).lean();
        } else if (requestSource && requestMediaId) {
            target = await UniqueMedia.findOne({
                source: requestSource,
                media_id: requestMediaId,
                ...(requestType ? { type: requestType } : {}),
            }).lean();
        }

        if (!target && requestSource && requestMediaId && requestType && requestName) {
            const createdOrFound = await findOrCreateUniqueMedia({
                name: requestName,
                image_url: requestImageUrl || oldUnique.image_url || "",
                type: requestType,
                source: requestSource,
                media_id: requestMediaId,
                score: scoreRaw,
                created_by: user_id,
            });
            target = createdOrFound?.toObject ? createdOrFound.toObject() : createdOrFound;
        }

        if (!target) {
            return res.status(404).json({ error: "Catalog title not found." });
        }

        const src = String(target.source || "").trim().toLowerCase();
        const mid = String(target.media_id || "").trim();
        if (!src || !mid || src === "internal") {
            return res.status(400).json({ error: "That entry cannot be used to load external details." });
        }

        if (String(target._id) === String(oldUnique._id)) {
            return res.status(400).json({ error: "Already linked to this catalog entry." });
        }

        const oldType = String(oldUnique.type || "").toLowerCase();
        const tgtType = String(target.type || "").toLowerCase();
        const standardTypes = new Set(["anime", "manga", "movie", "tv", "game", "book", "music", "web-video"]);
        const typesCompatible = oldType === tgtType || (oldType === "other" && standardTypes.has(tgtType));
        if (!typesCompatible) {
            return res.status(400).json({ error: "Catalog entry must match this item's media type." });
        }

        const dupe = await UserMedia.findOne({
            user_id,
            unique_media_ref: target._id,
            _id: { $ne: oldEntry._id },
        })
            .select("_id")
            .lean();
        if (dupe) {
            return res.status(409).json({
                error: "You already have this catalog title in your library. Remove the duplicate entry first.",
            });
        }

        // Ensure data linkage exists for analytics/recs: canonical + media_sources mapping.
        const CanonicalMedia = require("../models/canonicalMediaModel");
        const MediaSource = require("../models/mediaSourceModel");
        let ms = await MediaSource.findOne({ source: target.source, source_media_id: target.media_id })
            .select("canonical_id")
            .lean();
        let newCanonical = ms?.canonical_id || null;

        if (!newCanonical) {
            const canonicalType = String(target.type || "").trim().toLowerCase();
            const canonicalName = String(target.name || "").trim() || requestName || oldUnique.name || "Untitled";
            const canonicalImage = String(target.image_url || "").trim() || requestImageUrl || oldUnique.image_url || "";

            let canonical = await CanonicalMedia.findOne({
                type: canonicalType,
                normalized_name: normalizeName(canonicalName),
            });

            if (!canonical) {
                canonical = await CanonicalMedia.create({
                    type: canonicalType,
                    name: canonicalName,
                    normalized_name: normalizeName(canonicalName),
                    primary_image_url: canonicalImage,
                    is_user_submitted: false,
                });
            }

            const upsertedSource = await MediaSource.findOneAndUpdate(
                { source: target.source, source_media_id: target.media_id },
                {
                    canonical_id: canonical._id,
                    metadata_snapshot: {
                        name: canonicalName,
                        image_url: canonicalImage,
                        score: target.score ?? scoreRaw ?? null,
                    },
                    last_fetched_at: new Date(),
                },
                { upsert: true, new: true }
            ).select("canonical_id");

            newCanonical = upsertedSource?.canonical_id || canonical._id;
        }

        const displayNameCustom = Boolean(oldEntry.use_custom_display && oldEntry.custom_name);
        const serializedOldEntry = serializeUserMedia(oldEntry);
        const currentDisplayedImage = serializedOldEntry?.image_url || oldUnique.image_url || "";

        const updates = {
            unique_media_ref: target._id,
            canonical_id: newCanonical,
            // Always pin the currently displayed cover so linking never swaps it.
            use_custom_display: true,
            custom_image_url: sanitizeUrl(currentDisplayedImage || ""),
            custom_name: displayNameCustom
                ? sanitizeText(oldEntry.custom_name, { maxLen: 200, allowNewlines: false })
                : "",
        };

        const updated = await UserMedia.findByIdAndUpdate(oldEntry._id, { $set: updates }, { new: true }).populate(
            "unique_media_ref"
        );

        const oldUniqueId = oldUnique._id;
        const refCount = await UserMedia.countDocuments({ unique_media_ref: oldUniqueId });
        if (refCount === 0 && String(oldUnique.source || "").trim().toLowerCase() === "internal") {
            const imgUrl = oldUnique.image_url || "";
            if (imgUrl) {
                try {
                    const match = imgUrl.match(/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
                    const publicId = match ? match[1] : null;
                    if (publicId) await cloudinary.uploader.destroy(publicId).catch(() => {});
                } catch (_) {
                    /* ignore */
                }
            }
            await UniqueMedia.deleteOne({ _id: oldUniqueId });
        }

        return res.status(200).json(serializeUserMedia(updated));
    } catch (error) {
        console.error("linkUserMediaToCatalog:", error);
        res.status(500).json({ error: error.message });
    }
};

// UPDATE a media
const updateMedia = async (req, res) => {
    try {
        const user_id = req.user._id;
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ error: "Media does not exist." });
        }

        const oldUserMedia = await UserMedia.findOne({ _id: id, user_id }).populate("unique_media_ref");
        if (!oldUserMedia) {
            return res.status(404).json({ error: "Media does not exist." });
        }

        const incoming = req.body || {};
        const updates = {};

        if (incoming.rating !== undefined) {
            try {
                const r = normalizeStarRatingInput(incoming.rating);
                if (!r.skip) {
                    updates.rating = r.value;
                }
            } catch (err) {
                return res.status(400).json({ error: err.message });
            }
        }
        if (incoming.status !== undefined) updates.status = incoming.status;
        if (incoming.fav !== undefined) updates.fav = Boolean(incoming.fav);

        if (incoming.progress !== undefined) {
            try {
                updates.progress = normalizeProgress(incoming.progress);
            } catch (err) {
                return res.status(400).json({ error: err.message });
            }
        }

        if (incoming.use_custom_display !== undefined) {
            updates.use_custom_display = Boolean(incoming.use_custom_display);
        }

        if (incoming.custom_name !== undefined) {
            updates.custom_name = sanitizeText(incoming.custom_name, { maxLen: 200, allowNewlines: false });
        }

        if (incoming.custom_image_url !== undefined) {
            updates.custom_image_url = sanitizeUrl(incoming.custom_image_url);
        }

        // Tier 2/3 fields
        const extendedFields = [
            "format", "platform", "started_at", "finished_at",
            "review_text", "source_of_discovery", "dropped_at_progress",
        ];
        extendedFields.forEach(field => {
            if (incoming[field] === undefined) return;
            if (field === "review_text") updates[field] = sanitizeText(incoming[field], { maxLen: 2000, allowNewlines: true });
            else if (field === "source_of_discovery") updates[field] = sanitizeText(incoming[field], { maxLen: 120, allowNewlines: false });
            else if (field === "platform") updates[field] = sanitizeText(incoming[field], { maxLen: 80, allowNewlines: false });
            else if (field === "format") updates[field] = sanitizeText(incoming[field], { maxLen: 80, allowNewlines: false });
            else updates[field] = incoming[field];
        });

        if (incoming.rewatch_count !== undefined) {
            updates.rewatch_count = Number(incoming.rewatch_count) || 0;
        }
        if (incoming.contains_spoilers !== undefined) {
            updates.contains_spoilers = Boolean(incoming.contains_spoilers);
        }
        if (incoming.owned !== undefined) {
            updates.owned = Boolean(incoming.owned);
        }
        if (incoming.mood_tags !== undefined) {
            updates.mood_tags = Array.isArray(incoming.mood_tags) ? incoming.mood_tags : [];
        }

        const userMedia = await UserMedia.findOneAndUpdate(
            { _id: id, user_id },
            updates,
            { new: true }
        ).populate("unique_media_ref");

        const canonicalId = userMedia.canonical_id || null;

        if (updates.status !== undefined && updates.status !== oldUserMedia.status) {
            await createFeedActivity(user_id, "updated_status", id, oldUserMedia.status, updates.status);
            setImmediate(() => fireEvent(user_id, "status_change", canonicalId, {
                old: oldUserMedia.status,
                new: updates.status,
            }));
        }
        if (updates.rating !== undefined && updates.rating !== oldUserMedia.rating) {
            await createFeedActivity(user_id, "updated_rating", id, oldUserMedia.rating, updates.rating);
            setImmediate(() => fireEvent(user_id, "rate", canonicalId, {
                old: oldUserMedia.rating,
                new: updates.rating,
            }));
        }
        if (updates.progress !== undefined && updates.progress !== oldUserMedia.progress) {
            await createFeedActivity(user_id, "updated_progress", id, oldUserMedia.progress, updates.progress);
        }
        if (updates.review_text !== undefined) {
            setImmediate(() => fireEvent(user_id, "review", canonicalId, {
                has_spoilers: updates.contains_spoilers || false,
            }));
        }

        res.status(200).json(serializeUserMedia(userMedia));
    } catch (error) {
        console.error("Error in updateMedia:", error);
        res.status(500).json({ error: error.message });
    }
};

// IMPORT media from Goodreads
const importMedia = async (req, res) => {
    const { source } = req.params;
    let { handle } = req.body;

    if (!handle) {
        return res.status(400).json({ error: "Handle is required" });
    }

    handle = String(handle || "").trim();

    if (source === "goodreads") {
        if (!/^\d+$/.test(handle)) {
            return res.status(400).json({ error: "Invalid Goodreads handle. Must be a number." });
        }
        handle = parseInt(handle, 10);
    } else {
        return res.status(400).json({ error: "Unsupported source" });
    }

    const user_id = req.user._id;
    const parser = new XMLParser();

    let url;
    if (source === "goodreads") {
        url = `https://www.goodreads.com/review/list_rss/${handle}`;
    } else {
        return res.status(400).json({ error: "Unsupported source" });
    }

    let items;
    const importedMedia = [];

    function unwrap(val) {
        if (val && typeof val === "object" && "__cdata" in val) {
            return val.__cdata;
        }
        return val ?? "";
    }

    function extractGoodreadsBookId(imageUrl) {
        if (!imageUrl || typeof imageUrl !== "string") return null;
        const match = imageUrl.match(/\/(\d+)(?:\.[A-Za-z0-9_]+)?\.jpg(?:\?.*)?$/i);
        return match ? match[1] : null;
    }

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Failed to fetch");

        const xmlData = await response.text();
        const jsonObj = parser.parse(xmlData);
        items = jsonObj?.rss?.channel?.item || [];

        if (!Array.isArray(items)) {
            items = [items];
        }

        for (const item of items) {
            let name, image_url, progress, rating, type, status, media_id, mediaSource;

            if (source === "goodreads") {
                name = unwrap(item.title);
                image_url = unwrap(item.book_large_image_url);
                progress = "";
                {
                    const rawGr = item.user_rating;
                    rating = null;
                    if (rawGr != null && rawGr !== '' && String(rawGr) !== '0') {
                        try {
                            const r = normalizeStarRatingInput(Number(rawGr));
                            if (!r.skip) {
                                rating = r.value;
                            }
                        } catch {
                            rating = null;
                        }
                    }
                }
                type = "book";
                mediaSource = "goodreads";

                if ((item.user_shelves || "").includes("to-read")) {
                    status = "to-do";
                } else if ((item.user_shelves || "").includes("currently-reading")) {
                    status = "doing";
                } else {
                    status = "done";
                }

                const extractedGoodreadsId = extractGoodreadsBookId(image_url);
                media_id = extractedGoodreadsId || generateSlug(name, image_url);
            }

            const uniqueMedia = await findOrCreateUniqueMedia({
                name,
                image_url,
                type,
                source: mediaSource,
                media_id,
            });

            const userMedia = await UserMedia.create({
                user_id,
                unique_media_ref: uniqueMedia._id,
                progress,
                rating,
                status,
                fav: false,
                use_custom_display: false,
                custom_name: "",
                custom_image_url: "",
            });

            const populated = await UserMedia.findById(userMedia._id).populate("unique_media_ref");
            importedMedia.push(serializeUserMedia(populated));

            await createFeedActivity(user_id, "added_media", userMedia._id);
        }

        await checkMilestones(user_id);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(importedMedia);
};

module.exports = {
    createMedia,
    uploadMediaImage,
    getProfileMedia,
    getTrendingMedia,
    getMedias,
    getMyEntryByLookup,
    getInternalMediaDetails,
    deleteMedia,
    linkUserMediaToCatalog,
    updateMedia,
    updateInternalMediaDetails,
    importMedia,
    suggestMediaMatches,
    findOrCreateUniqueMedia,
};