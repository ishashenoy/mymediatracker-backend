require("dotenv").config();

const mongoose = require("mongoose");

const UniqueMedia = require("./models/uniqueMediaModel");
const UserMedia = require("./models/userMediaModel");
const Event = require("./models/eventModel");
const Post = require("./models/postModel");
const { sanitizeUrl } = require("./utils/sanitize");

const TARGET_TYPE = "movie";
const CANONICAL_SOURCE = "tmdb";

function printUsage() {
    console.log(`Usage: node collapseMovieTmdbDuplicates.js [options]

Collapses movie duplicate UniqueMedia groups into the single TMDB-backed entry.
Runs in dry-run mode by default.

Options:
  --apply                         Execute writes. Without this flag, the script only reports.
  --limit <number>                Only scan the first N duplicate groups.
  --normalized-name <value>       Restrict processing to one normalized_name value.
  --help                          Show this message.
`);
}

function readFlagValue(args, index, flagName) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flagName} requires a value.`);
    }
    return value;
}

function parseArgs(argv) {
    const options = {
        apply: false,
        limit: null,
        normalizedName: null,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === "--apply") {
            options.apply = true;
            continue;
        }
        if (arg === "--help") {
            options.help = true;
            continue;
        }
        if (arg === "--limit") {
            const rawValue = readFlagValue(argv, index, "--limit");
            const parsed = Number.parseInt(String(rawValue), 10);
            if (!Number.isFinite(parsed) || parsed < 1) {
                throw new Error("--limit must be a positive integer.");
            }
            options.limit = parsed;
            index += 1;
            continue;
        }
        if (arg === "--normalized-name") {
            const rawValue = readFlagValue(argv, index, "--normalized-name");
            const parsed = String(rawValue).trim();
            if (!parsed) {
                throw new Error("--normalized-name must not be empty.");
            }
            options.normalizedName = parsed;
            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return options;
}

function normalizeSource(value) {
    return String(value || "").trim().toLowerCase();
}

function toIdString(value) {
    return value ? String(value) : "";
}

function buildGroupKey(normalizedName) {
    return `${TARGET_TYPE} | ${normalizedName}`;
}

function buildGroupPipeline(options) {
    const matchStage = { type: TARGET_TYPE };

    if (options.normalizedName) {
        matchStage.normalized_name = options.normalizedName;
    }

    const pipeline = [
        { $match: matchStage },
        { $sort: { updatedAt: -1 } },
        {
            $group: {
                _id: { normalized_name: "$normalized_name" },
                count: { $sum: 1 },
                display_name: { $first: "$name" },
            },
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1, "_id.normalized_name": 1 } },
    ];

    if (options.limit) {
        pipeline.push({ $limit: options.limit });
    }

    return pipeline;
}

function emptyGroupStats() {
    return {
        userMediaReassigned: 0,
        eventsReassigned: 0,
        postLinkedMediaDocsUpdated: 0,
        postLinkedMediasDocsUpdated: 0,
        postLinkedMediasAttachmentsUpdated: 0,
        duplicateRowsTargeted: 0,
        duplicateRowsDeleted: 0,
    };
}

function createSummary(options) {
    return {
        mode: options.apply ? "apply" : "dry-run",
        groupsScanned: 0,
        groupsEligible: 0,
        groupsCollapsed: 0,
        groupsSkipped: 0,
        groupsErrored: 0,
        userMediaReassigned: 0,
        eventsReassigned: 0,
        postLinkedMediaDocsUpdated: 0,
        postLinkedMediasDocsUpdated: 0,
        postLinkedMediasAttachmentsUpdated: 0,
        duplicateRowsTargeted: 0,
        duplicateRowsDeleted: 0,
        skippedGroups: [],
        erroredGroups: [],
    };
}

function addGroupStats(summary, stats) {
    summary.userMediaReassigned += stats.userMediaReassigned;
    summary.eventsReassigned += stats.eventsReassigned;
    summary.postLinkedMediaDocsUpdated += stats.postLinkedMediaDocsUpdated;
    summary.postLinkedMediasDocsUpdated += stats.postLinkedMediasDocsUpdated;
    summary.postLinkedMediasAttachmentsUpdated += stats.postLinkedMediasAttachmentsUpdated;
    summary.duplicateRowsTargeted += stats.duplicateRowsTargeted;
    summary.duplicateRowsDeleted += stats.duplicateRowsDeleted;
}

function getPinnedCoverImage(userMedia, previousUniqueMedia) {
    const currentDisplayedImage =
        userMedia.use_custom_display && userMedia.custom_image_url
            ? userMedia.custom_image_url
            : previousUniqueMedia.image_url || "";

    return sanitizeUrl(currentDisplayedImage || "");
}

function buildPostReplacementFields(survivor) {
    return {
        unique_media_id: survivor._id,
        name: survivor.name || null,
        image_url: sanitizeUrl(survivor.image_url) || null,
        type: survivor.type || null,
        source: normalizeSource(survivor.source) || null,
        media_id: survivor.media_id ? String(survivor.media_id) : null,
    };
}

async function countArrayLinkedMediaReferences(duplicateId) {
    const result = await Post.aggregate([
        { $match: { linked_medias: { $elemMatch: { unique_media_id: duplicateId } } } },
        {
            $project: {
                matchCount: {
                    $size: {
                        $filter: {
                            input: "$linked_medias",
                            as: "item",
                            cond: { $eq: ["$$item.unique_media_id", duplicateId] },
                        },
                    },
                },
            },
        },
        {
            $group: {
                _id: null,
                postCount: { $sum: 1 },
                attachmentCount: { $sum: "$matchCount" },
            },
        },
    ]);

    return {
        postCount: result[0]?.postCount || 0,
        attachmentCount: result[0]?.attachmentCount || 0,
    };
}

async function migrateDuplicateReferences(duplicate, survivor, options) {
    const duplicateId = duplicate._id;
    const survivorPostFields = buildPostReplacementFields(survivor);

    const [userMediaDocs, eventCount, singularPostCount, arrayLinkedMediaCounts] = await Promise.all([
        UserMedia.find({ unique_media_ref: duplicateId })
            .select("_id use_custom_display custom_image_url")
            .lean(),
        Event.countDocuments({ unique_media_id: duplicateId }),
        Post.countDocuments({ "linked_media.unique_media_id": duplicateId }),
        countArrayLinkedMediaReferences(duplicateId),
    ]);

    const stats = {
        userMediaReassigned: userMediaDocs.length,
        eventsReassigned: eventCount,
        postLinkedMediaDocsUpdated: singularPostCount,
        postLinkedMediasDocsUpdated: arrayLinkedMediaCounts.postCount,
        postLinkedMediasAttachmentsUpdated: arrayLinkedMediaCounts.attachmentCount,
        duplicateRowsTargeted: 1,
        duplicateRowsDeleted: 0,
    };

    if (!options.apply) {
        return stats;
    }

    if (userMediaDocs.length > 0) {
        await UserMedia.bulkWrite(
            userMediaDocs.map((userMedia) => {
                const pinnedCoverImage = getPinnedCoverImage(userMedia, duplicate);
                const update = { unique_media_ref: survivor._id };

                if (pinnedCoverImage) {
                    update.use_custom_display = true;
                    update.custom_image_url = pinnedCoverImage;
                }

                return {
                    updateOne: {
                        filter: { _id: userMedia._id, unique_media_ref: duplicateId },
                        update: { $set: update },
                    },
                };
            }),
            { ordered: false }
        );
    }

    if (eventCount > 0) {
        await Event.updateMany({ unique_media_id: duplicateId }, { $set: { unique_media_id: survivor._id } });
    }

    if (singularPostCount > 0) {
        await Post.updateMany(
            { "linked_media.unique_media_id": duplicateId },
            {
                $set: {
                    "linked_media.unique_media_id": survivorPostFields.unique_media_id,
                    "linked_media.name": survivorPostFields.name,
                    "linked_media.image_url": survivorPostFields.image_url,
                    "linked_media.type": survivorPostFields.type,
                    "linked_media.source": survivorPostFields.source,
                    "linked_media.media_id": survivorPostFields.media_id,
                },
            }
        );
    }

    if (arrayLinkedMediaCounts.attachmentCount > 0) {
        await Post.updateMany(
            { linked_medias: { $elemMatch: { unique_media_id: duplicateId } } },
            {
                $set: {
                    "linked_medias.$[item].unique_media_id": survivorPostFields.unique_media_id,
                    "linked_medias.$[item].name": survivorPostFields.name,
                    "linked_medias.$[item].image_url": survivorPostFields.image_url,
                    "linked_medias.$[item].type": survivorPostFields.type,
                    "linked_medias.$[item].source": survivorPostFields.source,
                    "linked_medias.$[item].media_id": survivorPostFields.media_id,
                },
            },
            {
                arrayFilters: [{ "item.unique_media_id": duplicateId }],
            }
        );
    }

    return stats;
}

async function countRemainingReferences(duplicateIds) {
    const duplicateIdFilter = { $in: duplicateIds };

    const [userMediaCount, eventCount, linkedMediaPostCount, linkedMediasPostCount] = await Promise.all([
        UserMedia.countDocuments({ unique_media_ref: duplicateIdFilter }),
        Event.countDocuments({ unique_media_id: duplicateIdFilter }),
        Post.countDocuments({ "linked_media.unique_media_id": duplicateIdFilter }),
        Post.countDocuments({ linked_medias: { $elemMatch: { unique_media_id: duplicateIdFilter } } }),
    ]);

    return {
        userMediaCount,
        eventCount,
        linkedMediaPostCount,
        linkedMediasPostCount,
        total: userMediaCount + eventCount + linkedMediaPostCount + linkedMediasPostCount,
    };
}

async function processGroup(group, options) {
    const normalizedName = group._id.normalized_name;
    const groupKey = buildGroupKey(normalizedName);

    const items = await UniqueMedia.find({
        type: TARGET_TYPE,
        normalized_name: normalizedName,
    })
        .sort({ updatedAt: -1 })
        .lean();

    const canonicalItems = items.filter((item) => normalizeSource(item.source) === CANONICAL_SOURCE);
    if (canonicalItems.length !== 1) {
        const reason =
            canonicalItems.length === 0
                ? "no TMDB survivor in group"
                : "multiple TMDB survivors in group";
        return {
            status: "skipped",
            groupKey,
            reason,
            details: {
                displayName: group.display_name,
                itemCount: items.length,
                tmdbCount: canonicalItems.length,
            },
            stats: emptyGroupStats(),
        };
    }

    const survivor = canonicalItems[0];
    const duplicates = items.filter((item) => toIdString(item._id) !== toIdString(survivor._id));
    if (duplicates.length === 0) {
        return {
            status: "skipped",
            groupKey,
            reason: "group only contains the survivor after reload",
            details: {
                displayName: group.display_name,
                itemCount: items.length,
                tmdbCount: canonicalItems.length,
            },
            stats: emptyGroupStats(),
        };
    }

    const stats = emptyGroupStats();

    console.log(
        `${options.apply ? "[apply]" : "[dry-run]"} ${groupKey} -> keeping TMDB ${toIdString(survivor._id)} (${survivor.name})`
    );

    for (const duplicate of duplicates) {
        const duplicateStats = await migrateDuplicateReferences(duplicate, survivor, options);
        addGroupStats(stats, duplicateStats);
    }

    if (!options.apply) {
        return {
            status: "eligible",
            groupKey,
            stats,
            survivor: {
                _id: toIdString(survivor._id),
                source: survivor.source || "",
                media_id: survivor.media_id || "",
                name: survivor.name || "",
            },
            duplicates: duplicates.map((duplicate) => ({
                _id: toIdString(duplicate._id),
                source: duplicate.source || "",
                media_id: duplicate.media_id || "",
                name: duplicate.name || "",
            })),
        };
    }

    const duplicateIds = duplicates.map((duplicate) => duplicate._id);
    const remainingReferences = await countRemainingReferences(duplicateIds);
    if (remainingReferences.total > 0) {
        throw new Error(`Verification failed for ${groupKey}: ${JSON.stringify(remainingReferences)}`);
    }

    const deleteResult = await UniqueMedia.deleteMany({ _id: { $in: duplicateIds } });
    stats.duplicateRowsDeleted = deleteResult.deletedCount || 0;

    return {
        status: "collapsed",
        groupKey,
        stats,
        survivor: {
            _id: toIdString(survivor._id),
            source: survivor.source || "",
            media_id: survivor.media_id || "",
            name: survivor.name || "",
        },
        duplicates: duplicates.map((duplicate) => ({
            _id: toIdString(duplicate._id),
            source: duplicate.source || "",
            media_id: duplicate.media_id || "",
            name: duplicate.name || "",
        })),
    };
}

async function run() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        printUsage();
        return;
    }

    if (!process.env.MONGO_URI) {
        throw new Error("MONGO_URI is required.");
    }

    await mongoose.connect(process.env.MONGO_URI);

    const summary = createSummary(options);

    try {
        const groups = await UniqueMedia.aggregate(buildGroupPipeline(options));
        summary.groupsScanned = groups.length;

        console.log(
            `${options.apply ? "Applying" : "Dry-run only"} collapse for ${groups.length} duplicate movie group(s).`
        );

        for (const group of groups) {
            try {
                const result = await processGroup(group, options);
                addGroupStats(summary, result.stats);

                if (result.status === "eligible") {
                    summary.groupsEligible += 1;
                    continue;
                }
                if (result.status === "collapsed") {
                    summary.groupsEligible += 1;
                    summary.groupsCollapsed += 1;
                    continue;
                }

                summary.groupsSkipped += 1;
                summary.skippedGroups.push({
                    groupKey: result.groupKey,
                    reason: result.reason,
                    ...result.details,
                });
                console.log(`[skip] ${result.groupKey}: ${result.reason}`);
            } catch (error) {
                const groupKey = buildGroupKey(group._id.normalized_name);
                summary.groupsErrored += 1;
                summary.erroredGroups.push({
                    groupKey,
                    error: error.message,
                });
                console.error(`[error] ${groupKey}: ${error.message}`);
            }
        }
    } finally {
        await mongoose.disconnect();
    }

    console.log("");
    if (!options.apply) {
        console.log("Dry run complete. Counts below reflect matched records; no writes were made.");
    }
    console.log(JSON.stringify(summary, null, 2));

    if (summary.groupsErrored > 0) {
        process.exitCode = 1;
    }
}

run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
